// ScreenToDesktop server: serves the web app, exposes ADB devices connected to
// this machine and relays scrcpy streams over WebSocket.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AdbClient } from './adb.js';
import { DeviceManager } from './devices.js';
import { Auth } from './auth.js';
import { handleStreamSocket } from './stream.js';
import { SCRCPY_VERSION, SERVER_FILENAME } from '../web/src/shared/scrcpy-options.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

/** adb from ADB_PATH, ./platform-tools in the project, the Android SDK, or PATH. */
function findAdb() {
  if (env.ADB_PATH) return env.ADB_PATH;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const home = env.USERPROFILE || env.HOME || '';
  const candidates = [
    path.join(ROOT, 'platform-tools', exe),
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools', exe),
    env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, 'platform-tools', exe),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe),
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', exe),
    path.join(home, 'Android', 'Sdk', 'platform-tools', exe),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? 'adb';
}

const config = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8000),
  password: env.ACCESS_PASSWORD || '',
  allowedHosts: (env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  adbHost: env.ADB_HOST || '127.0.0.1',
  adbPort: Number(env.ADB_PORT || 5037),
  adbPath: findAdb(),
  tlsCert: env.TLS_CERT || '',
  tlsKey: env.TLS_KEY || '',
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 2048) * 1024 * 1024,
  distDir: path.join(ROOT, 'dist'),
  jarPath: env.SCRCPY_SERVER_PATH || path.join(ROOT, 'web', 'public', SERVER_FILENAME),
};

if (!fs.existsSync(config.jarPath)) {
  console.error(`Thiếu ${config.jarPath}. Chạy: npm run fetch-server`);
  process.exit(1);
}

const adb = new AdbClient({ host: config.adbHost, port: config.adbPort, adbPath: config.adbPath });
const devices = new DeviceManager(adb);
const auth = new Auth({ password: config.password, allowedHosts: config.allowedHosts, trustProxy: config.trustProxy });
devices.start();

