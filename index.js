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
// The sensor is organised in HomeKit as a Leak Sensor containing two Temperature and Humity sensors.


// status constants
const LEAK_NOT_DETECTED = 0;
const LEAK_DETECTED     = 1;
const NO_FAULT          = 0;
const GENERAL_FAULT     = 1;


// HomeKit API registration
module.exports = (api) => {
  api.registerAccessory('LeakAlarm', LeakAlarm);
};


/*
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
*/

class LeakAlarm {

  constructor(log, config, api) {
      this.log = log;
      this.config = config;
      this.api = api;

      this.Service = this.api.hap.Service;
      this.Characteristic = this.api.hap.Characteristic;

      this.name            = config.name            || 'Leak Alarm';
      this.model           = config.model           || 'Dual Sensor';
      this.serialNumber    = config.serialNumber    || '00-00-00-00';
      this.IpAddress       = config.IpAddress;
      this.pollTimer       = config.pollTimer       || 30; //default poll interval = 30 seconds
      this.alertThreshold  = config.alertThreshold  || 90; //default alert at 90% relative humidity
      this.sensor1Location = config.sensor1Location || 'Sensor 1';
      this.sensor2Location = config.sensor2Location || 'Sensor 2';

      this.state = {
        AlertState:        LEAK_NOT_DETECTED,   // LEAK_NOT_DETECTED or LEAK_DETECTED
        deviceState:       NO_FAULT,            // NO_FAULT or GENERAL_FAULT
        sensor1State:      NO_FAULT,            // NO_FAULT or GENERAL_FAULT
        sensor1Temp:       0.0,                 // Average of last 3 readings in °C
        sensor1Humid:      0.0,                 // Average of last 3 reading, RH%
        sensor2State:      NO_FAULT,            // NO_FAULT or GENERAL_FAULT
        sensor2Temp:       0.0,                 // Average of last 3 readings in °C
        sensor2Humid:      0.0                  // Average of last 3 reading, RH%
      };

      // Create the services
      this.leakSensor          = new this.Service.LeakSensor(this.name);
      this.tempSensor1Service  = new this.Service.TemperatureSensor(this.sensor1Location,'SHT1');
      this.humidSensor1Service = new this.Service.HumiditySensor(this.sensor1Location,'SHT1');
      this.tempSensor2Service  = new this.Service.TemperatureSensor(this.sensor2Location,'SHT2');
      this.humidSensor2Service = new this.Service.HumiditySensor(this.sensor2Location,'SHT2');

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
        .setCharacteristic(this.Characteristic.Manufacturer, "HomeBridge")
        .setCharacteristic(this.Characteristic.Model, this.model)
        .setCharacteristic(this.Characteristic.SerialNumber, this.serialNumber);

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
        .on('get', this.getTemp2.bind(this));
      this.humidSensor2Service
        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
        .on('get', this.getHumid2.bind(this));

  } // constructor

