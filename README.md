[![Donate](https://badgen.net/badge/donate/paypal)](https://paypal.me/HomebridgeJ1mbo)

# homebridge-leak-alarm

A HomeBridge interface for a simple leak alarm with HTTP reporting capability and up to two attached sensors.

The alarm should report report in the following format via a request to http://[ip-address]:80/ with one line for each sensor (up to 2):

[Sensor-Type],[Sensor-Index],[Sensor-Location],[Sensor-State],[Temperature-Reading1],[Temperature-Reading2],[Temperature-Reading3],[Humidity-Reading1],[Humidity-Reading2],[Humidity-Reading3]

Example:

	SHT,1,Shower Tray,Detected,22.8,22.8,22.8,49.2%,49.2%,49.1%

Temperature values are assumed to be °C. Relative humidity values are percentage and should include % sign as shown.

Values of [Sensor-State] are:
"Detected" - sensor is present and functioning
"Not Detected" - sensor was not detected at boot
"Failed" - sensor was detected at boot, but is no longer responding

Sensors from the SHT3x family, for example, provide appropriate reporting.

The interval between the three reported values is controlled by the alarm. This pluging will average the three readings in order to determine the alert status. The alarm itself might use any interval suitable for the environment - polling the sensors somewhere between 15 seconds and 5 minutes typically.

Subscribable events:

- Leak sensor alert status

The sensor reports three recent temperature and humidity readings for each of the two attached SHT sensors.
The use-case is for areas where small leaks can go undetected and cause a build-up of mould or rot before showing themselves via the building fabric, for example behind a washing machine or under a shower trap. Therefore, the alerting is based on relative humidity being over a threshold so indicating continuous dampness, e.g. 90%. This works for heated spaces in the UK climate and may not be a suitable approach elsewhere.

# Plugin Configuration

Installed through HomeBridge plugins UI, the settings are fully configurable in the UI. Note that a static IP address is required on the device.

# Issues and Contact

Please raise an issue should you come across one via Github.

