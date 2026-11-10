// End-to-end test of the Node server against a fake adb server that speaks the
// ADB host protocol and impersonates a phone running scrcpy-server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERIAL = 'FAKE123';

// ------------------------------------------------------------ fake adb
const fake = {
  pushedBytes: 0,
  pushedPath: null,
  shellCommand: null,
  listening: false,
  abstractConnections: 0,
  controlReceived: [],
  videoSent: null,
};

function hex4(n) {
  return n.toString(16).padStart(4, '0');
}
function okayString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from('OKAY'), Buffer.from(hex4(b.length)), b]);
}
function fail(s) {
  const b = Buffer.from(s);
  return Buffer.concat([Buffer.from('FAIL'), Buffer.from(hex4(b.length)), b]);
}

function makeVideoStream() {
  const meta = Buffer.alloc(64);
  meta.write('Fake Phone');
  const codec = Buffer.from('h264', 'ascii');
  const session = Buffer.alloc(12);
  session.writeUInt32BE(0x80000000, 0);
  session.writeUInt32BE(1080, 4);
  session.writeUInt32BE(2400, 8);
  const config = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 0, 1, 0x68, 0xee]);
  const cfgHeader = Buffer.alloc(12);
  cfgHeader.writeBigUInt64BE(1n << 62n, 0);
  cfgHeader.writeUInt32BE(config.length, 8);
  const frame = Buffer.alloc(5000, 7);
  const frameHeader = Buffer.alloc(12);
  frameHeader.writeBigUInt64BE((1n << 61n) | 1000n, 0);
  frameHeader.writeUInt32BE(frame.length, 8);
  return Buffer.concat([meta, codec, session, cfgHeader, config, frameHeader, frame]);
}

function handleSync(socket, buffered) {
  let buf = buffered;
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    process();
  });
  const process = () => {
    while (buf.length >= 8) {
      const id = buf.toString('ascii', 0, 4);
      const len = buf.readUInt32LE(4);
      if (id === 'DONE') {
        buf = buf.subarray(8);
        socket.write(Buffer.from('OKAY\0\0\0\0', 'binary'));
        continue;
      }
      if (id === 'QUIT') {
        socket.end();
        return;
      }
      if (buf.length < 8 + len) return;
      const body = buf.subarray(8, 8 + len);
      if (id === 'SEND') fake.pushedPath = body.toString('utf8');
      if (id === 'DATA') fake.pushedBytes += len;
      buf = buf.subarray(8 + len);
    }
  };
  process();
}

function handleDeviceService(socket, service, rest) {
  if (service.startsWith('shell:getprop')) {
    socket.write('OKAY');
    socket.end('FakeCorp\n@@\nFake Phone\n@@\n14\n@@\n34\n');
    return;
  }
  if (service === 'sync:') {
    socket.write('OKAY');
    handleSync(socket, rest);
    return;
  }
  if (service.startsWith('shell:CLASSPATH=')) {
    fake.shellCommand = service.slice(6);
    socket.write('OKAY');
    socket.write('[server] INFO: Device: [FakeCorp] Fake Phone (Android 14)\n');
    setTimeout(() => {
      fake.listening = true;
    }, 300);
    socket.on('close', () => {
      fake.listening = false;
    });
    return;
  }
  if (service.startsWith('localabstract:scrcpy_')) {
    if (!fake.listening) {
      socket.end(fail('closed'));
      return;
    }
    const index = fake.abstractConnections++;
    // Like a real device over USB: opening the later sockets is slow, and data
    // arrives in separate chunks while the server is still opening sockets.
    if (index === 0) {
      socket.write('OKAY');
      fake.videoSent = makeVideoStream();
      socket.write(Buffer.from([0])); // dummy byte
      setTimeout(() => socket.write(fake.videoSent.subarray(0, 70)), 10);
      setTimeout(() => socket.write(fake.videoSent.subarray(70)), 120);
    } else if (index === 1) {
      setTimeout(() => socket.write('OKAY'), 30);
      setTimeout(() => socket.write(Buffer.from([0, 0, 0, 0])), 40); // audio disabled
    } else if (index === 2) {
      setTimeout(() => socket.write('OKAY'), 30);
      socket.on('data', (d) => fake.controlReceived.push(d));
      const text = Buffer.from('copied on phone');
      const msg = Buffer.alloc(5);
      msg[0] = 0;
      msg.writeUInt32BE(text.length, 1);
      setTimeout(() => socket.write(Buffer.concat([msg, text])), 35);
    }
    return;
  }
  socket.end(fail(`unsupported service ${service}`));
}

function startFakeAdb() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let transport = false;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = parseInt(buf.toString('ascii', 0, 4), 16);
        if (buf.length < 4 + len) return;
        const service = buf.toString('utf8', 4, 4 + len);
        buf = buf.subarray(4 + len);
        if (transport) {
          socket.off('data', onData);
          handleDeviceService(socket, service, buf);
          return;
        }
        if (service === 'host:version') socket.end(okayString('0029'));
        else if (service === 'host:devices-l' || service === 'host:track-devices-l') {
          socket.write('OKAY');
          const list = okayString(`${SERIAL}\tdevice product:fake model:Fake_Phone device:fake transport_id:1\n`).subarray(4);
          if (service === 'host:devices-l') socket.end(list);
          else socket.write(list);
        } else if (service === `host:transport:${SERIAL}`) {
          transport = true;
          socket.write('OKAY');
        } else socket.end(fail('device not found'));
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------ app server
let adbServer;
let app;
let port;
let passwordApp;
let passwordPort;