  // mandatory getServices function tells HomeBridge how to use this object
  getServices() {
    var accessory = this;
    var Characteristic = this.Characteristic;
    accessory.log.debug(accessory.name + ': Invoked getServices');

    // enquire state from device
    const page = require('http');

    page.get('http://' + this.IpAddress + '/', res => {
      accessory.log('Connected to device at ' + this.IpAddress);
    }).on('error', err => {
      accessory.log('Could not connect to configured device (' + this.IpAddress + ') - Error: ', err.message);
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
    const page = require('http');
    let rawData = '';

    page.get('http://' + this.IpAddress + '/', (res) => {
      accessory.log.debug('Connected to configured device (' + this.IpAddress + ')');
      const { statusCode } = res;
      const contentType = res.headers['content-type'];

      let error;
      // Assume success only on receipt of 200 status
      if (statusCode !== 200) {
        error = new Error('Request Failed.\n' + `Status Code: ${statusCode}`);
      }
      if (error) {
        accessory.log(error.message);
        // Consume response data to free up memory
        res.resume();
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          accessory.log.debug('Received data: ' + rawData);
        } catch (e) {
          accessory.log(`Exception: ${e.message}`);
        }
      });
    }).on('error', (e) => {
      accessory.log('Could not connect to configured device (' + this.IpAddress + ')');
      accessory.log(`Got error: ${e.message}`);
    });

    // allow 3 seconds for the above web request to success (or fail)
    setTimeout(() => {
    accessory.log.debug('Processing data: ' + rawData);
    // Hopefully we now have the appliance data stored in 'rawData' - attempt to process this
    rawData = rawData.trim();                     // remove white-space
    rawData = rawData.replace(/\r?\n|\r/g, ",");  // remove line breaks etc to provide one stream of data
    accessory.log.debug('Trimmed data: ' + rawData);
    const sensorData = rawData.split(",");
    var i = 0;
    var thisSensor = 0;

    do {
      if (sensorData[i++] == "SHT") {
        accessory.log.debug('Processing SHT Sensor data');
        if (sensorData[i] == "1") {
          accessory.log.debug('Processing SHT Sensor data for sensor 1');
          thisSensor = 1;
          i = i + 2; // advance array pointer
        } else if (sensorData[i] == "2") {
          accessory.log.debug('Processing SHT Sensor data for sensor 2');
          thisSensor = 2;
          i = i + 2; // advance array pointer
        }
        if (thisSensor > 0) {
          // We found "SHT",["1"|"2"],[]
          if (sensorData[i] == "Detected") {
            accessory.log.debug('SHT Sensor ' + thisSensor + ' status is normal');
            // sensor listed as "Detected" - which means OK
            var thisTemp  = ( (+sensorData[++i]) +
                              (+sensorData[++i]) +
                              (+sensorData[++i]) ) / 3;
            accessory.log.debug('SHT Temperature reading: ' + thisTemp + '°C');
            var thisHumid = ( (+(sensorData[++i].slice(0,-1))) +
                              (+(sensorData[++i].slice(0,-1))) +
                              (+(sensorData[++i].slice(0,-1))) ) / 3;
            accessory.log.debug('SHT Humidty reading: ' + thisHumid + '%');
            if (thisSensor == 1) {
              accessory.state.sensor1State = NO_FAULT;
              accessory.state.sensor1Temp  = thisTemp;
              accessory.state.sensor1Humid = thisHumid;
            } else {
              accessory.state.sensor2State = NO_FAULT;
              accessory.state.sensor2Temp  = thisTemp;
              accessory.state.sensor2Humid = thisHumid;
            }
          } else {
            // sensor was not listed as "Detected" - which means not OK
            if (thisSensor == 1) {
              accessory.log.debug('SHT Sensor 1 status is not normal (' + sensorData[i] + ')');
              accessory.state.sensor1State = GENERAL_FAULT;
            } else {
              accessory.log.debug('SHT Sensor 2 status is not normal (' + sensorData[i] + ')');
              accessory.state.sensor2State = GENERAL_FAULT;
            }
          }
        }
      }
    } while (++i < sensorData.length);

/*      // retrived status from device - parse the response and update the internal status variables
      accessory.state.sensor1State  = NO_FAULT;
      accessory.state.sensor1Temp   = 0;
      accessory.state.sensor1Humid  = 0;
      accessory.state.sensor2State  = NO_FAULT;
      accessory.state.sensor2Temp   = 0;
      accessory.state.sensor2Humid  = 0;
*/
    if (accessory.state.AlertState == LEAK_NOT_DETECTED) {
      // move from no alert to alert when either sensor *exceeds* the set threshold
      if ( (accessory.state.sensor1Humid > this.alertThreshold) ||
           (accessory.state.sensor2Humid > this.alertThreshold) ) {
        accessory.state.AlertState   = LEAK_DETECTED;
      }
    } else {
      // move from alert back to no alert when *both* sensors *are less than* the set threshold
      // this de-bounces alerts where the sensor is touching the threshold and may go into and out of
      // alert status otherwise
      if ( (accessory.state.sensor1Humid < this.alertThreshold) &&
           (accessory.state.sensor2Humid < this.alertThreshold) ) {
        accessory.state.AlertState   = LEAK_NOT_DETECTED;
      }
    }

    accessory.log.debug("pollSensorState: Updating accessory state...");
    accessory.leakSensor.updateCharacteristic(Characteristic.LeakDetected, accessory.state.AlertState);

    // update HomeBridge with all status of all elements (i.e., SHT sensor readings)
    accessory.log.debug("pollSensorState: Updating state...");
    accessory.tempSensor1Service.updateCharacteristic(  Characteristic.CurrentTemperature,
                                                        accessory.state.sensor1Temp );
    accessory.humidSensor1Service.updateCharacteristic( Characteristic.CurrentRelativeHumidity,
                                                        accessory.state.sensor1Humid );
    accessory.tempSensor2Service.updateCharacteristic(  Characteristic.CurrentTemperature,
                                                        accessory.state.sensor2Temp );
    accessory.humidSensor2Service.updateCharacteristic( Characteristic.CurrentRelativeHumidity,
                                                        accessory.state.sensor2Humid );

    accessory.pollState(); // (re)start polling timer
    }, 3000); // setTimeout
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
