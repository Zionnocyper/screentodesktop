// Keeps a live list of ADB devices (via host:track-devices-l) enriched with
// a few system properties, plus phones discovered on the LAN through the adb
// server's mDNS (Wireless debugging), and notifies listeners on change.
import { EventEmitter } from 'node:events';

const PROPS = [
  ['manufacturer', 'ro.product.manufacturer'],
  ['model', 'ro.product.model'],
  ['androidVersion', 'ro.build.version.release'],
  ['sdk', 'ro.build.version.sdk'],
];

const MDNS_INTERVAL_MS = 3000;

export function displayName(d) {
  if (!d?.model) return null;
  const maker = d.manufacturer && !d.model.toLowerCase().startsWith(d.manufacturer.toLowerCase()) ? `${d.manufacturer} ` : '';
  return `${maker}${d.model}`;
}

export class DeviceManager extends EventEmitter {
  #adb;
  #raw = [];
  #info = new Map(); // key: serial|transportId -> props
  #pending = new Set();
  #stop = null;
  #stopped = false;
  #mdnsTimer = null;
  #services = [];
  #servicesKey = '';
  error = null;
  mdns = null; // null = unknown, true/false once checked

  constructor(adb) {
    super();
    this.#adb = adb;
  }

  start() {
    this.#stop = this.#adb.trackDevices(
      (list) => {
        this.error = null;
        this.#raw = list;
        this.#emit();
        for (const d of list) if (d.state === 'device') this.#enrich(d);
      },
      (err) => {
        const msg = err?.message ?? String(err);
        if (this.error !== msg) console.warn(`[adb] ${msg}`);
        this.error = msg;
        this.#emit();
      },
    );
    this.#pollMdns();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#mdnsTimer);
    this.#stop?.();
  }

  async #pollMdns() {
    if (this.#stopped) return;
    try {
      if (this.mdns === null) {
        this.mdns = await this.#adb.mdnsAvailable();
        if (!this.mdns) console.warn('[adb] mDNS discovery is disabled in this adb server');
        this.#emit();
      }
      if (this.mdns) {
        const services = (await this.#adb.mdnsServices()).filter((s) => s.type === 'pairing' || s.type === 'connect');
        const key = JSON.stringify(services);
        if (key !== this.#servicesKey) {
          this.#servicesKey = key;
          this.#services = services;
          this.#emit();
        }
      }
    } catch {
      // adb server not reachable yet: trackDevices reports the error
    }
    this.#mdnsTimer = setTimeout(() => this.#pollMdns(), MDNS_INTERVAL_MS);
  }

  #key(d) {
    return `${d.serial}|${d.transportId ?? ''}`;
  }

  async #enrich(d) {
    const key = this.#key(d);
    if (this.#info.has(key) || this.#pending.has(key)) return;
    this.#pending.add(key);
    try {
      const cmd = PROPS.map(([, p]) => `getprop ${p}`).join(';echo @@;');
      const out = await this.#adb.shell(d.serial, cmd, { timeoutMs: 10_000 });
      const values = out.split('@@').map((s) => s.trim());
      const info = {};
      PROPS.forEach(([name], i) => {
        if (values[i]) info[name] = values[i];
      });
      this.#info.set(key, info);
      this.#emit();
    } catch (err) {
      console.warn(`[adb] Không đọc được thông tin ${d.serial}: ${err.message}`);
    } finally {
      this.#pending.delete(key);
    }
  }

  #emit() {
    this.emit('change', this.snapshot());
  }

  /** Payload for the API / SSE. */
  snapshot() {
    return { devices: this.list(), discovered: this.discovered(), mdns: this.mdns, error: this.error };
  }

  list() {
    return this.#raw.map((d) => {
      const info = this.#info.get(this.#key(d)) ?? {};
      const service = this.#services.find((s) => `${s.instance}.${s.service}` === d.serial);
      return {
        ...d,
        ...info,
        model: info.model ?? d.model,
        wireless: /:\d+$/.test(d.serial) || d.serial.includes('._adb-tls-connect.'),
        address: service?.address ?? (/:\d+$/.test(d.serial) ? d.serial : null),
      };
    });
  }

  /** Phones advertising Wireless debugging / pairing on the LAN. */
  discovered() {
    const devices = this.list();
    return this.#services.map((s) => {
      const target = `${s.instance}.${s.service}`;
      const connected = devices.some((d) => d.serial === target || d.serial === s.address);
      const known = devices.find((d) => s.serialHint && (d.serial === s.serialHint || d.serial.startsWith(`adb-${s.serialHint}-`)) && d.model);
      return { ...s, target, connected, name: displayName(known) };
    });
  }

  get(serial) {
    return this.list().find((d) => d.serial === serial) ?? null;
  }
}
