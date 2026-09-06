"use strict";
var got = require("got");
var CryptoJS = require("crypto-js");
var HTMLParser = require("node-html-parser");
var pollingtoevent = require("polling-to-event");
const util = require("util");

var self;

let Service, Characteristic;

var protocol = "http";
var apibasepath = "/system_http_api/API_REV01";
var hPath = "API_REV01";

let CurrentState = 3;
let TargetState = 3;
let lastTargetState = 3;
let lastValidCurrentState = 3;
var api_key_enc;
var api_iv_enc;

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
  "Not available"     : 5, // At certain times, tuxedo API returns a Not available value with a successful API response, not sure why this is, set accessory to general fault when this happens
  "Error"             : 5, // Tuxedo api can be temperamental at times, when the API call fails, we set the accessory to general fault.
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
  self = this;
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
  this.protocol = config.protocol;

  if (!config.alarmCode) {
    this.log("Alarm code is missing from config");
  }
  this.uCode = config.alarmCode;

  (async () => {
    await getAPIKeys.call(this);
    this.init();
  })();

  // create a new Security System service
  this.SecuritySystem = new Service.SecuritySystem(this.name);

  // create handlers for required characteristics
  this.SecuritySystem.getCharacteristic(
    Characteristic.SecuritySystemCurrentState
  ).on("get", this.handleSecuritySystemCurrentStateGet.bind(this));

  this.SecuritySystem.getCharacteristic(
    Characteristic.SecuritySystemTargetState
  )
    .on("get", this.handleSecuritySystemTargetStateGet.bind(this))
    .on("set", this.handleSecuritySystemTargetStateSet.bind(this));

  if (this.debug) this.log("Service creation complete");
}

