// Devices attached to the ScreenToDesktop server (adb on the server machine).
import { ByteQueue } from '../scrcpy/byte-queue.js';
import { getLang, t } from '../i18n.js';

const CHANNEL_VIDEO = 0;
const CHANNEL_AUDIO = 1;
const CHANNEL_CONTROL = 2;

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Lang': getLang(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Returns server info, or null when the page is served without the Node server (static hosting). */
export async function getServerSession() {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.server ? data : null;
  } catch {
    return null;
  }
}

export function watchServerDevices(onUpdate, onAuthError) {
  let es = null;
  let stopped = false;
  let retry = null;
  const connect = () => {
    es = new EventSource(`/api/devices/events?lang=${getLang()}`, { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        onUpdate(JSON.parse(ev.data));
      } catch {}
    };
    es.onerror = async () => {
      es.close();
      if (stopped) return;
      const session = await getServerSession();
      if (session?.authRequired && !session.authenticated) {
        onAuthError?.();
        return;
      }
      retry = setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    es?.close();
  };
}

export class ServerDevice {
  kind = 'server';

  constructor(info) {
    this.update(info);
  }

  update(info) {
    this.info = info;
    this.serial = info.serial;
    this.id = `server:${info.serial}`;
    this.state = info.state;
    const brand = info.manufacturer && info.model && !info.model.toLowerCase().startsWith(info.manufacturer.toLowerCase())
      ? `${info.manufacturer} ` : '';
    this.name = info.model ? `${brand}${info.model}` : info.serial;
  }

  /** Opens a scrcpy session relayed by the server over WebSocket. */
  openStream(options, { onStatus = () => {}, onLog = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/stream`);
      ws.binaryType = 'arraybuffer';
      let ready = false;
      const queues = { [CHANNEL_VIDEO]: new ByteQueue(), [CHANNEL_AUDIO]: null, [CHANNEL_CONTROL]: null };
      const conn = {
        video: queues[CHANNEL_VIDEO],
        audio: null,
        controlIn: null,
        error: null,
        writeControl(bytes) {
          if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
        },
        close() {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
          ws.close();
        },
      };

      ws.onopen = () => {
        onStatus(t('tr.askServer'));
        ws.send(JSON.stringify({ type: 'start', serial: this.serial, options, lang: getLang() }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (msg.type === 'status') onStatus(msg.text);
          else if (msg.type === 'log') onLog(msg.line);
          else if (msg.type === 'error') conn.error = msg.message;
          else if (msg.type === 'ready') {
            ready = true;
            if (msg.audio) conn.audio = queues[CHANNEL_AUDIO] = new ByteQueue();
            if (msg.control) conn.controlIn = queues[CHANNEL_CONTROL] = new ByteQueue();
            resolve(conn);
          }
          return;
        }
        const bytes = new Uint8Array(ev.data);
        queues[bytes[0]]?.push(bytes.subarray(1));
      };
      ws.onclose = (ev) => {
        const err = conn.error ? new Error(conn.error) : null;
        for (const q of Object.values(queues)) q?.end(err);
        if (!ready) {
          const reason = conn.error || (ev.code === 1006 ? t('tr.lostServer') : t('tr.wsClosed', { code: ev.code }));
          reject(new Error(reason));
        }
      };
    });
  }

  /** Uploads a file: APKs are installed, other files go to /sdcard/Download. */
  upload(file, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/devices/${encodeURIComponent(this.serial)}/upload?name=${encodeURIComponent(file.name)}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Lang', getLang());
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data?.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error(t('tr.uploadFailed')));
      xhr.send(file);
    });
  }

  async enableWifi() {
    return api(`/api/devices/${encodeURIComponent(this.serial)}/tcpip`, { method: 'POST', body: {} });
  }
}
