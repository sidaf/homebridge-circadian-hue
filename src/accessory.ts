import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  CharacteristicValue,
  HAP,
  Logging,
  Service,
} from 'homebridge';

import SunCalc from 'suncalc';
import color from 'bash-color';
import LightState from 'node-hue-api/lib/model/lightstate/LightState';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const hueHub = require('node-hue-api').v3;

let hap: HAP;

/*
  * Initializer function called when the plugin is loaded.
  */
export = (api: API) => {
  hap = api.hap;
  api.registerAccessory('homebridge-circadian-hue', 'CircadianHue', CircadianHue);
};

const BRIGHTNESS_CHANGE = 25; // ≈10% of total range
const COLORTEMP_CHANGE = 20; // ≈5% of total range

class CircadianHue implements AccessoryPlugin {
  public readonly log: Logging;
  public readonly config: AccessoryConfig;
  public readonly api: API;

  private readonly switchService: Service;
  private readonly informationService: Service;

  private readonly name: string;

  private cacheDirectory: string;
  private storage: any;

  private sleepSwitch: SleepSwitch;

  private enabled = false;
  private sleep = false;

  private running = false;

  private latitude: number;
  private longitude: number;
  private maxColortemp: number;
  private minColortemp: number;
  private excludeColortemp: Array<string>;
  private maxBrightness: number;
  private minBrightness: number;
  private excludeBrightness: Array<string>;
  private sleepColortemp: number;
  private sleepBrightness: number;
  private excludeLights: Array<string>;
  private updateInterval: number;
  private excludeManualOverride: Array<string>;
  private bridgePollingInterval: number;
  private bridgeAddress: string;
  private bridgeUsername: string;

  private bridgeMonitorPromise: Promise<void>;

  private tracker: Map<number, Metadata> = new Map<number, Metadata>();

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.name = config.name.trim() || 'Circadian Hue';

    this.switchService = new hap.Service.Switch(this.name, this.name + ' Enable Switch');
    this.switchService.getCharacteristic(hap.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Circadian Hue')
      .setCharacteristic(hap.Characteristic.Model, 'Enable Switch');

    this.cacheDirectory = api.user.persistPath();
    this.storage = require('node-persist');
    this.storage.initSync({
      dir: this.cacheDirectory,
      forgiveParseErrors: true,
    });

    this.log.debug('Loading cached state');

    const key = 'MAIN';
    const defaultValue = {
      'sleep': false,
      'enabled' : false,
    };

    const cachedValue = this.storage.getItemSync(this.name + '-HCH-' + key);

    if(cachedValue === undefined || cachedValue === null) {
      this.sleep = defaultValue.sleep;
      this.enabled = defaultValue.enabled;
    } else {
      this.sleep = cachedValue.sleep;
      this.enabled = cachedValue.enabled;
    }

    this.log.debug('- enabled: ' + this.enabled);
    this.log.debug('- sleep: ' + this.sleep);

    this.log.debug('Reading config');

    this.latitude = (Number(config.latitude) || 51.509865);
    this.longitude = (Number(config.longitude) || -0.118092);
    this.excludeLights = (config.excludeLights || '').split(',').map((item: string) => {
      return item.trim();
    });
    this.updateInterval = (Number(config.updateInterval) || 90);
    this.maxColortemp = (Number(config.maxColortemp) || 6500);
    this.minColortemp = (Number(config.minColortemp) || 2200);
    this.excludeColortemp = (config.excludeColortemp || '').split(',').map((item: string) => {
      return item.trim();
    }); // "-1" to exclude all
    this.maxBrightness = (Number(config.maxBrightness) || 100);
    this.minBrightness = (Number(config.minBrightness) || 50);
    this.excludeBrightness = (config.excludeBrightness || '').split(',').map((item: string) => {
      return item.trim();
    }); // "-1" to exclude all
    this.sleepColortemp = (Number(config.sleepColortemp) || 2000);
    this.sleepBrightness = (Number(config.sleepBrightness) || 25);
    this.excludeManualOverride = (config.excludeManualOverride || '').split(',').map((item: string) => {
      return item.trim();
    }); // "-1" to exclude all
    this.bridgeAddress = config.bridgeAddress;
    this.bridgeUsername = config.bridgeUsername;
    this.bridgePollingInterval = (Number(config.bridgePollingInterval) || 0.5);

    this.log.debug('- latitude: ' + this.latitude);
    this.log.debug('- longitude: ' + this.longitude);
    this.log.debug('- excludeLights: ' + this.excludeLights);
    this.log.debug('- updateInterval: ' + this.updateInterval);
    this.log.debug('- maxColortemp: ' + this.maxColortemp);
    this.log.debug('- minColortemp: ' + this.minColortemp);
    this.log.debug('- excludeColortemp: ' + this.excludeColortemp);
    this.log.debug('- maxBrightness: ' + this.maxBrightness);
    this.log.debug('- minBrightness: ' + this.minBrightness);
    this.log.debug('- excludeBrightness: ' + this.excludeBrightness);
    this.log.debug('- sleepColortemp: ' + this.sleepColortemp);
    this.log.debug('- sleepBrightness: ' + this.sleepBrightness);
    this.log.debug('- bridgeAddress: ' + this.bridgeAddress);
    this.log.debug('- bridgeUsername: ' + this.bridgeUsername);
    this.log.debug('- bridgePollingInterval: ' + this.bridgePollingInterval);

    this.log.debug('Creating sleep switch');
    this.sleepSwitch = new SleepSwitch(this);

    this.bridgeMonitorPromise = this.bridgeMonitor();
  }

