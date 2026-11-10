// One WebSocket = one scrcpy session.
//
// Client -> server:  text  {"type":"start","serial":"...","options":{...}}
//                    binary  raw control messages (forwarded to the control socket)
// Server -> client:  text  {"type":"status"|"log"|"ready"|"error", ...}
//                    binary  [channel:u8][raw bytes]  channel 0=video 1=audio 2=control
import { WebSocket } from 'ws';
import { startScrcpy } from './scrcpy.js';
import { normalizeLang, t } from './i18n.js';

const CHANNEL = { video: 0, audio: 1, control: 2 };
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

export function handleStreamSocket(ws, { adb, devices, jarPath, clientIp }) {
  let session = null;
  let started = false;
  let closed = false;
  let lang = 'vi';
  const paused = new Set();
  let drainTimer = null;

  const sendJson = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const fail = (message) => {
    sendJson({ type: 'error', message });
    ws.close(1011, 'error'); // details are in the JSON message (close reasons are limited to 123 bytes)
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(drainTimer);
    session?.close();
  };

  const checkDrain = () => {
    if (ws.bufferedAmount > LOW_WATER) return;
    for (const s of paused) s.resume();
    paused.clear();
    clearInterval(drainTimer);
    drainTimer = null;
  };

  const forward = (name, { socket, leftover }) => {
    const channel = CHANNEL[name];
    const send = (chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.allocUnsafe(chunk.length + 1);
      buf[0] = channel;
      chunk.copy(buf, 1);
      ws.send(buf);
      if (ws.bufferedAmount > HIGH_WATER && !paused.has(socket)) {
        // Slow client: stop reading so the device stops pushing; the encoder
        // skips frames instead of building up latency.
        socket.pause();
        paused.add(socket);
        drainTimer ??= setInterval(checkDrain, 10);
      }
    };
    if (leftover?.length) send(leftover);
    socket.on('data', send);
    if (!paused.has(socket)) socket.resume(); // paused by SocketReader.detach()
    socket.on('error', () => {});
    socket.on('close', () => {
      if (!closed) fail(t(lang, 'socketClosed', { name }));
    });
  };

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      const control = session?.control?.socket;
      if (control && !control.destroyed) control.write(Buffer.isBuffer(data) ? data : Buffer.concat(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'stop') {
      ws.close(1000, 'stopped');
      return;
    }
    if (msg.type !== 'start' || started) return;
    started = true;
    lang = normalizeLang(msg.lang);

    const serial = String(msg.serial ?? '');
    const device = devices.get(serial);
    if (!device) return fail(t(lang, 'deviceNotFound'));
    if (device.state !== 'device') return fail(t(lang, 'deviceState', { state: device.state }));

    console.log(`[stream] ${clientIp} -> ${serial}`);
    try {
      session = await startScrcpy({
        adb,
        serial,
        jarPath,
        options: msg.options,
        lang,
        onStatus: (text) => sendJson({ type: 'status', text }),
        onLog: (line) => sendJson({ type: 'log', line }),
      });
    } catch (err) {
      console.warn(`[stream] ${serial}: ${err.message}`);
      return fail(err.message);
    }
    if (closed || ws.readyState !== WebSocket.OPEN) {
      session.close();
      return;
    }
    session.exited.then((logs) => {
      if (!closed) fail(logs.split('\n').filter((l) => /ERROR|Exception/.test(l)).slice(-3).join('\n') || t(lang, 'serverStopped'));
    });
    sendJson({ type: 'ready', audio: Boolean(session.audio), control: Boolean(session.control), options: session.options });
    forward('video', session.video);
    if (session.audio) forward('audio', session.audio);
    if (session.control) forward('control', session.control);
  });

  ws.on('close', () => {
    cleanup();
    console.log(`[stream] ${clientIp} closed`);
  });
  ws.on('error', () => cleanup());

  // Keep idle proxies from dropping the connection.
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 30_000);
}