function startApp(adbPort, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(p), HOST: '127.0.0.1', ADB_PORT: String(adbPort), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('đang chạy')) resolve({ child, port: p });
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

before(async () => {
  adbServer = await startFakeAdb();
  const adbPort = adbServer.address().port;
  ({ child: app, port } = await startApp(adbPort));
  ({ child: passwordApp, port: passwordPort } = await startApp(adbPort, { ACCESS_PASSWORD: 's3cret' }));
});

after(() => {
  app?.kill();
  passwordApp?.kill();
  adbServer?.close();
});

const base = () => `http://127.0.0.1:${port}`;

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

test('device list is tracked and enriched with getprop', async () => {
  const devices = await waitFor(async () => {
    const r = await fetch(`${base()}/api/devices`);
    const j = await r.json();
    return j.devices?.[0]?.manufacturer ? j.devices : null;
  });
  assert.equal(devices[0].serial, SERIAL);
  assert.equal(devices[0].state, 'device');
  assert.equal(devices[0].manufacturer, 'FakeCorp');
  assert.equal(devices[0].androidVersion, '14');
});

test('full stream session over WebSocket', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stream`, { origin: base() });
  const channels = { 0: [], 1: [], 2: [] };
  const statuses = [];
  let ready = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) channels[data[0]].push(Buffer.from(data.subarray(1)));
    else {
      const m = JSON.parse(data.toString());
      if (m.type === 'ready') ready = m;
      else if (m.type === 'status') statuses.push(m.text);
      else if (m.type === 'error') statuses.push(`ERROR ${m.message}`);
    }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'start', serial: SERIAL, options: { audio: true, maxSize: 1024 } }));

  await waitFor(() => ready, 10000);
  assert.equal(ready.audio, true);
  assert.equal(ready.control, true);

  // jar pushed with the right path/mode
  assert.equal(fake.pushedPath, `/data/local/tmp/screentodesktop-server.jar,${0o100644}`);
  assert.ok(fake.pushedBytes > 700_000, 'scrcpy-server jar was pushed');
  assert.match(fake.shellCommand, /com\.genymobile\.scrcpy\.Server 5\.0\.1 scid=[0-9a-f]{8} /);
  assert.match(fake.shellCommand, / max_size=1024 /);

  // video bytes relayed exactly, without the dummy byte
  await waitFor(() => Buffer.concat(channels[0]).length >= fake.videoSent.length);
  assert.deepEqual(Buffer.concat(channels[0]), fake.videoSent);
  // audio (disabled marker) and the device clipboard message
  await waitFor(() => Buffer.concat(channels[1]).length === 4 && Buffer.concat(channels[2]).length > 0);
  assert.equal(Buffer.concat(channels[2]).subarray(5).toString(), 'copied on phone');

  // control messages are forwarded to the device
  ws.send(Uint8Array.of(4, 0));
  ws.send(Uint8Array.of(4, 1));
  await waitFor(() => Buffer.concat(fake.controlReceived).length === 4);
  assert.deepEqual([...Buffer.concat(fake.controlReceived)], [4, 0, 4, 1]);

  ws.close();
  await waitFor(() => !fake.listening, 3000); // shell (scrcpy-server) torn down
});

test('cross-origin WebSocket is rejected', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stream`, { origin: 'http://evil.example' });
  const status = await new Promise((resolve) => {
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('open', () => resolve(101));
    ws.on('error', () => {});
  });
  assert.equal(status, 403);
});

test('DNS-rebinding host is rejected when no password is set', async () => {
  const status = await new Promise((resolve) => {
    const req = net.connect(port, '127.0.0.1', () => {
      req.write('GET /api/devices HTTP/1.1\r\nHost: evil.example:1234\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => resolve(Number(data.split(' ')[1])));
  });
  assert.equal(status, 421);
});

test('password protection', async () => {
  const pb = `http://127.0.0.1:${passwordPort}`;
  const session = await (await fetch(`${pb}/api/session`)).json();
  assert.equal(session.authRequired, true);
  assert.equal(session.authenticated, false);
  assert.equal((await fetch(`${pb}/api/devices`)).status, 401);

  const bad = await fetch(`${pb}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: pb }, body: '{"password":"nope"}' });
  assert.equal(bad.status, 401);

  const good = await fetch(`${pb}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: pb }, body: '{"password":"s3cret"}' });
  assert.equal(good.status, 200);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.match(good.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${pb}/api/devices`, { headers: { Cookie: cookie } })).status, 200);

  const wsNoAuth = new WebSocket(`ws://127.0.0.1:${passwordPort}/ws/stream`, { origin: pb });
  const status = await new Promise((resolve) => {
    wsNoAuth.on('unexpected-response', (_, res) => resolve(res.statusCode));
    wsNoAuth.on('open', () => resolve(101));
    wsNoAuth.on('error', () => {});
  });
  assert.equal(status, 401);
});

test('cross-origin POST is rejected', async () => {
  const r = await fetch(`${base()}/api/adb/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{"address":"1.2.3.4"}',
  });
  assert.equal(r.status, 403);
});
