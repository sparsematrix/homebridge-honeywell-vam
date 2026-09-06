"use strict";
var got = require("got");
var pollingtoevent = require("polling-to-event");
const util = require("util");

let Service, Characteristic;

var apibasepath = "/system_http_api/API_REV01";

var alarmStatus = {
  "Armed Stay"        : 0,
  "Armed Stay Fault"  : 0,
  "Armed Away"        : 1,
  "Armed Away Fault"  : 1,
  "Armed Night"       : 2,
  "Armed Instant"     : 2,
  "Armed Instant Fault": 2,
  "Armed Night Fault" : 2,
  "Ready Fault"       : 3,
  "Ready To Arm"      : 3,
  "Not Ready"         : 3,
  "Not Ready Fault"   : 3,
  "Entry Delay Active": 4,
  "Not Ready Alarm"   : 4,
  "Armed Stay Alarm"  : 4,
  "Armed Night Alarm" : 4,
  "Armed Away Alarm"  : 4,
  "Not available"     : 5, // At certain times the API returns "Not available" with a successful response; treat as general fault.
  "Error"             : 5, // The API can be temperamental; when a call fails we map it to this general-fault state.
};

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory(
    "homebridge-honeywell-vam",
    "Honeywell Tuxedo Touch",
    HoneywellTuxedoAccessory
  );
};

function HoneywellTuxedoAccessory(log, config) {
  this.log = log;
  this.config = config;
  this.debug = config.debug || false;
  this.fetchKeysBeforeEverySetCall = config.fetchKeysBeforeEverySetCall || false;
  this.polling = config.polling || false;
  this.pollInterval = config.pollInterval || 30000;

  // extract name from config
  this.name = config.name || "Honeywell Security";

  this.host = config.host;
  this.port = config.port || "";
  this.protocol = config.protocol || "http";

  if (!config.alarmCode) {
    this.log("Alarm code is missing from config");
  }
  // Keep the code as a string - parseInt() would drop a leading zero (e.g. "0123")
  this.uCode = config.alarmCode === undefined ? "" : String(config.alarmCode);

  // Last states we can safely report back to HomeKit
  this.lastTargetState = 3;
  this.lastValidCurrentState = 3;

  (async () => {
    await getAPIKeys.call(this);
    this.init();
  })();

  // create a new Security System service
  this.SecuritySystem = new Service.SecuritySystem(this.name);

  // create handlers for required characteristics
  this.SecuritySystem.getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .on("get", this.handleSecuritySystemCurrentStateGet.bind(this));

  this.SecuritySystem.getCharacteristic(Characteristic.SecuritySystemTargetState)
    .on("get", this.handleSecuritySystemTargetStateGet.bind(this))
    .on("set", this.handleSecuritySystemTargetStateSet.bind(this));

  if (this.debug) this.log("Service creation complete");
}

