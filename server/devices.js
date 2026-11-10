// Keeps a live list of ADB devices (via host:track-devices-l) enriched with
// a few system properties, and notifies listeners on change.
import { EventEmitter } from 'node:events';

const PROPS = [
  ['manufacturer', 'ro.product.manufacturer'],
  ['model', 'ro.product.model'],
  ['androidVersion', 'ro.build.version.release'],
  ['sdk', 'ro.build.version.sdk'],
];

export class DeviceManager extends EventEmitter {
  #adb;
  #raw = [];
  #info = new Map(); // key: serial|transportId -> props
  #pending = new Set();
  #stop = null;
  error = null;

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
  }

  stop() {
    this.#stop?.();
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
    this.emit('change', this.list());
  }

  list() {
    return this.#raw.map((d) => {
      const info = this.#info.get(this.#key(d)) ?? {};
      return {
        ...d,
        ...info,
        model: info.model ?? d.model,
        wireless: /:\d+$/.test(d.serial) || d.serial.includes('._adb-tls-connect.'),
      };
    });
  }

  get(serial) {
    return this.list().find((d) => d.serial === serial) ?? null;
  }
}