  identify(): void {
    this.log('Identify!');
  }

  getServices(): Service[] {
    const services = [
      this.informationService,
      this.switchService,
    ];
    return services.concat([...this.sleepSwitch.getServices()]);
  }

  async setOn(value: CharacteristicValue) {
    // implement your own code to turn your device on/off
    const isOn = value as boolean;
    this.setEnabled(isOn);
    this.log.debug('Enabled.setOn ->', (isOn? 'ON': 'OFF'));
    await this.bridgeMonitorPromise;
    this.bridgeMonitorPromise = this.bridgeMonitor();
  }

  async getOn(): Promise<CharacteristicValue> {
    // implement your own code to check if the device is on
    const isOn = this.enabled;
    this.log.debug('Enabled.getOn ->', (isOn? 'ON': 'OFF'));
    return isOn;
  }

  async saveCachedState(): Promise<void> {
    const key = 'MAIN';
    const value = {
      'sleep': this.sleep,
      'enabled' : this.enabled,
    };

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const that = this;
    setTimeout(() => {
      that.storage.setItemSync(that.name + '-HCH-' + key, value);
    }, 10);
  }

  async setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    this.saveCachedState();

    this.bridgeMonitor();
  }

  async setSleep(on: boolean): Promise<void> {
    this.sleep = on;

    this.log.debug('Resetting metadata \'last updated\' data');
    for (const id of this.tracker.keys()) {
      const metadata = this.tracker.get(id);
      if (metadata) {
        if (metadata.manual === false) {
          metadata.last_updated = new Date(1970, 1, 1);
          this.tracker.set(id, metadata);
        }
      }
    }

    this.saveCachedState();
  }

  async getSleep(): Promise<boolean> {
    return this.sleep;
  }

  async bridgeMonitor(): Promise<void> {
    if (this.enabled === true && this.running === false && this.bridgePollingInterval > 0) {
      this.running = true;
      this.log.debug('Started monitoring the bridge');
      await this.buildMetadata();
      while (this.enabled === true) {
        await this.updateLights();
        await new Promise(r => setTimeout(r, this.bridgePollingInterval * 1000));
      }
      this.running = false;
      this.log.debug('Stopped monitoring the bridge');
    }
  }

  async updateLights(): Promise<void> {

    const sunPosition = await this.calculate_sun_position();
    const brightnessPercentage = await this.calculate_brightness_percentage(sunPosition);
    const brightnessSaturation = Math.round((brightnessPercentage / 100) * 254);
    const colortempKelvin = await this.calculate_colortemp_in_kelvin(sunPosition);
    const colortempMired = Math.ceil(1000000 / colortempKelvin);

    const api = await hueHub.api.createLocal(this.bridgeAddress).connect(this.bridgeUsername).catch(() => {
      this.log(color.red('💡 · Could not connect to the bridge!'));
    });

    if (api) {
      const allLights = await api.lights.getAll().catch(() => {
        this.log(color.red('💡 · Error retrieving light information!'));
      });

      if (allLights) {
        await allLights.forEach(async light => {
          const logPrefix = '💡 ' + String(light.id).padEnd(2) + ' · ' + light.name + ' · ';
          //const logDebugPrefix = '#  ' + String(light.id).padEnd(2) + ' · ' + light.name + ' · ';

          if (this.tracker.has(light.id)) {
            const metadata = this.tracker.get(light.id);

            const state = await api.lights.getLightState(light.id).catch(() => {
              this.log(color.red(logPrefix + 'Error retrieving light state!'));
            });

            if (state && metadata) {
              if (state.on === false || state.reachable === false) {
                if (metadata.manual === true) {
                  this.log(color.blue(logPrefix + 'Is turned off, will resume control when turned on'));
                  metadata.reset();
                }
              } else if (metadata.manual === true) {
                return;
              } else {
                if (metadata && ((new Date().getTime() - metadata.last_updated.getTime()) / 1000) > this.updateInterval) {
                  let bri: number = metadata.bri;
                  if (metadata.capability === Capability.BOTH || metadata.capability === Capability.BRIGHTNESS) {
                    bri = state.bri;
                  }
                  let ct: number = metadata.ct;
                  if (metadata.capability === Capability.BOTH || metadata.capability === Capability.COLORTEMP) {
                    ct = state.ct;
                  }

                  /*
                   * Consider it a significant change when attribute changes more than
                   * BRIGHTNESS_CHANGE = 25  # ≈10% of total range
                   * COLORTEMP_CHANGE  = 20  # ≈5% of total range
                   */
                  if (((Math.abs(bri - metadata.bri) <= BRIGHTNESS_CHANGE || this.excludeBrightness.includes(String(light.id))) &&
                        (Math.abs(ct - metadata.ct) <= COLORTEMP_CHANGE || this.excludeColortemp.includes(String(light.id)))) ||
                          this.excludeManualOverride.includes(String(light.id)) ||
                          metadata.last_updated.getTime() === new Date(1970, 1, 1).getTime()) {

                    //this.log.debug(logDebugPrefix + "Current brightness saturation value is " + bri + ", colortemp mired value is " + ct);
                    //this.log.debug(logDebugPrefix + "Calculated brightness saturation value is " + brightnessSaturation + ", colourtemp mired value is " + colortempMired);

                    if ((bri !== brightnessSaturation && this.excludeBrightness.includes(String(light.id)) === false) ||
                        (ct !== colortempMired && this.excludeColortemp.includes(String(light.id)) === false)) {

                      const updatedLightState = new LightState();
                      if (metadata.capability === Capability.BOTH || metadata.capability === Capability.BRIGHTNESS) {
                        if (this.excludeBrightness.includes(String(light.id)) === false) {
                          if (bri !== brightnessSaturation) {
                            updatedLightState.bri(brightnessSaturation);
                            this.log(logPrefix + 'Changing brightness saturation value to ' + brightnessSaturation + ', from ' + bri);
                          }
                        }
                      }
                      if (metadata.capability === Capability.BOTH || metadata.capability === Capability.COLORTEMP) {
                        if (this.excludeColortemp.includes(String(light.id)) === false) {
                          if (ct !== colortempMired) {
                            updatedLightState.ct(colortempMired);
                            this.log(logPrefix + 'Changing colortemp mired value to ' + colortempMired + ', from ' + ct);
                          }
                        }
                      }

                      const result = await api.lights.setLightState(light.id, updatedLightState).catch(() => {
                        this.log(color.red(logPrefix + 'Error setting light state!'));
                      });
                      if (result === false) {
                        this.log(color.red(logPrefix + 'Could not update light!'));
                        return;
                      }

                      metadata.bri = brightnessSaturation;
                      metadata.ct = colortempMired;
                    } else {
                      metadata.bri = bri;
                      metadata.ct = ct;
                    }
                  } else {
                    this.log(color.blue(logPrefix + 'State has changed since last update, presuming manual override [bri:' + metadata.bri + '=>' + bri + '|ct:' + metadata.ct + '=>' + ct + ']'));
                    metadata.manual = true;
                  }
                  metadata.last_updated = new Date();
                }
              }
              this.tracker[light.id] = metadata;
            }
          }
        });
      }
    }
  }

  async buildMetadata(): Promise<void> {
    const connection = await hueHub.api.createLocal(this.bridgeAddress).connect(this.bridgeUsername);
    const lights = await connection.lights.getAll();
    this.log('   ID   ' + 'Name'.padEnd(30) + ' Update');
    this.log('   ==   ' + '===='.padEnd(30) + ' ======');
    await lights.forEach(light => {
      const metadata = new Metadata(light.id);
      const supportedStates = light.getSupportedStates();
      let status = '';

      if (this.excludeBrightness.includes('-1') && this.excludeBrightness.includes(String(light.id)) === false) {
        this.excludeBrightness.push(String(light.id));
      }

      if (this.excludeColortemp.includes('-1') && this.excludeColortemp.includes(String(light.id)) === false) {
        this.excludeColortemp.push(String(light.id));
      }

      if (supportedStates.includes('bri') && supportedStates.includes('ct')) {
        metadata.capability = Capability.BOTH;
      } else if (supportedStates.includes('bri')) {
        metadata.capability = Capability.BRIGHTNESS;
      } else if (supportedStates.includes('ct')) {
        metadata.capability = Capability.COLORTEMP;
      } else {
        metadata.capability = Capability.NONE;
      }

      if (metadata.capability === Capability.BOTH || metadata.capability === Capability.BRIGHTNESS) {
        if (this.excludeBrightness.includes(String(light.id)) === false && this.excludeLights.includes(String(light.id)) === false) {
          status = status + color.green('BRIGHTNESS') + '|';
        }
      }
      if (metadata.capability === Capability.BOTH || metadata.capability === Capability.COLORTEMP) {
        if (this.excludeColortemp.includes(String(light.id)) === false && this.excludeLights.includes(String(light.id)) === false) {
          status = status + color.green('COLORTEMP');
        }
      }
      if (status.endsWith('|')) {
        status = status.slice(0, -1);
      }

      if (metadata.capability === Capability.NONE) {
        this.excludeLights.push(String(light.id));
        status = color.red('UNSUPPORTED');
      } else if (this.excludeLights.includes(String(light.id))) {
        status = color.red('MANUAL');
      } else {
        if (this.excludeManualOverride.includes(String(light.id))) {
          status = color.yellow('FORCE') + '|' + status;
        } else {
          status = color.blue('AUTO') + '|' + status;
        }
        this.tracker.set(light.id, metadata);
      }

      this.log('💡 ' + String(light.id).padEnd(2) + ' · ' + light.name.padEnd(30) + ' [' + status + ']');
    });
  }

  async calculate_sun_position(): Promise<number> {
    const today = SunCalc.getTimes(new Date(), this.latitude, this.longitude);

    const now_seconds = new Date().getTime() / 1000;
    let sunrise_seconds = today.sunrise.getTime() / 1000;
    let sunset_seconds = today.sunset.getTime() / 1000;
    const solar_noon_seconds = today.solarNoon.getTime() / 1000;
    let solar_midnight_seconds = today.nadir.getTime() / 1000;

    if (now_seconds < sunrise_seconds) { // It's before sunrise (after midnight)
      // Because it's before sunrise (and after midnight) sunset must have happend yesterday
      const date = new Date();
      date.setDate(date.getDate() - 1);
      const yesterday = SunCalc.getTimes(date, this.latitude, this.longitude);

      const yesterday_solar_sunset_seconds = yesterday.sunset.getTime() / 1000;
      const yesterday_solar_midnight_seconds = yesterday.nadir.getTime() / 1000;

      if (solar_midnight_seconds > sunset_seconds && yesterday_solar_midnight_seconds > yesterday_solar_sunset_seconds) {
        // Solar midnight is after sunset so use yesterdays's time
        solar_midnight_seconds = yesterday_solar_midnight_seconds;
      }
      sunset_seconds = yesterday_solar_sunset_seconds;
    } else if (now_seconds > sunset_seconds) { // It's after sunset (before midnight)
      // Because it's after sunset (and before midnight) sunrise should happen tomorrow
      const date = new Date();
      date.setDate(date.getDate() + 1);
      const tomorrow = SunCalc.getTimes(date, this.latitude, this.longitude);

      const tomorrow_sunrise_seconds = tomorrow.sunrise.getTime() / 1000;
      const tomorrow_solar_midnight_seconds = tomorrow.nadir.getTime() / 1000;

      if (solar_midnight_seconds < sunrise_seconds && tomorrow_solar_midnight_seconds < tomorrow_sunrise_seconds) {
        // Solar midnight is before sunrise so use tomorrow's time
        solar_midnight_seconds = tomorrow_solar_midnight_seconds;
      }
      sunrise_seconds = tomorrow_sunrise_seconds;
    }

    // Figure out where we are in time so we know which half of the
    // parabola to calculate. We're generating a different
    // sunset-sunrise parabola for before and after solar midnight.
    // because it might not be half way between sunrise and sunset.
    // We're also generating a different parabola for sunrise-sunset.

    // sunrise-sunset parabola
    let h: number = solar_noon_seconds;
    let k = 100;
    let x: number = sunrise_seconds;
    if (now_seconds > sunrise_seconds && now_seconds < sunset_seconds) {
      h = solar_noon_seconds;
      k = 100;
      // parabola before solar_noon
      if (now_seconds < solar_noon_seconds) {
        x = sunrise_seconds;
      } else { // parabola after solar_noon
        x = sunset_seconds;
      }
    }
    // sunset_sunrise parabola
    else if (now_seconds > sunset_seconds && now_seconds < sunrise_seconds) {
      h = solar_midnight_seconds;
      k = -100;
      // parabola before solar_midnight
      if (now_seconds < solar_midnight_seconds) {
        x = sunset_seconds;
      }
      // parabola after solar_midnight
      else {
        x = sunrise_seconds;
      }
    }

    const y = 0;
    const a = (y - k)/(h - x) **2;
    return a * (now_seconds - h) ** 2 + k;
  }

  async calculate_brightness_percentage(sun_position: number): Promise<number> {
    if (this.sleep) {
      return this.sleepBrightness;
    }

    if (sun_position > 0) {
      return this.maxBrightness;
    }

    const delta = this.maxBrightness - this.minBrightness;
    return Math.round((delta * ((100 + sun_position) / 100)) + this.minBrightness);
  }

  async calculate_colortemp_in_kelvin(sun_position: number): Promise<number> {
    if (this.sleep) {
      return this.sleepColortemp;
    }

    if (sun_position > 0) {
      const delta = this.maxColortemp - this.minColortemp;
      return Math.ceil((delta * (sun_position / 100)) + this.minColortemp);
    }

    return this.minColortemp;
  }

  async mired_to_kelvin(mired: number): Promise<number> {
    if (mired === -1) {
      return mired;
    }
    return Math.ceil(1000000 / mired);
  }

  async saturation_to_percentage(saturation: number): Promise<number> {
    if (saturation === -1) {
      return saturation;
    }
    return Math.round((saturation / 254) * 100);
  }
}

