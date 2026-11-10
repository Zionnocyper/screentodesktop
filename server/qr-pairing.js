// "Pair device with QR code" (Android 11+ Wireless debugging), like Android Studio:
//  1. we make up a service name + password and show WIFI:T:ADB;S:<name>;P:<password>;;
//  2. the phone scans it and advertises _adb-tls-pairing._tcp with instance name <name>
//  3. we see it through the adb server's mDNS, pair with <password>, then connect.
import crypto from 'node:crypto';

const QR_TTL_MS = 5 * 60_000;
const POLL_MS = 1000;
const ALNUM = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token(length) {
  let out = '';
  for (const b of crypto.randomBytes(length)) out += ALNUM[b % ALNUM.length];
  return out;
}

export class QrPairing {
  #sessions = new Map();

  /**
   * connectPaired(guid, lang) -> { connected, serial?, hint? }
   * explain(lang, err) -> user-facing message
   */
  constructor({ adb, connectPaired, explain }) {
    this.adb = adb;
    this.connectPaired = connectPaired;
    this.explain = explain;
  }

  create(lang) {
    this.#gc();
    const name = `studio-${token(10)}`;
    const password = token(12);
    const session = {
      id: crypto.randomBytes(16).toString('base64url'),
      name,
      password,
      qr: `WIFI:T:ADB;S:${name};P:${password};;`,
      state: 'waiting', // waiting -> pairing -> connected | paired | error ; or expired
      message: null,
      hint: null,
      serial: null,
      created: Date.now(),
      expires: Date.now() + QR_TTL_MS,
      lang,
      cancelled: false,
    };
    this.#sessions.set(session.id, session);
    this.#run(session);
    return session;
  }

  get(id) {
    return this.#sessions.get(id) ?? null;
  }

  cancel(id) {
    const s = this.#sessions.get(id);
    if (!s) return;
    s.cancelled = true;
    this.#sessions.delete(id);
  }

  /** Public view (the password stays on the server). */
  view(s, { withQr = false } = {}) {
    return {
      id: s.id,
      state: s.state,
      message: s.message,
      hint: s.hint,
      serial: s.serial,
      expiresIn: Math.max(0, Math.round((s.expires - Date.now()) / 1000)),
      ...(withQr ? { qr: s.qr, name: s.name } : {}),
    };
  }

  async #run(s) {
    while (!s.cancelled && Date.now() < s.expires) {
      const services = await this.adb.mdnsServices().catch(() => []);
      const service = services.find((x) => x.type === 'pairing' && x.instance === s.name);
      if (service) {
        s.state = 'pairing';
        try {
          const { guid, message } = await this.adb.pair(service.address, s.password);
          console.log(`[adb] ${message} (QR)`);
          const result = await this.connectPaired(guid, s.lang);
          s.serial = result.serial ?? null;
          s.hint = result.hint ?? null;
          s.state = result.connected ? 'connected' : 'paired';
        } catch (err) {
          s.state = 'error';
          s.message = this.explain(s.lang, err);
        }
        return;
      }
      await sleep(POLL_MS);
    }
    if (!s.cancelled && s.state === 'waiting') s.state = 'expired';
  }

  #gc() {
    for (const [id, s] of this.#sessions) {
      if (Date.now() - s.created > 15 * 60_000) {
        s.cancelled = true;
        this.#sessions.delete(id);
      }
    }
  }
}
