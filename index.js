// Plugin to provide a leak alarm via HomeKit
// Copyright (c) James Pearce, 2024
// Last updated January 2024
//
// Version 1:
// Supports a simple (e.g. Arduino based) connected sensor that reports via a static IP the status of one or two SHT sensors. The sensor reporting format required is bare CSV (no header row) as follows:
//
// [Device],[DeviceNo],[DeviceLocation],[DeviceLocation],[DeviceTempReading1],[DeviceTempReading2],[DeviceTempReading3],[DeviceHumidityReading1],[DeviceHumidityReading2],[DeviceHumidityReading3]
//
// e.g. SHT,1,Soil Stack,Detected,22.2,22.2,22.3,51.7%,51.7%,51.6%
//
// note: reading 1 is most recent (i.e., the readings are expected to move right)
//
// Leaks are detected when the reported relative humity crosses the configured Alert Threshold for all three readings. The reading frequency is defined in the sensor. Therefore, this solution is sutable for interior use in heated spaces only.
//
// The sensor is organised in HomeKit as two Leak Sensors, each also containing a Temperature and Humity sensor.


// HomeKit API registration
module.exports = (api) => {
  api.registerAccessory('LeakAlarm', LeakAlarm);
};



  // ----  CSV handling function ----

  function CSVToArray( strData, strDelimiter ) {
    // Check to see if the delimiter is defined. If not,
    // then default to comma.
    strDelimiter = (strDelimiter || ",");

    // Create a regular expression to parse the CSV values.
    var objPattern = new RegExp(
      (
        // Delimiters.
        "(\\" + strDelimiter + "|\\r?\\n|\\r|^)" +

        // Quoted fields.
        "(?:\"([^\"]*(?:\"\"[^\"]*)*)\"|" +

        // Standard fields.
        "([^\"\\" + strDelimiter + "\\r\\n]*))"
      ),
      "gi"
      );

    // Create an array to hold our data. Give the array
    // a default empty first row.
    var arrData = [[]];

    // Create an array to hold our individual pattern
    // matching groups.
    var arrMatches = null;
    var strMatchedValue = null;;

    // Keep looping over the regular expression matches
    // until we can no longer find a match.
    while (arrMatches = objPattern.exec( strData )) {
      // Get the delimiter that was found.
      var strMatchedDelimiter = arrMatches[ 1 ];

      // Check to see if the given delimiter has a length
      // (is not the start of string) and if it matches
      // field delimiter. If id does not, then we know
      // that this delimiter is a row delimiter.
      if ( strMatchedDelimiter.length && (strMatchedDelimiter != strDelimiter) ) {
        // Since we have reached a new row of data,
        // add an empty row to our data array.
        arrData.push( [] );
      }

      // Now that we have our delimiter out of the way,
      // let's check to see which kind of value we
      // captured (quoted or unquoted).
      if (arrMatches[ 2 ]) {
        // We found a quoted value. When we capture
        // this value, unescape any double quotes.
        strMatchedValue = arrMatches[ 2 ].replace(
          new RegExp( "\"\"", "g" ),
          "\""
          );
      } else {
        // We found a non-quoted value.
        strMatchedValue = arrMatches[ 3 ];
      }

      // Now that we have our value string, let's add
      // it to the data array.
      arrData[ arrData.length - 1 ].push( strMatchedValue );
    }

    // Return the parsed data.
    return( arrData );
  }


class LeakAlarm {

  constructor(log, config, api) {
      this.log = log;
      this.config = config;
      this.api = api;

      this.Service = this.api.hap.Service;
      this.Characteristic = this.api.hap.Characteristic;

      this.name            = config.name            || 'Leak Alarm';
      this.model           = config.model           || 'Dual Sensor';
      this.IpAddress       = config.IpAddress;
      this.pollTimer       = config.pollTimer       || 30; //default poll interval = 30 seconds
      this.alertThreshold  = config.alertThreshold  || 90; //default alert at 90% relative humidity
      this.sensor1Location = config.sensor1Location || 'Sensor 1';
      this.sensor2Location = config.sensor2Location || 'Sensor 2';

      this.state = {
        AlertState:        0,
        sensor1State:      0,
        sensor1Temp:       0,
        sensor2Humid:      0,
        sensor2Temp:       0,
        sensor1Humid:      0,
      };

      // Create the services
      this.leakSensor          = new this.Service.LeakSensor(this.name);
      this.tempSensor1Service  = new this.Service.TemperatureSensor(this.sensor1Location);
      this.humidSensor1Service = new this.Service.HumiditySensor(this.sensor1Location);
      this.tempSensor2Service  = new this.Service.TemperatureSensor(this.sensor2Location);
      this.humidSensor2Service = new this.Service.HumiditySensor(this.sensor2Location);

      // IOS 16 and above over-writes the descriptive names set against the accesories
      // The following restores them to display as previously (e.g., on IOS 15)
      this.leakSensor.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.leakSensor.setCharacteristic(this.Characteristic.ConfiguredName, this.name);

      this.tempSensor1Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.tempSensor1Service.setCharacteristic(this.Characteristic.ConfiguredName, 'SHT1 Temperature');

      this.humidSensor1Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.humidSensor1Service.setCharacteristic(this.Characteristic.ConfiguredName, 'SHT1 Humidity');

      this.tempSensor2Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.tempSensor2Service.setCharacteristic(this.Characteristic.ConfiguredName, 'SHT2 Temperature');

      this.humidSensor2Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.humidSensor2Service.setCharacteristic(this.Characteristic.ConfiguredName, 'SHT2 Humidity');

      // create an information service...
      this.informationService = new this.Service.AccessoryInformation()
        .setCharacteristic(this.Characteristic.Manufacturer, "Lo-tech")
        .setCharacteristic(this.Characteristic.Model, this.model);

      this.leakSensor
        .getCharacteristic(this.Characteristic.LeakDetected)
        .on('get', this.getState.bind(this));

      this.tempSensor1Service
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .on('get', this.getTemp1.bind(this));
      this.humidSensor1Service
        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
        .on('get', this.getHumid1.bind(this));
      this.tempSensor2Service
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .on('get', this.getTemp1.bind(this));
      this.humidSensor2Service
        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
        .on('get', this.getHumid1.bind(this));

  } // constructor