HoneywellTuxedoAccessory.prototype = {
  /**
   * Init method for regular polling of device state, fired after the api keys have been retrieved
   */
  init: function () {

    // Set up continuous polling if configured
    if (self.debug) self.log("[init] Polling is set to : " + self.polling);
    if (self.polling) {
      self.log("Starting polling with an interval of %s ms", self.pollInterval);

      var emitterConfig = [
        {
          method: self.handleSecuritySystemCurrentStateGet.bind(this),
          property: "current state",
          characteristic: Characteristic.SecuritySystemCurrentState,
        },
        {
          method: self.handleSecuritySystemTargetStateGet.bind(this),
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
          if(state !== 5){
              self.log(
              "Polling noticed %s change to %s, notifying devices",
              config.property,
              state
              );
            if (config.property === "target state") {
              if(state === 4){
                // Homekit doesn't accept a triggered value for target state, hence set the targetstate to last known target state
                if(self.debug) self.log("Received target state 4, setting target state to lastTargetState: " + self.lastTargetState);
                  self.SecuritySystem.getCharacteristic(config.characteristic).updateValue(self.lastTargetState);
                }else{
                  self.lastTargetState = state;
                  self.SecuritySystem.getCharacteristic(config.characteristic).updateValue(state);
                }
            } else {
              self.SecuritySystem.getCharacteristic(config.characteristic).updateValue(state);
            }
            // Set Statusfault characteristic to no fault
            self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).updateValue(0)
          } else {
            // When state is 5, an error has been encountered, most common causes are unit not reachable due to internet issues or returning state as not available
            // Set Statusfault characteristic to General Fault
            self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).updateValue(1)
            self.log("Security system state unavailable, setting state to fault")
          }
        }
          );

        emitter.on("error", function (err) {
          self.log("Polling of %s failed, error was %s", config.property, err);
          // Set Statusfault characteristic to General Fault
          self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).updateValue(1)
        });
      });
    }
    // Fetch API keys every 1.5 mins
    // This is to work around a bug in many VAM units which periodically starts returning the wrong status
    // until some page is fecthed in a browser
    function tuxedoApiStateHack() {
      if(this.debug) this.log("[tuxedoApiStateHack] Re-fetching home page");
      (async () => {
        getAPIKeys.bind(this);
      })();
    }
    setInterval(tuxedoApiStateHack,90000);
  },
  getServices: function () {
    if (this.debug) this.log("Get Services called");
    if (!this.SecuritySystem) return [];

    const infoService = new Service.AccessoryInformation();
    infoService.setCharacteristic(
      Characteristic.Manufacturer,
      "Honeywell-Tuxedo"
    );

    return [infoService, this.SecuritySystem];
  },
  /**
   * Handle requests to get the current value of the "Security System Current State" characteristic
   */
  handleSecuritySystemCurrentStateGet: function (callback) {
    if (this.debug) this.log("[handleSecuritySystemCurrentStateGet] Triggered GET SecuritySystemCurrentState");

    getAlarmMode.apply(this, [returnCurrentState.bind(this)]);

    function returnCurrentState(value) {
      var statusString = JSON.parse(value).Status.toString().trim();
      if (this.debug)
        this.log(
          "[returnCurrentState] Retrieved status string: " +
            statusString +
            ", alarmStatus is: " +
            alarmStatus[statusString]
        );
      CurrentState =
        alarmStatus[statusString] === undefined ? 3 : alarmStatus[statusString];
      
        // If we find a state that isn't defined in alarm status and it isn't a arming / delay state, report in the log
        if ((alarmStatus[statusString] === undefined) && (statusString.indexOf("Secs Remaining") === -1)) {
          self.log(
            "[handleSecuritySystemCurrentStateGet] Unknown alarm state: " +
              statusString +
              " please report this through a github issue to the developer"
          );
        }

      if (self.debug)
        self.log(
          "[returnCurrentState] Received value: " +
            value +
            ", corresponding current state: " +
            CurrentState
        );
      if (CurrentState !== 5){
        this.lastValidCurrentState = CurrentState;
      }else{
        CurrentState = this.lastValidCurrentState;
        if(self.debug) self.log("[handleSecuritySystemCurrentStateGet] Current state was Not available / error, returning the last known good state: " + this.lastValidCurrentState);
      }
      callback(null, CurrentState);
    }
  },

  /**
   * Handle requests to get the current value of the "Security System Target State" characteristic
   */
  handleSecuritySystemTargetStateGet: function (callback) {
    if (this.debug) this.log("Triggered GET SecuritySystemTargetState");

    getAlarmMode.apply(this, [returnTargetState.bind(this)]);

    function returnTargetState(value) {
      var statusString = JSON.parse(value).Status.toString().trim();

      if (statusString.indexOf("Secs Remaining") !== -1) {
        TargetState = this.lastTargetState;
      } else {
        TargetState =
          alarmStatus[statusString] === undefined
            ? 3
            : alarmStatus[statusString];
        // Homekit doesn't accept a targetState of 4 (triggered), when triggered, return lastTargetState
        if((TargetState === 4) || (TargetState === 5)) TargetState = this.lastTargetState;
        if(self.debug) self.log("[handleSecuritySystemTargetStateGet] Target state was: " + TargetState + " returning lastTargetState: " + this.lastTargetState);
      }

      if (
        (alarmStatus[statusString] === undefined) && 
        (statusString.indexOf("Secs Remaining") === -1)
      ) {
        self.log(
          "[handleSecuritySystemTargetStateGet] Unknown alarm state: " +
            statusString +
            " please report this through a github issue to the developer"
        );
      }

      if (self.debug)
        self.log(
          "[returnTargetState] Received value: " +
            value +
            ", corresponding target state: " +
            TargetState
        );

      callback(null, TargetState);
    }
  },

  /**
   * Handle requests to set the "Security System Target State" characteristic
   */
  handleSecuritySystemTargetStateSet: function (value, callback) {
    if (this.debug)
      this.log("[handleSecuritySystemTargetStateGet] Triggered SET SecuritySystemTargetState:" + value);

    if (this.fetchKeysBeforeEverySetCall){
      if(this.debug) this.log("[handleSecuritySystemCurrentStateGet] fetchKeysBeforeEverySetCall config is true, fetching API keys again");
      (async () => {
        await getAPIKeys.bind(this);
      })();
    }

    TargetState = value;
    //Capture the last target state if it isn't disarmed
    if(value !== 3)
    	this.lastTargetState = value;
    if (value === 0) armAlarm.apply(this, ["STAY", callback]);
    if (value === 1) armAlarm.apply(this, ["AWAY", callback]);
    if (value === 2) armAlarm.apply(this, ["NIGHT", callback]);
    if (value === 3) disarmAlarm.apply(this, [callback]);
  },
};

