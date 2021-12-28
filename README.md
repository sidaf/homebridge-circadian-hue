# Homebridge Circadian Hue

This plugin interacts with a Hue Hub instance and slowly synchronizes your color changing lights with the regular naturally occurring color temperature of the sky throughout the day. This gives your environment a more natural feel, with cooler hues during the midday and warmer tints near twilight and dawn. Based on the Circadian Lighting Home Assistant Component.

## Configuration

`latitude` value required for working out sun position.

`longitude` value required for working out sun position.

`bridgeAddress` is the IP address of the Hue bridge.

`bridgeUsername` is the username to use to  authenticate to the Hue bridge, see [here](https://developers.meethue.com/develop/get-started-2/) on how to generate a username.

`bridgePollingInterval` is the interval in seconds between collecting information from the Hue bridge.

`maxColortemp` is the maximum colour temperature value that will be set.

`minColortemp` is the minimum colour temperature value that will be set.

`excludeColortemp` is a comma seperated list of lights that will not have their colour temperature changed.

`maxBrightness` is the maximum brightness value that will be set.

`minBrightness` is the minimum brightness value that will be set.

`excludeBrightness` is a comma seperated list of lights that will not have their brightness changed.

`sleepColortemp` is the colour temperature value that will be set when sleep mode is enabled.

`sleepBrightness` is the brightness value that will be set when sleep mode is enabled.

`excludeLights` is a comma seperated list of lights that will be excluded from all changes.

`updateInterval` is the interval in seconds that the setting on a light will be changed.

`excludeManualOverride` is a comma seperated list of lights that will not be manually overridable*.

 * When the plugin detects that the characteristics of a light has significantly changed since it was last checked, the light will be put into "manual mode" and no further brightness or colour temperature changes will be applied by the plugin to this specific light. To reset, and have the light controlled by the plugin again, simply turn the light off and on.

## Example Config

```
...
"accessories": [
...
        {
            "name": "Circadian Hue",
            "accessory": "CircadianHue",
            "latitude": 43.543,
            "longitude": -9.4445,
            "bridgeAddress": "192.168.1.100",
            "bridgeUsername": "kj3riwej3ff43j4fk3j4k4",
            "bridgePollingInterval": 0.5,
            "excludeLights": "8,9,10,12,13,15",
            "updateInterval": 90,
            "maxBrightness": 100,
            "minBrightness": 50,
            "excludeColortemp": "",
            "excludeManualOverride": "1,5,14"
        }
...
    ]
...
```
