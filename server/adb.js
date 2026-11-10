// Minimal client for the ADB host protocol (the adb server on tcp:5037).
// Docs: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/dev/services.md
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export class AdbError extends Error {
  /** code/params let the HTTP layer translate our own errors (see i18n.js). */
  constructor(message, code = null, params = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

/** Buffered async reader on top of a net.Socket. */
export class SocketReader {
  #chunks = [];
  #length = 0;
  #ended = false;
  #error = null;
  #waiter = null;

  constructor(socket) {
    this.socket = socket;
    this.onData = (chunk) => {
      this.#chunks.push(chunk);
      this.#length += chunk.length;
      this.#wake();
    };
    this.onEnd = () => {
      this.#ended = true;
      this.#wake();
    };
    this.onError = (err) => {
      this.#error = err;
      this.#wake();
    };
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  #wake() {
    const w = this.#waiter;
    this.#waiter = null;
    w?.();
  }

  #wait() {
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  #take(n) {
    const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#length);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.#chunks = rest.length ? [rest] : [];
    this.#length = rest.length;
    return out;
  }

  async read(n) {
    while (this.#length < n) {
      if (this.#error) throw this.#error;
      if (this.#ended) throw new AdbError('Connection closed by adb');
      await this.#wait();
    }
    return this.#take(n);
  }

  async readToEnd() {
    while (!this.#ended && !this.#error) await this.#wait();
    if (this.#error && this.#length === 0) throw this.#error;
    return this.#take(this.#length);
  }

  /**
   * Stops buffering and returns whatever was buffered but not read.
   * The socket is left paused so no data is lost before the caller attaches
   * its own 'data' listener; the caller must call socket.resume().
   */
  detach() {
    this.socket.pause();
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
    return this.#take(this.#length);
  }
}

function encodeRequest(service) {
  const payload = Buffer.from(service, 'utf8');
  return Buffer.concat([Buffer.from(payload.length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

async function readHexString(reader) {
  const len = parseInt((await reader.read(4)).toString('ascii'), 16);
  if (Number.isNaN(len)) throw new AdbError('Malformed adb response');
  return (await reader.read(len)).toString('utf8');
}

async function readStatus(reader) {
  const status = (await reader.read(4)).toString('ascii');
  if (status === 'OKAY') return;
  if (status === 'FAIL') throw new AdbError(await readHexString(reader));
  throw new AdbError(`Unexpected adb response: ${JSON.stringify(status)}`);
}

const KNOWN_STATES = [
  'device', 'offline', 'unauthorized', 'authorizing', 'connecting', 'bootloader',
  'recovery', 'sideload', 'rescue', 'host', 'detached', 'no permissions',
];

/** Parses the output of host:devices-l / host:track-devices-l. */
export function parseDeviceList(text) {
  const devices = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\S+)\s+(.*)$/.exec(trimmed);
    if (!m) continue;
    const [, serial, rest] = m;
    const state = KNOWN_STATES.find((s) => rest.startsWith(s)) ?? rest.split(/\s+/)[0];
    const props = {};
    if (state !== 'no permissions') {
      for (const [, k, v] of rest.slice(state.length).matchAll(/(\w+):(\S+)/g)) props[k] = v;
    }
    devices.push({
      serial,
      state,
      product: props.product ?? null,
      model: props.model ? props.model.replace(/_/g, ' ') : null,
      device: props.device ?? null,
      transportId: props.transport_id ?? null,
      usb: props.usb ?? null,
    });
  }
  return devices;
}

/**
 * Parses the output of host:mdns:services ("instance\tservice\tip:port" lines).
 * _adb-tls-pairing: a phone showing "Pair device with pairing code"
 * _adb-tls-connect: a phone with Wireless debugging on (instance name = its guid)
 */
export function parseMdnsServices(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const [instance, rawService, address] = parts;
    const service = rawService.replace(/\.$/, '');
    const type = service.startsWith('_adb-tls-pairing')
      ? 'pairing'
      : service.startsWith('_adb-tls-connect')
        ? 'connect'
        : service.startsWith('_adb.')
          ? 'legacy'
          : 'other';
    const hint = /^adb-(.+)-[A-Za-z0-9]+$/.exec(instance);
    out.push({ instance, service, address, type, serialHint: hint?.[1] ?? null });
  }
  return out;
}

export class AdbClient {
  #startPromise = null;

  constructor({ host = '127.0.0.1', port = 5037, adbPath = 'adb' } = {}) {
    this.host = host;
    this.port = port;
    this.adbPath = adbPath;
  }

  #rawConnect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const onError = (err) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        socket.setNoDelay(true);
        resolve(socket);
      });
    });
  }

  /** Starts the local adb server (`adb start-server`). */
  startServer() {
    this.#startPromise ??= new Promise((resolve, reject) => {
      const child = spawn(this.adbPath, ['start-server'], { stdio: 'ignore', windowsHide: true });
      child.once('error', (err) => {
        reject(
          err.code === 'ENOENT'
            ? new AdbError(`adb not found ("${this.adbPath}")`, 'ADB_NOT_FOUND', { path: this.adbPath })
            : err,
        );
      });
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new AdbError(`adb start-server exited with ${code}`))));
    }).finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async connect() {
    try {
      return await this.#rawConnect();
    } catch (err) {
      const local = ['127.0.0.1', 'localhost', '::1'].includes(this.host);
      if (err.code !== 'ECONNREFUSED' || !local) throw err;
      await this.startServer();
      return await this.#rawConnect();
    }
  }

  /** Opens a host service and returns the socket after OKAY. */
  async openHostService(service) {
    const socket = await this.connect();
    const reader = new SocketReader(socket);
    try {
      socket.write(encodeRequest(service));
      await readStatus(reader);
      return { socket, reader };
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  /** Runs a host service that answers with one length-prefixed string. */
  async hostQuery(service) {
    const { socket, reader } = await this.openHostService(service);
    try {
      return await readHexString(reader);
    } finally {
      socket.destroy();
    }
  }

  async version() {
    return parseInt(await this.hostQuery('host:version'), 16);
  }

  async devices() {
    return parseDeviceList(await this.hostQuery('host:devices-l'));
  }

  /** `adb connect host:port` — returns adb's message. */
  async connectDevice(address) {
    return this.hostQuery(`host:connect:${address}`);
  }

  async disconnectDevice(address) {
    return this.hostQuery(`host:disconnect:${address}`);
  }

  /**
   * `adb pair host:port code` (Android 11+ Wireless debugging).
   * The adb server answers OKAY, then either a length-prefixed success
   * message or FAIL + reason. Returns { message, guid }.
   */
  async pair(address, code, { timeoutMs = 45_000 } = {}) {
    const { socket, reader } = await this.openHostService(`host:pair:${code}:${address}`);
    const timer = setTimeout(() => socket.destroy(new AdbError('Pairing timed out', 'PAIR_TIMEOUT')), timeoutMs);
    try {
      const head = (await reader.read(4)).toString('ascii');
      if (head === 'FAIL') throw new AdbError(await readHexString(reader));
      const len = parseInt(head, 16);
      if (Number.isNaN(len)) throw new AdbError('Malformed adb response');
      const message = (await reader.read(len)).toString('utf8');
      return { message, guid: /\[guid=([^\]]+)\]/.exec(message)?.[1] ?? null };
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }

  /** Whether the adb server has mDNS discovery enabled. */
  async mdnsAvailable() {
    return !/ERROR|disabled/i.test(await this.hostQuery('host:mdns:check'));
  }

  async mdnsServices() {
    return parseMdnsServices(await this.hostQuery('host:mdns:services'));
  }

  /**
   * Opens a service on a device (shell:, sync:, localabstract:, tcpip:...).
   * Returns { socket, reader }; call reader.detach() before piping the socket.
   */
  async openDeviceService(serial, service) {
    const socket = await this.connect();
    const reader = new SocketReader(socket);
    try {
      socket.write(encodeRequest(`host:transport:${serial}`));
      await readStatus(reader);
      socket.write(encodeRequest(service));
      await readStatus(reader);
      return { socket, reader };
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  /** Runs a shell command and returns its combined output. */
  async shell(serial, command, { timeoutMs = 30_000 } = {}) {
    const { socket, reader } = await this.openDeviceService(serial, `shell:${command}`);
    const timer = setTimeout(() => socket.destroy(new AdbError('Shell command timed out')), timeoutMs);
    try {
      return (await reader.readToEnd()).toString('utf8');
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }

  /**
   * Pushes data to the device with the sync protocol.
   * `source` is a Buffer or an (async) iterable of Buffers (e.g. a fs/http stream).
   */
  async push(serial, source, remotePath, mode = 0o644) {
    const { socket, reader } = await this.openDeviceService(serial, 'sync:');
    const header = (id, len) => {
      const b = Buffer.allocUnsafe(8);
      b.write(id, 0, 4, 'ascii');
      b.writeUInt32LE(len, 4);
      return b;
    };
    const write = async (buf) => {
      if (socket.destroyed) throw new AdbError('adb sync connection closed');
      if (!socket.write(buf)) await once(socket, 'drain');
    };
    try {
      const pathAndMode = Buffer.from(`${remotePath},${0o100000 | mode}`, 'utf8');
      await write(Buffer.concat([header('SEND', pathAndMode.length), pathAndMode]));
      const MAX = 64 * 1024;
      const chunks = Buffer.isBuffer(source) ? [source] : source;
      for await (const chunk of chunks) {
        for (let off = 0; off < chunk.length; off += MAX) {
          const part = chunk.subarray(off, off + MAX);
          await write(Buffer.concat([header('DATA', part.length), part]));
        }
      }
      await write(header('DONE', Math.floor(Date.now() / 1000)));
      const resp = await reader.read(8);
      const id = resp.toString('ascii', 0, 4);
      const len = resp.readUInt32LE(4);
      if (id === 'FAIL') throw new AdbError((await reader.read(len)).toString('utf8'));
      if (id !== 'OKAY') throw new AdbError(`Unexpected sync response: ${id}`);
      socket.write(header('QUIT', 0));
    } finally {
      socket.destroy();
    }
  }

  /**
   * Streams device list changes. Calls onChange(devices) on every update and
   * reconnects automatically. Returns a stop() function.
   */
  trackDevices(onChange, onError = () => {}) {
    let stopped = false;
    let current = null;
    const loop = async () => {
      while (!stopped) {
        try {
          const { socket, reader } = await this.openHostService('host:track-devices-l');
          current = socket;
          while (!stopped) onChange(parseDeviceList(await readHexString(reader)));
        } catch (err) {
          if (stopped) break;
          onError(err);
          onChange([]);
          await new Promise((r) => setTimeout(r, 2000));
        } finally {
          current?.destroy();
          current = null;
        }
      }
    };
    loop();
    return () => {
      stopped = true;
      current?.destroy();
    };
  }
}