  // mandatory getServices function tells HomeBridge how to use this object
  getServices() {
    var accessory = this;
    var Characteristic = this.Characteristic;
    accessory.log.debug(accessory.name + ': Invoked getServices');

    // enquire state from device
    var page = require('webpage').create(),
    system   = require('system'), address;

    address = this.IpAddress;
    page.open(address, function(status) {
      if (status !== 'success') {
        accessory.log('Could not connect to configured device (' + this.IpAddress + ')');
      } else {
        accessory.log('Connected to device at ' + this.IpAddress);
      }
    });
    accessory.pollState(); // initialise plugin with discovered IP address

    // Retrun the services to HomeBridge
    return [
      accessory.informationService,
      accessory.leakSensor,
      accessory.tempSensor1Service,
      accessory.humidSensor1Service,
      accessory.tempSensor2Service,
      accessory.humidSensor2Service,
    ];
  } // getServices()/

  getState(callback) {
    var accessory = this;
    accessory.log.debug('Leak Sensor current state: ', accessory.state.AlertState);
    callback(null, accessory.state.AlertState);
  }

  getTemp1(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 1 current temperature reading: ', accessory.state.sensor1Temp);
    callback(null, accessory.state.sensor1Temp);
  }

  getHumid1(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 1 current humidity reading: ', accessory.state.sensor1Humid);
    callback(null, accessory.state.sensor1Humid);
  }

  getTemp2(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 2 current temperature reading: ', accessory.state.sensor2Temp);
    callback(null, accessory.state.sensor2Temp);
  }

  getHumid2(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 2 current humidity reading: ', accessory.state.sensor2Humid);
    callback(null, accessory.state.sensor2Humid);
  }


  // ----  Polling function follows  ----

  pollSensorState(callback) {
    // Background status polling function. Retrieves the state from the device and updates the
    // control variables accordingly.
    // Called by the timer function in pollState() below, which is trigged at plugin initialisation
    // initially.

    var accessory = this;
    var Characteristic = this.Characteristic;

    // enquire state from device
    var page = require('webpage').create(),
    system   = require('system'), address;
    var SensorData = [[]];

    address = this.IpAddress;
    page.open(address, function(status) {
      if (status !== 'success') {
        accessory.debug.log('Could not connect to configured device (' + this.IpAddress + ')');
      } else {
        accessory.log('Connected to device at ' + this.IpAddress);
        accessory.log(page.content);
        SensorData = CSVToArray(page.content,',' );
        accessory.log( SensorData );
        // Process the readings
        accessory.state.sensor1State = 0;
        accessory.state.sensor1Temp  = 0;
        accessory.state.sensor2Humid = 0;
        accessory.state.sensor2Temp  = 0;
        accessory.state.sensor1Humid = 0;
      }
    });

    accessory.log.debug("pollUpsState: Updating accessory state...");
    accessory.contactSensor.updateCharacteristic(Characteristic.ContactSensorState, accessory.state.contactSensorState);

    // update HomeBridge with all status of all elements
    accessory.log.debug("pollSensorState: Updating state...");
    accessory.outlet1Service.updateCharacteristic(Characteristic.On, accessory.state.outlet1On);
    accessory.outlet1Service.updateCharacteristic(Characteristic.OutletInUse, accessory.state.outlet1InUse);

    accessory.pollState(); // (re)start polling timer
  } // getState

  /**
    * Polling function
  */
  pollState = function() {
    var accessory = this;
    var Characteristic = this.Characteristic;

    // Clear any existing timer
    if (accessory.stateTimer) {
      clearTimeout(accessory.stateTimer);
      accessory.stateTimer = null;
    }

    // define the new poll function
    accessory.stateTimer = setTimeout(
      function() {
        accessory.pollSensorState(function(err, CurrentDeviceState) {
          if (err) {
            accessory.log(err);
            return;
          }
        });
      }, accessory.pollTimer * 1000
    );
  } // pollState

} // class LeakAlarm
