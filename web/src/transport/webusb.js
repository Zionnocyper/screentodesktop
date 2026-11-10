// Devices plugged into the viewer's own computer, driven from the browser via
// WebUSB (Chromium only, needs HTTPS or localhost). Uses Tango (ya-webadb)
// for the ADB protocol; scrcpy handling is shared with the server mode.
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { ReadableStream } from '@yume-chan/stream-extra';
import { ByteQueue } from '../scrcpy/byte-queue.js';
import {
  DEVICE_SERVER_PATH,
  SERVER_FILENAME,
  buildServerCommand,
  normalizeOptions,
  randomScid,
  socketService,
} from '../shared/scrcpy-options.js';

export const usbManager = AdbDaemonWebUsbDeviceManager.BROWSER;
export const webUsbAvailable = Boolean(usbManager) && window.isSecureContext;

const credentialStore = new AdbWebCredentialStore('ScreenToDesktop');
const adbConnections = new Map(); // serial -> Promise<Adb>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let jarPromise = null;
function fetchServerJar() {
  jarPromise ??= fetch(new URL(SERVER_FILENAME, document.baseURI))
    .then((res) => {
      if (!res.ok) throw new Error(`Không tải được ${SERVER_FILENAME} (HTTP ${res.status})`);
      return res.arrayBuffer();
    })
    .then((buf) => new Uint8Array(buf))
    .catch((err) => {
      jarPromise = null;
      throw err;
    });
  return jarPromise;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function bytesStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAll(socket) {
  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function safeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  return base.replace(/[\x00-\x1f,"'`$\\]/g, '_').replace(/^\.+/, '_').slice(0, 180) || 'file';
}

export async function requestUsbDevice() {
  return usbManager.requestDevice();
}

export async function listUsbDevices() {
  if (!webUsbAvailable) return [];
  return usbManager.getDevices();
}

export class UsbDevice {
  kind = 'usb';

  constructor(device) {
    this.device = device; // AdbDaemonWebUsbDevice
    this.serial = device.serial;
    this.id = `usb:${device.serial}`;
    this.name = device.name || device.serial;
    this.state = 'device';
  }

  get connected() {
    return adbConnections.has(this.serial);
  }

  async adb(onStatus = () => {}) {
    let promise = adbConnections.get(this.serial);
    if (!promise) {
      promise = (async () => {
        onStatus('Đang mở thiết bị USB…');
        let connection;
        try {
          connection = await this.device.connect();
        } catch (err) {
          if (err instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
            throw new Error('Thiết bị đang bị chương trình khác giữ (thường là adb). Chạy "adb kill-server" rồi thử lại.');
          }
          throw err;
        }
        onStatus('Đang xác thực ADB… Hãy bấm "Cho phép" trên điện thoại nếu được hỏi.');
        const transport = await AdbDaemonTransport.authenticate({
          serial: this.serial,
          connection,
          credentialStore,
        });
        const adb = new Adb(transport);
        adb.disconnected.then(() => adbConnections.delete(this.serial));
        return adb;
      })();
      adbConnections.set(this.serial, promise);
      promise.catch(() => adbConnections.delete(this.serial));
    }
    return promise;
  }

  async disconnect() {
    const promise = adbConnections.get(this.serial);
    adbConnections.delete(this.serial);
    if (promise) await (await promise.catch(() => null))?.close();
  }

  async #push(adb, file, path) {
    const sync = await adb.sync();
    try {
      await sync.write({ filename: path, file, permission: 0o644 });
    } finally {
      await sync.dispose();
    }
  }

  async openStream(input, { onStatus = () => {}, onLog = () => {} } = {}) {
    const options = normalizeOptions(input);
    const adb = await this.adb(onStatus);

    onStatus('Đang tải scrcpy-server…');
    const jar = await fetchServerJar();
    onStatus('Đang đẩy scrcpy-server lên thiết bị…');
    await this.#push(adb, bytesStream(jar), DEVICE_SERVER_PATH);

    const scid = randomScid();
    onStatus('Đang khởi động server trên thiết bị…');
    const shell = await adb.createSocket(`shell:${buildServerCommand(scid, options)}`);

    const logs = [];
    let shellEnded = false;
    (async () => {
      const reader = shell.readable.getReader();
      const decoder = new TextDecoder();
      let partial = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          partial += decoder.decode(value, { stream: true });
          const lines = partial.split(/\r?\n/);
          partial = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            logs.push(line);
            onLog(line);
          }
        }
      } catch {}
      if (partial.trim()) logs.push(partial);
      shellEnded = true;
    })();

    const sockets = [];
    const closeQuietly = (s) => Promise.resolve().then(() => s.close()).catch(() => {});
    const closeAll = () => {
      for (const s of sockets) closeQuietly(s);
      closeQuietly(shell);
    };

    const service = socketService(scid);
    try {
      // First socket: retry until the server listens; it starts with a dummy byte.
      let video = null;
      const deadline = Date.now() + 15_000;
      while (!video) {
        if (shellEnded) {
          const errors = logs.filter((l) => /ERROR|Exception/i.test(l));
          throw new Error(errors.slice(-3).join('\n') || 'scrcpy-server đã thoát trước khi kết nối');
        }
        if (Date.now() > deadline) throw new Error('Hết thời gian chờ scrcpy-server');
        try {
          const socket = await adb.createSocket(service);
          const reader = socket.readable.getReader();
          try {
            const first = await withTimeout(reader.read(), 2000);
            if (!first.done && first.value?.length) video = { socket, reader, rest: first.value.subarray(1) };
            else await closeQuietly(socket);
          } catch {
            await closeQuietly(socket);
          }
        } catch {
          // not listening yet
        }
        if (!video) await sleep(100);
      }
      sockets.push(video.socket);

      const openNext = async () => {
        const socket = await adb.createSocket(service);
        sockets.push(socket);
        return { socket, reader: socket.readable.getReader(), rest: null };
      };
      const audio = options.audio ? await openNext() : null;
      const control = options.control ? await openNext() : null;

      const conn = {
        video: new ByteQueue(),
        audio: audio ? new ByteQueue() : null,
        controlIn: control ? new ByteQueue() : null,
        error: null,
        writeControl: () => {},
        close: closeAll,
      };

      const pump = async ({ reader, rest }, queue) => {
        if (rest?.length) queue.push(rest);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            queue.push(value);
          }
          queue.end();
        } catch (err) {
          queue.end(err);
        }
      };
      pump(video, conn.video);
      if (audio) pump(audio, conn.audio);
      if (control) {
        pump(control, conn.controlIn);
        const writer = control.socket.writable.getWriter();
        conn.writeControl = (bytes) => {
          writer.write(bytes).catch(() => {});
        };
      }
      return conn;
    } catch (err) {
      closeAll();
      throw err;
    }
  }

  /** APKs are installed, other files go to /sdcard/Download. */
  async upload(file, onProgress = () => {}) {
    const adb = await this.adb();
    let sent = 0;
    const progress = new TransformStream({
      transform(chunk, controller) {
        sent += chunk.length;
        onProgress(file.size ? sent / file.size : 1);
        controller.enqueue(chunk);
      },
    });
    const stream = file.stream().pipeThrough(progress);
    const name = safeFileName(file.name);
    if (/\.apk$/i.test(name)) {
      const remote = `/data/local/tmp/std-upload-${Date.now().toString(36)}.apk`;
      await this.#push(adb, stream, remote);
      const output = await readAll(await adb.createSocket(`shell:pm install -r '${remote}'; rm -f '${remote}'`));
      if (!/Success/.test(output)) throw new Error(output.trim() || 'Cài đặt thất bại');
      return { ok: true, installed: true, output: output.trim() };
    }
    const remote = `/sdcard/Download/${name}`;
    await this.#push(adb, stream, remote);
    return { ok: true, path: remote };
  }
}