HoneywellTuxedoAccessory.prototype = {
  /**
   * Init method for regular polling of device state, fired after the api keys have been retrieved
   */
  init: function () {
    var self = this;

    // Set up continuous polling if configured
    if (self.debug) self.log("[init] Polling is set to : " + self.polling);
    if (self.polling) {
      self.log("Starting polling with an interval of %s ms", self.pollInterval);

      var emitterConfig = [
        {
          method: self.handleSecuritySystemCurrentStateGet.bind(self),
          property: "current state",
          characteristic: Characteristic.SecuritySystemCurrentState,
        },
        {
          method: self.handleSecuritySystemTargetStateGet.bind(self),
          property: "target state",
          characteristic: Characteristic.SecuritySystemTargetState,
        },
      ];

      emitterConfig.forEach((config) => {
        var emitter = pollingtoevent(
          function (done) {
            config.method(function (err, result) {
              done(err, result);
            });
          },
          { longpolling: true, interval: self.pollInterval }
        );

        emitter.on("longpoll", function (state) {
          if (state !== 5) {
            self.log(
              "Polling noticed %s change to %s, notifying devices",
              config.property,
              state
            );
            if (config.property === "target state") {
              if (state === 4) {
                // Homekit doesn't accept a triggered value for target state, hence set the targetstate to last known target state
                if (self.debug) self.log("Received target state 4, setting target state to lastTargetState: " + self.lastTargetState);
                self.SecuritySystem.getCharacteristic(config.characteristic).updateValue(self.lastTargetState);
              } else {
                self.lastTargetState = state;
                self.SecuritySystem.getCharacteristic(config.characteristic).updateValue(state);
              }
            } else {
              self.SecuritySystem.getCharacteristic(config.characteristic).updateValue(state);
            }
            // Set Statusfault characteristic to no fault
            self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).updateValue(0);
          } else {
            // When state is 5, an error has been encountered, most common causes are unit not reachable due to internet issues or returning state as not available
            // Set Statusfault characteristic to General Fault
            self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).updateValue(1);
            self.log("Security system state unavailable, setting state to fault");
          }
        });

        emitter.on("error", function (err) {
          self.log("Polling of %s failed, error was %s", config.property, err);
          // Set Statusfault characteristic to General Fault
          self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).updateValue(1);
        });
      });
    }

    // Periodically re-fetch the VAM home page. Many VAM units otherwise start
    // returning stale status until some page is fetched in a browser.
    setInterval(function () {
      if (self.debug) self.log("[tuxedoApiStateHack] Re-fetching home page");
      getAPIKeys.call(self);
    }, 90000);
  },

  getServices: function () {
    if (this.debug) this.log("Get Services called");
    if (!this.SecuritySystem) return [];

    const infoService = new Service.AccessoryInformation();
    infoService.setCharacteristic(Characteristic.Manufacturer, "Honeywell-Tuxedo");

    return [infoService, this.SecuritySystem];
  },

  /**
   * Handle requests to get the current value of the "Security System Current State" characteristic
   */
  handleSecuritySystemCurrentStateGet: function (callback) {
    if (this.debug) this.log("[handleSecuritySystemCurrentStateGet] Triggered GET SecuritySystemCurrentState");

    getAlarmMode.apply(this, [returnCurrentState.bind(this)]);

    function returnCurrentState(value) {
      var statusString = parseStatusString.call(this, value, "returnCurrentState");

      if (this.debug)
        this.log(
          "[returnCurrentState] Retrieved status string: " + statusString +
          ", alarmStatus is: " + alarmStatus[statusString]
        );

      var currentState = alarmStatus[statusString] === undefined ? 3 : alarmStatus[statusString];

      // If we find a state that isn't defined in alarm status and it isn't an arming / delay state, report it
      if ((alarmStatus[statusString] === undefined) && (statusString.indexOf("Secs Remaining") === -1)) {
        this.log(
          "[handleSecuritySystemCurrentStateGet] Unknown alarm state: " + statusString +
          " please report this through a github issue to the developer"
        );
      }

      if (this.debug)
        this.log("[returnCurrentState] Received value: " + value + ", corresponding current state: " + currentState);

      if (currentState !== 5) {
        this.lastValidCurrentState = currentState;
      } else {
        currentState = this.lastValidCurrentState;
        if (this.debug) this.log("[handleSecuritySystemCurrentStateGet] Current state was Not available / error, returning the last known good state: " + this.lastValidCurrentState);
      }
      callback(null, currentState);
    }
  },

  /**
   * Handle requests to get the current value of the "Security System Target State" characteristic
   */
  handleSecuritySystemTargetStateGet: function (callback) {
    if (this.debug) this.log("[handleSecuritySystemTargetStateGet] Triggered GET SecuritySystemTargetState");

    getAlarmMode.apply(this, [returnTargetState.bind(this)]);

    function returnTargetState(value) {
      var statusString = parseStatusString.call(this, value, "returnTargetState");

      var targetState;
      if (statusString.indexOf("Secs Remaining") !== -1) {
        targetState = this.lastTargetState;
      } else {
        targetState = alarmStatus[statusString] === undefined ? 3 : alarmStatus[statusString];
        // Homekit doesn't accept a targetState of 4 (triggered) or our internal 5 (error); fall back to last known target
        if ((targetState === 4) || (targetState === 5)) targetState = this.lastTargetState;
        if (this.debug) this.log("[handleSecuritySystemTargetStateGet] Target state resolved to: " + targetState + " (lastTargetState: " + this.lastTargetState + ")");
      }

      if ((alarmStatus[statusString] === undefined) && (statusString.indexOf("Secs Remaining") === -1)) {
        this.log(
          "[handleSecuritySystemTargetStateGet] Unknown alarm state: " + statusString +
          " please report this through a github issue to the developer"
        );
      }

      if (this.debug)
        this.log("[returnTargetState] Received value: " + value + ", corresponding target state: " + targetState);

      callback(null, targetState);
    }
  },

  /**
   * Handle requests to set the "Security System Target State" characteristic
   */
  handleSecuritySystemTargetStateSet: async function (value, callback) {
    try {
      if (this.debug)
        this.log("[handleSecuritySystemTargetStateSet] Triggered SET SecuritySystemTargetState: " + value);

      if (this.fetchKeysBeforeEverySetCall) {
        if (this.debug) this.log("[handleSecuritySystemTargetStateSet] fetchKeysBeforeEverySetCall is true, refreshing API keys");
        await getAPIKeys.call(this);
      }

      // Capture the last target state if it isn't disarmed
      if (value !== 3) this.lastTargetState = value;

      if (value === 0) armAlarm.apply(this, ["STAY", callback]);
      else if (value === 1) armAlarm.apply(this, ["AWAY", callback]);
      else if (value === 2) armAlarm.apply(this, ["NIGHT", callback]);
      else if (value === 3) disarmAlarm.apply(this, [callback]);
      else callback(null);
    } catch (err) {
      this.log("[handleSecuritySystemTargetStateSet] Error: " + err.message);
      callback(err);
    }
  },
};

