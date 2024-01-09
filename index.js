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

      // create an information service...
      this.informationService = new this.Service.AccessoryInformation()
        .setCharacteristic(this.Characteristic.Manufacturer, "HomeBridge")
        .setCharacteristic(this.Characteristic.Model, this.model)
        .setCharacteristic(this.Characteristic.SerialNumber, this.serialNumber);

      // ...and the sensors etc...
      this.leakSensor          = new this.Service.LeakSensor(this.name);
      this.tempSensor1Service  = new this.Service.TemperatureSensor(this.sensor1Location,this.sensor1Location);
      this.humidSensor1Service = new this.Service.HumiditySensor(this.sensor1Location,this.sensor1Location);
      this.tempSensor2Service  = new this.Service.TemperatureSensor(this.sensor2Location,this.sensor2Location);
      this.humidSensor2Service = new this.Service.HumiditySensor(this.sensor2Location,this.sensor2Location);

      // IOS 16 and above over-writes the descriptive names set against the accesories
      // The following restores them to display as previously (e.g., on IOS 15)
      this.leakSensor.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.leakSensor.setCharacteristic(this.Characteristic.ConfiguredName, this.name);

      this.tempSensor1Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.tempSensor1Service.setCharacteristic(this.Characteristic.ConfiguredName, this.sensor1Location);

      this.humidSensor1Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.humidSensor1Service.setCharacteristic(this.Characteristic.ConfiguredName, this.sensor1Location);

      this.tempSensor2Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.tempSensor2Service.setCharacteristic(this.Characteristic.ConfiguredName, this.sensor2Location);

      this.humidSensor2Service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.humidSensor2Service.setCharacteristic(this.Characteristic.ConfiguredName, this.sensor2Location);

      // bind handlers
      this.leakSensor
        .setCharacteristic(this.Characteristic.Name,this.name)
        .getCharacteristic(this.Characteristic.LeakDetected)
        .on('get', this.getState.bind(this));
      this.leakSensor
        .setCharacteristic(this.Characteristic.StatusFault,NO_FAULT)
        .getCharacteristic(this.Characteristic.StatusFault)
        .on('get', this.getFaultState.bind(this));

      this.tempSensor1Service
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .on('get', this.getTemp1.bind(this));
      this.tempSensor1Service
        .setCharacteristic(this.Characteristic.StatusFault,NO_FAULT)
        .getCharacteristic(this.Characteristic.StatusFault)
        .on('get', this.getTemp1FaultState.bind(this));

      this.humidSensor1Service
        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
        .on('get', this.getHumid1.bind(this));
      this.humidSensor1Service
        .setCharacteristic(this.Characteristic.StatusFault,NO_FAULT)
        .getCharacteristic(this.Characteristic.StatusFault)
        .on('get', this.getHumid2FaultState.bind(this));

      this.tempSensor2Service
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .on('get', this.getTemp2.bind(this));
      this.tempSensor2Service
        .setCharacteristic(this.Characteristic.StatusFault,NO_FAULT)
        .getCharacteristic(this.Characteristic.StatusFault)
        .on('get', this.getTemp2FaultState.bind(this));

      this.humidSensor2Service
        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
        .on('get', this.getHumid2.bind(this));
      this.humidSensor2Service
        .setCharacteristic(this.Characteristic.StatusFault,NO_FAULT)
        .getCharacteristic(this.Characteristic.StatusFault)
        .on('get', this.getHumid2FaultState.bind(this));

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
  getFaultState(callback) {
    var accessory = this;
    accessory.log.debug('Leak Sensor current fault state: ', accessory.state.deviceState);
    callback(null, accessory.state.deviceState);
  }

  getTemp1(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 1 current temperature reading: ', accessory.state.sensor1Temp);
    callback(null, accessory.state.sensor1Temp);
  }
  getTemp1FaultState(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 1 (temperature) current fault state: ', accessory.state.sensor1State);
    callback(null, accessory.state.sensor1State);
  }

  getHumid1(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 1 current humidity reading: ', accessory.state.sensor1Humid);
    callback(null, accessory.state.sensor1Humid);
  }
  getHumid1FaultState(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 1 (humidity) current fault state: ', accessory.state.sensor1State);
    callback(null, accessory.state.sensor1State);
  }

  getTemp2(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 2 current temperature reading: ', accessory.state.sensor2Temp);
    callback(null, accessory.state.sensor2Temp);
  }
  getTemp2FaultState(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 2 (temperature) current fault state: ', accessory.state.sensor2State);
    callback(null, accessory.state.sensor2State);
  }

  getHumid2(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 2 current humidity reading: ', accessory.state.sensor2Humid);
    callback(null, accessory.state.sensor2Humid);
  }
  getHumid2FaultState(callback) {
    var accessory = this;
    accessory.log.debug('SHT Sensor 2 (humidity) current fault state: ', accessory.state.sensor2State);
    callback(null, accessory.state.sensor2State);
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
        accessory.state.deviceState = GENERAL_FAULT;
      } else {
        accessory.state.deviceState = NO_FAULT; // assume OK on 200 - until we encounter an error condition further down
      }
      if (error) {
        accessory.log(error.message);
        accessory.state.deviceState = GENERAL_FAULT;
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
          accessory.state.deviceState = GENERAL_FAULT;
        }
      });
    }).on('error', (e) => {
      accessory.log('Could not connect to configured device (' + this.IpAddress + ')');
      accessory.log.debug(`Got error: ${e.message}`);
      accessory.state.deviceState = GENERAL_FAULT;
    });

    // allow 3 seconds for the above web request to success (or fail)
    setTimeout(() => {
      if (accessory.state.deviceState == NO_FAULT) {
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
                  accessory.log('SHT Sensor 1 status is not normal (' + sensorData[i] + ')');
                  accessory.state.sensor1State = GENERAL_FAULT;
                } else {
                  accessory.log('SHT Sensor 2 status is not normal (' + sensorData[i] + ')');
                  accessory.state.sensor2State = GENERAL_FAULT;
                }
              }
            }
          }
        } while (++i < sensorData.length);

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

        accessory.log( "pollSensorState: Updating accessory state "
                             + "(alertState: " + accessory.state.AlertState
                             + ", deviceState: " + accessory.state.deviceState
                             + ")" );
        accessory.leakSensor.updateCharacteristic(Characteristic.LeakDetected, accessory.state.AlertState);
        accessory.leakSensor.updateCharacteristic(Characteristic.StatusFault, accessory.state.deviceState);

        // update HomeBridge with all status of all elements (i.e., SHT sensor readings)
        accessory.log.debug("pollSensorState: Updating element state...");
        accessory.tempSensor1Service.updateCharacteristic(  Characteristic.CurrentTemperature,
                                                            accessory.state.sensor1Temp );
        accessory.tempSensor1Service.updateCharacteristic(  Characteristic.StatusFault, accessory.state.sensor1State);

        accessory.humidSensor1Service.updateCharacteristic( Characteristic.CurrentRelativeHumidity,
                                                            accessory.state.sensor1Humid );
        accessory.humidSensor1Service.updateCharacteristic( Characteristic.StatusFault, accessory.state.sensor1State);

        accessory.tempSensor2Service.updateCharacteristic(  Characteristic.CurrentTemperature,
                                                            accessory.state.sensor2Temp );
        accessory.tempSensor2Service.updateCharacteristic(  Characteristic.StatusFault, accessory.state.sensor2State);

        accessory.humidSensor2Service.updateCharacteristic( Characteristic.CurrentRelativeHumidity,
                                                            accessory.state.sensor2Humid );
        accessory.humidSensor2Service.updateCharacteristic( Characteristic.StatusFault, accessory.state.sensor2State);

      } else {
        // update HomeKit that the sensor appears to be offline or other error
        accessory.log("pollSensorState: Updating accessory status fault state (now "
                      + accessory.state.deviceState + ")");
        accessory.leakSensor.updateCharacteristic(Characteristic.StatusFault, accessory.state.deviceState);
      } // end if deviceState == NO_FAULT

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