class SleepSwitch implements AccessoryPlugin {

  private circadianHue: CircadianHue;

  private readonly log: Logging;
  private readonly name: string;

  private readonly switchService: Service;
  private readonly informationService: Service;

  constructor(circadianHue: CircadianHue) {
    this.circadianHue = circadianHue;
    this.log = circadianHue.log;
    this.name = circadianHue.config.name + ' Sleep Switch';

    this.switchService = new hap.Service.Switch(this.name, this.name);
    this.switchService.getCharacteristic(hap.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Circadian Hue')
      .setCharacteristic(hap.Characteristic.Model, 'Sleep Switch');
  }

  identify(): void {
    this.log('Identify!');
  }

  getServices(): Service[] {
    return [
      this.informationService,
      this.switchService,
    ];
  }

  async setOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    this.circadianHue.setSleep(isOn);
    this.log.debug('Sleep.setOn ->', (isOn? 'ON': 'OFF'));
  }

  async getOn(): Promise<CharacteristicValue> {
    const isOn = await this.circadianHue.getSleep();
    this.log.debug('Sleep.getOn ->', (isOn? 'ON': 'OFF'));
    return isOn;
  }
}

class Metadata {
  id: number;
  bri = -1;
  ct = -1;
  capability: Capability = Capability.BOTH;
  last_updated: Date = new Date(1970, 1, 1);
  manual = false;

  constructor(id: number) {
    this.id = id;
  }

  reset(): void {
    this.bri = -1;
    this.ct = -1;
    this.last_updated = new Date(1970, 1, 1);
    this.manual = false;
  }
}

enum Capability {
  NONE = 'NONE',
  BOTH = 'BRI,CT',
  BRIGHTNESS = 'BRI',
  COLORTEMP = 'CT'
}