// Parse the "{...}" status blob returned by the VAM. Returns a trimmed Status
// string, or "Error" (mapped to state 5) if the response can't be parsed.
function parseStatusString(value, tag) {
  try {
    return JSON.parse(value).Status.toString().trim();
  } catch (e) {
    this.log("[" + tag + "] Could not parse status response, treating as error. Raw value: " + value);
    return "Error";
  }
}

function buildBaseUrl(ctx) {
  var url = (ctx.protocol || "http") + "://" + ctx.host;
  if (ctx.port !== "" && ctx.port !== undefined && ctx.port !== null) url += ":" + ctx.port;
  return url;
}

// Not actually a POST on VAM, just a GET with query params
async function callAPI_POST(url, data, callback) {
  const options = {
    method: "GET",
    url: data ? url + "?" + data : url,
    https: { rejectUnauthorized: false },
  };
  if (this.debug)
    this.log("[callAPI_POST]: Calling alarm API with url: " + options.url);

  try {
    var response = await got.get(options);
    // Remove disclaimer HTML added by VAM
    var respTrimmed = response.body.substring(0, response.body.lastIndexOf("}") + 1);

    if (this.debug) this.log("[callAPI_POST]: Response: " + respTrimmed);

    // return data
    callback(respTrimmed);
  } catch (error) {
    if (this.debug) {
      this.log("[callAPI_POST] Error:", error);
    } else {
      this.log("[callAPI_POST] Error: " + error.message);
    }
    // Return an error state, mapped to invalid state 5 in the alarmStatus dict
    callback('{"Status":"Error"}');
  }
}

function getAlarmMode(callback) {
  var url = buildBaseUrl(this) + apibasepath + "/GetSecurityStatus";

  if (this.debug) this.log("[getAlarmMode] About to call with, url: " + url);
  callAPI_POST.apply(this, [url, "", callback]);
}

function armAlarm(mode, callback) {
  var self = this;
  var pID = 1;
  var queryString =
    "arming=" + encodeURIComponent(mode) +
    "&pID=" + pID +
    "&ucode=" + encodeURIComponent(this.uCode) +
    "&operation=set";
  var url = buildBaseUrl(this) + apibasepath + "/AdvancedSecurity/ArmWithCode";

  if (this.debug)
    this.log("[armAlarm] About to call API with, url:" + url + " queryString: " + queryString);
  callAPI_POST.apply(this, [url, queryString, finishArming]);

  function finishArming(value) {
    if (self.debug) self.log("[armAlarm] Arm response: " + value);
    callback(null);
  }
}

// VAM does not support the DisarmWithCode API but can call the backend API used by the VAM's web interface. It does not have a JSON response.
function disarmAlarm(callback) {
  var self = this;
  var pID = 1;
  var queryString = "cmd=3&Type=3&pID=" + pID + "&uCode=" + encodeURIComponent(this.uCode);
  var url = buildBaseUrl(this) + "/handlerequest.html";

  if (this.debug)
    this.log("[disarmAlarm] About to call API with, url:" + url + " queryString: " + queryString);
  callAPI_POST.apply(this, [url, queryString, finishDisarming]);

  function finishDisarming(value) {
    if (self.debug) self.log("[disarmAlarm] Disarm response: " + value);
    callback(null);
  }
}

// Fetch the VAM home page. Calling this keeps the unit's status API from going
// stale - a known VAM firmware quirk where status freezes until a page is loaded.
async function getAPIKeys() {
  if (this.debug) this.log("[getAPIKeys] getAPIKeys called");
  try {
    var tuxApiUrl = buildBaseUrl(this) + "/home.html";

    const options = {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36",
      },
      https: {
        rejectUnauthorized: false,
      },
    };

    if (this.debug) this.log("[getAPIKeys] About to call, URL: " + tuxApiUrl);
    if (this.debug) this.log("[getAPIKeys] Options: " + util.inspect(options, false, null, true));

    // Calling this seems sufficient to keep the status fresh, we don't need the result
    await got(tuxApiUrl, options);
  } catch (error) {
    if (error.code === "EPROTO") {
      this.log("[getAPIKeys] This is likely an issue with strict openSSL configuration, see: https://github.com/lockpicker/homebridge-honeywell-tuxedo-touch/issues/1");
    } else {
      this.log("[getAPIKeys] Error retrieving keys from the tuxedo unit. Please ensure 'Authentication for web server local access' is disabled on the tuxedo unit. Will retry in 90s.");
      if (this.debug) this.log(error);
    }
  }
}