// Not actually a POST on VAM, just GET with query params
async function callAPI_POST(url, data, callback) {
  const options = {
    method: "GET",
    url: url + "?" + data
  };
  if (this.debug)
    this.log(
      "[callAPI_POST]: Calling alarm API with url: " +
        options.url
    );

  try {
    var response = await got.get(options);
    // Remove disclaimer HTML added by VAM
    var respTrimmed = response.body.substring(0, response.body.lastIndexOf("}") + 1);

    this.log('[callAPI_POST]: Response: ' + respTrimmed);

    // return data 
    callback(respTrimmed);
    
  } catch (error) {
    if (this.debug) {
      this.log("[callAPI_POST] Error:", error);
    } else {
      this.log("[callAPI_POST] Error:" + error.message);
      callback('{"Status":"Error"}'); //Return an error state, this is mapped to an invalid state 5 in the alarmStatus dict
    }
  }
}

function getAlarmMode(callback) {
  var url = protocol + "://" + this.host;
  if (this.port !== "") url += ":" + this.port;
  url += apibasepath + "/GetSecurityStatus";

  if (this.debug)
    this.log(
      "[getAlarmMode] About to call with, url: " +
        url
    );
  callAPI_POST.apply(this, [
    url,
    "",
    callback,
  ]);
}

function armAlarm(mode, callback) {
  var pID = 1;
  var queryString =
    "arming=" + mode + "&pID=" + pID + "&ucode=" +
      parseInt(this.uCode) +
      "&operation=set";
  var url = protocol + "://" + this.host;
  if (this.port !== "") url += ":" + this.port;
  url += apibasepath + "/AdvancedSecurity/ArmWithCode"; //?param=" + encryptData(dataCnt);

  if (this.debug)
    this.log(
      "[armAlarm] About to call API with, url:" +
        url +
        " queryString: " +
        queryString
    );
  callAPI_POST.apply(this, [
    url,
    queryString,
    finishArming,
  ]);

  function finishArming() {
    callback(null);
  }
}

// VAM does not support DisarmWithCode API but can call the backend API used by the VAM's web interface. It does not have a JSON response
function disarmAlarm(callback) {
  var pID = 1;
  var queryString = "cmd=3&Type=3&pID=" + pID + "&uCode=" + parseInt(this.uCode);
  var url = protocol + "://" + this.host;
  if (this.port !== "") url += ":" + this.port;
  url += "/handlerequest.html";

  if (this.debug)
    this.log(
      "[disarmAlarm] About to call API with, url:" +
        url +
        " queryString: " +
        queryString
    );
  callAPI_POST.apply(this, [
    url,
    queryString,
    finishDisarming,
  ]);

  function finishDisarming(value) {
    callback(null);
  }
}

// Get API Keys from the tuxedo unit
// Create an API request with the cookie jar turned on

async function getAPIKeys() {

  this.log("[getAPIKeys] getAPIKeys called");
  try {
    var tuxApiUrl = protocol + "://" + this.host;
    if (this.port) tuxApiUrl += ":" + this.port;
    tuxApiUrl += "/home.html";

    const options = {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36",
      },
      https: {
        rejectUnauthorized: false,
      },
    };

    if (this.debug) this.log("About to call, URL: " + tuxApiUrl);
    if (this.debug)
      this.log("Options: " + util.inspect(options, false, null, true));

    // Calling this seems sufficient to keep the status fresh, we don't need the result
    var response = await got(tuxApiUrl, options);

  } catch (error) {
    if (error.code === "EPROTO") {
      this.log(
        "[getAPIKeys] This likely an issue with strict openSSL configuration, see: https://github.com/lockpicker/homebridge-honeywell-tuxedo-touch/issues/1"
      );
    } else {
      this.log("[getAPIKeys] Error retrieving keys from the tuxedo unit. Please ensure 'Authentication for web server local access' is disabled on the tuxedo unit. Will retry in 3 mins.");

      if (this.debug) this.log(error);
    }
    // On error, retry in some time
    // setTimeout(() => {
    //   getAPIKeys.call(this);
    // }, 90000);
  }
}
