// Starts scrcpy-server on a device and opens its sockets through adb.
import fs from 'node:fs';
import {
  DEVICE_SERVER_PATH,
  buildServerCommand,
  normalizeOptions,
  randomScid,
  socketService,
} from '../web/src/shared/scrcpy-options.js';
import { t } from './i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @returns {Promise<{
 *   video: {socket, leftover}, audio: {socket, leftover}|null, control: {socket, leftover}|null,
 *   options, close(): void, exited: Promise<string>
 * }>}
 */
export async function startScrcpy({ adb, serial, jarPath, options, lang = 'vi', onStatus = () => {}, onLog = () => {} }) {
  const opts = normalizeOptions(options);

  onStatus(t(lang, 'pushing'));
  await adb.push(serial, fs.createReadStream(jarPath), DEVICE_SERVER_PATH, 0o644);

  const scid = randomScid();
  const command = buildServerCommand(scid, opts);
  onStatus(t(lang, 'starting'));
  const shell = await adb.openDeviceService(serial, `shell:${command}`);

  // Collect server output (logs and fatal errors).
  const logLines = [];
  let shellEnded = false;
  let partial = '';
  const handleOutput = (chunk) => {
    partial += chunk.toString('utf8');
    const lines = partial.split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      logLines.push(line);
      if (logLines.length > 50) logLines.shift();
      onLog(line);
    }
  };
  const early = shell.reader.detach();
  if (early.length) handleOutput(early);
  shell.socket.on('data', handleOutput);
  shell.socket.resume();
  const exited = new Promise((resolve) => {
    shell.socket.once('close', () => {
      shellEnded = true;
      if (partial.trim()) logLines.push(partial);
      resolve(logLines.join('\n'));
    });
  });
  shell.socket.on('error', () => {});

  const opened = [];
  const closeAll = () => {
    for (const s of opened) s.destroy();
    shell.socket.destroy();
  };

  const service = socketService(scid);
  const failure = () => {
    const errors = logLines.filter((l) => /ERROR|Exception|error:/i.test(l));
    return new Error(errors.length ? errors.slice(-3).join('\n') : t(lang, 'serverExited'));
  };

  try {
    // The first socket is retried until the server listens; it receives a dummy byte.
    let first = null;
    const deadline = Date.now() + 15_000;
    while (!first) {
      if (shellEnded) {
        await sleep(50); // let the last output arrive
        throw failure();
      }
      if (Date.now() > deadline) throw new Error(t(lang, 'serverTimeout'));
      try {
        const conn = await adb.openDeviceService(serial, service);
        try {
          await withTimeout(conn.reader.read(1), 2000, 'no dummy byte');
          first = conn;
        } catch {
          conn.socket.destroy();
        }
      } catch {
        // not listening yet
      }
      if (!first) await sleep(100);
    }
    opened.push(first.socket);
    const video = { socket: first.socket, leftover: first.reader.detach() };

    const openNext = async () => {
      const conn = await adb.openDeviceService(serial, service);
      opened.push(conn.socket);
      return { socket: conn.socket, leftover: conn.reader.detach() };
    };
    const audio = opts.audio ? await openNext() : null;
    const control = opts.control ? await openNext() : null;

    return { video, audio, control, options: opts, close: closeAll, exited, logs: logLines };
  } catch (err) {
    closeAll();
    throw err;
  }
}
