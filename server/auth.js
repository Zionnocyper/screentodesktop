// Optional password protection + same-origin / host checks.
import crypto from 'node:crypto';
import net from 'node:net';

const COOKIE = 'std_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hostnameOf(hostHeader = '') {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

export class Auth {
  #sessions = new Map(); // token -> expiry
  #failures = new Map(); // ip -> { count, until }

  constructor({ password, allowedHosts = [], trustProxy = false }) {
    this.password = password || '';
    this.allowedHosts = allowedHosts.map((h) => h.toLowerCase());
    this.trustProxy = trustProxy;
  }

  get enabled() {
    return this.password.length > 0;
  }

  clientIp(req) {
    if (this.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? '';
  }

  isSecure(req) {
    return Boolean(req.socket.encrypted) || (this.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  /**
   * Without a password the app must only be reachable through an IP literal,
   * localhost or an explicitly allowed host name. This blocks DNS-rebinding
   * attacks from random websites against a local instance.
   */
  hostAllowed(req) {
    const host = hostnameOf(req.headers.host);
    if (!host) return false;
    if (this.allowedHosts.includes('*') || this.allowedHosts.includes(host)) return true;
    if (this.enabled) return true;
    return host === 'localhost' || host.endsWith('.localhost') || net.isIP(host) !== 0;
  }

  /** Rejects cross-site requests (WebSocket upgrades are not covered by CORS). */
  sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    try {
      const o = new URL(origin);
      const forwardedHost = this.trustProxy ? req.headers['x-forwarded-host'] : null;
      const host = String(forwardedHost || req.headers.host || '').toLowerCase();
      return o.host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  isAuthenticated(req) {
    if (!this.enabled) return true;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const exp = this.#sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.#sessions.delete(token);
      return false;
    }
    return true;
  }

  /** Returns { ok, cookie?, retryAfter? }. */
  login(req, password) {
    const ip = this.clientIp(req);
    const f = this.#failures.get(ip);
    if (f && f.until > Date.now()) return { ok: false, retryAfter: Math.ceil((f.until - Date.now()) / 1000) };

    const ok = this.enabled && crypto.timingSafeEqual(sha256(password), sha256(this.password));
    if (!ok) {
      const count = (f?.count ?? 0) + 1;
      this.#failures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
      return { ok: false };
    }
    this.#failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.#sessions.set(token, Date.now() + SESSION_TTL_MS);
    const secure = this.isSecure(req) ? '; Secure' : '';
    return {
      ok: true,
      cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
    };
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) this.#sessions.delete(token);
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