// ---------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(config.distDir)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Chưa build giao diện. Chạy: npm run build');
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.resolve(config.distDir, `.${rel}`);
  if (!file.startsWith(config.distDir + path.sep) && file !== config.distDir) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(config.distDir, 'index.html'); // SPA fallback
  }
  const ext = path.extname(file);
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const SERIAL_RE = /^[\w.:\-[\]@%]+$/;
function checkSerial(serial) {
  if (!serial || !SERIAL_RE.test(serial)) throw Object.assign(new Error('Serial không hợp lệ'), { status: 400 });
  const d = devices.get(serial);
  if (!d) throw Object.assign(new Error('Không tìm thấy thiết bị'), { status: 404 });
  if (d.state !== 'device') throw Object.assign(new Error(`Thiết bị đang ở trạng thái "${d.state}"`), { status: 409 });
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** adb's English messages -> short Vietnamese explanations. */
function translateAdbError(message = '') {
  const m = String(message);
  if (/Wrong password|connection was dropped/i.test(m)) {
    return 'Sai mã ghép đôi hoặc kết nối bị ngắt. Mã và cổng ghép đôi đổi mỗi lần mở lại hộp thoại trên điện thoại.';
  }
  if (/Unable to start pairing client|unable to create pairing client/i.test(m)) {
    return 'Không kết nối được tới điện thoại. Kiểm tra IP:cổng ghép đôi và hai máy cùng mạng Wi-Fi.';
  }
  if (/parse address|Invalid port/i.test(m)) return 'Địa chỉ không hợp lệ.';
  if (/Hết thời gian/i.test(m)) return 'Hết thời gian chờ. Hộp thoại ghép đôi trên điện thoại còn mở không?';
  if (/failed to authenticate|authentication/i.test(m)) {
    return `${m}\nĐiện thoại chưa ghép đôi với server này: dùng "Ghép đôi Wi-Fi".`;
  }
  if (/failed to connect|cannot connect|No route|refused|timed out/i.test(m)) {
    return `${m}\nKiểm tra IP:cổng (xem trong Gỡ lỗi không dây) và hai máy cùng mạng.`;
  }
  return m;
}

/**
 * After pairing, make sure the phone gets connected. adb auto-connects paired
 * phones it discovers through mDNS, but only on discovery events, so if the
 * phone was already discovered before pairing we connect it ourselves.
 * The pairing guid is the mDNS instance name of the phone's connect service.
 */
async function connectPaired(guid) {
  const deadline = Date.now() + 12_000;
  let message = null;
  let requested = false;
  while (Date.now() < deadline) {
    const dev = devices.list().find((d) => guid && (d.serial.startsWith(`${guid}.`) || d.serial === guid));
    if (dev?.state === 'device') return { connected: true, serial: dev.serial };
    if (!dev && !requested && guid) {
      const services = await adb.mdnsServices().catch(() => []);
      const target = services.find((s) => s.type === 'connect' && s.instance === guid);
      if (target) {
        message = await adb.connectDevice(`${target.instance}.${target.service}`).catch((e) => e.message);
        requested = /connected to/i.test(message);
      }
    }
    await sleep(800);
  }
  return {
    connected: false,
    hint: 'Đã ghép đôi. Bật "Gỡ lỗi không dây" trên điện thoại; máy sẽ tự hiện trong danh sách, hoặc nhập IP:cổng hiển thị ở đó vào ô Kết nối.',
    connectMessage: message,
  };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function safeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\x00-\x1f,"'`$\\]/g, '_').replace(/^\.+/, '_').slice(0, 180);
  return cleaned || 'file';
}

// ---------------------------------------------------------------- API

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method !== 'GET' && method !== 'HEAD' && !auth.sameOrigin(req)) {
    return sendJson(res, 403, { error: 'Cross-origin request blocked' });
  }

  if (pathname === '/api/session' && method === 'GET') {
    return sendJson(res, 200, {
      server: true,
      version: SCRCPY_VERSION,
      authRequired: auth.enabled,
      authenticated: auth.isAuthenticated(req),
    });
  }
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJson(req);
    const result = auth.login(req, String(body.password ?? ''));
    if (result.ok) return sendJson(res, 200, { ok: true }, { 'Set-Cookie': result.cookie });
    if (result.retryAfter) {
      return sendJson(res, 429, { error: `Thử lại sau ${result.retryAfter}s` }, { 'Retry-After': String(result.retryAfter) });
    }
    return sendJson(res, 401, { error: 'Sai mật khẩu' });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.logout(req) });
  }

  if (!auth.isAuthenticated(req)) return sendJson(res, 401, { error: 'Cần đăng nhập' });

  if (pathname === '/api/devices' && method === 'GET') {
    return sendJson(res, 200, devices.snapshot());
  }

  if (pathname === '/api/devices/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const push = () => res.write(`data: ${JSON.stringify(devices.snapshot())}\n\n`);
    push();
    devices.on('change', push);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      devices.off('change', push);
    });
    return;
  }

  if (pathname === '/api/adb/connect' && method === 'POST') {
    const { address } = await readJson(req);
    const value = String(address ?? '').trim();
    if (!/^(\[[0-9a-fA-F:.%\w]+\]|[\w.\-]+)(:\d{1,5})?$/.test(value)) {
      return sendJson(res, 400, { error: 'Địa chỉ không hợp lệ (ví dụ 192.168.1.10:5555)' });
    }
    // mDNS service names (adb-xxx._adb-tls-connect._tcp) are passed as-is
    const isMdns = /\._adb(-tls-connect)?\._tcp$/.test(value);
    const addr = isMdns || /:\d{1,5}$/.test(value) ? value : `${value}:5555`;
    const message = await adb.connectDevice(addr);
    const ok = /connected to/i.test(message);
    return sendJson(res, ok ? 200 : 502, ok ? { ok, message } : { error: translateAdbError(message) });
  }

  if (pathname === '/api/adb/pair' && method === 'POST') {
    const body = await readJson(req);
    const address = String(body.address ?? '').trim();
    const code = String(body.code ?? '').replace(/\s/g, '');
    if (!/^(\[[0-9a-fA-F:.%\w]+\]|[\w.\-]+):\d{1,5}$/.test(address)) {
      return sendJson(res, 400, { error: 'Địa chỉ ghép đôi phải có dạng IP:cổng, ví dụ 192.168.1.23:37159' });
    }
    if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'Mã ghép đôi gồm 6 chữ số' });
    let paired;
    try {
      paired = await adb.pair(address, code);
    } catch (err) {
      return sendJson(res, 502, { error: translateAdbError(err.message), detail: err.message });
    }
    console.log(`[adb] ${paired.message}`);
    const result = await connectPaired(paired.guid);
    return sendJson(res, 200, { ok: true, message: paired.message, ...result });
  }

  if (pathname === '/api/adb/disconnect' && method === 'POST') {
    const { address } = await readJson(req);
    if (!SERIAL_RE.test(String(address ?? ''))) return sendJson(res, 400, { error: 'Địa chỉ không hợp lệ' });
    const message = await adb.disconnectDevice(String(address));
    return sendJson(res, 200, { ok: true, message });
  }

  let m = /^\/api\/devices\/([^/]+)\/(tcpip|upload)$/.exec(pathname);
  if (m && method === 'POST') {
    const serial = decodeURIComponent(m[1]);
    checkSerial(serial);

    if (m[2] === 'tcpip') {
      // Find the Wi-Fi IP first: the connection may drop when adbd restarts.
      const route = await adb.shell(serial, 'ip -f inet addr show wlan0 2>/dev/null; ip route 2>/dev/null', { timeoutMs: 5000 });
      const ip = /inet (\d+\.\d+\.\d+\.\d+)/.exec(route)?.[1] ?? /src (\d+\.\d+\.\d+\.\d+)/.exec(route)?.[1] ?? null;
      const { socket, reader } = await adb.openDeviceService(serial, 'tcpip:5555');
      const message = (await reader.readToEnd().catch(() => Buffer.alloc(0))).toString('utf8').trim();
      socket.destroy();
      return sendJson(res, 200, { ok: true, ip, port: 5555, message });
    }

    // upload: raw body, ?name=<file name>
    const name = safeFileName(url.searchParams.get('name'));
    const length = Number(req.headers['content-length'] || 0);
    if (length > config.maxUploadBytes) return sendJson(res, 413, { error: 'File quá lớn' });
    let received = 0;
    async function* body() {
      for await (const chunk of req) {
        received += chunk.length;
        if (received > config.maxUploadBytes) throw Object.assign(new Error('File quá lớn'), { status: 413 });
        yield chunk;
      }
    }
    if (/\.apk$/i.test(name)) {
      const remote = `/data/local/tmp/std-upload-${crypto.randomBytes(6).toString('hex')}.apk`;
      await adb.push(serial, body(), remote, 0o644);
      const output = await adb.shell(serial, `pm install -r ${shellQuote(remote)}; rm -f ${shellQuote(remote)}`, { timeoutMs: 5 * 60_000 });
      const ok = /Success/.test(output);
      return sendJson(res, ok ? 200 : 500, ok ? { ok, installed: true, output: output.trim() } : { error: output.trim() || 'Cài đặt thất bại' });
    }
    const remote = `/sdcard/Download/${name}`;
    await adb.push(serial, body(), remote, 0o644);
    return sendJson(res, 200, { ok: true, path: remote });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------- server

const handler = async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!auth.hostAllowed(req)) {
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Host không được phép. Thêm vào ALLOWED_HOSTS hoặc đặt ACCESS_PASSWORD.');
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[http] ${req.method} ${url.pathname}:`, err.message);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.destroy();
  }
};

const useTls = config.tlsCert && config.tlsKey;
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
  : http.createServer(handler);

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const reject = (code, text) => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  };
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://x').pathname;
  } catch {}
  if (pathname !== '/ws/stream') return reject(404, 'Not Found');
  if (!auth.hostAllowed(req)) return reject(421, 'Misdirected Request');
  if (!auth.sameOrigin(req)) return reject(403, 'Forbidden');
  if (!auth.isAuthenticated(req)) return reject(401, 'Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleStreamSocket(ws, { adb, devices, jarPath: config.jarPath, clientIp: auth.clientIp(req) });
  });
});

server.listen(config.port, config.host, async () => {
  const proto = useTls ? 'https' : 'http';
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log(`ScreenToDesktop (scrcpy ${SCRCPY_VERSION}) đang chạy: ${proto}://${shownHost}:${config.port}`);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopback && !auth.enabled) {
    console.warn('CẢNH BÁO: đang mở ra mạng mà KHÔNG có mật khẩu. Ai truy cập được cổng này đều điều khiển được điện thoại.');
    console.warn('          Đặt ACCESS_PASSWORD=... để bật đăng nhập.');
  }
  try {
    console.log(`adb server: ${config.adbHost}:${config.adbPort} (version ${await adb.version()}, ${config.adbPath})`);
  } catch (err) {
    console.warn(`Chưa kết nối được adb server: ${err.message}`);
  }
});

const shutdown = () => {
  devices.stop();
  for (const client of wss.clients) client.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
