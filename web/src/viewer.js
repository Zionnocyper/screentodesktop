// Full-screen viewer: connects a device, renders it and wires the controls.
import { ScrcpyClient } from './scrcpy/client.js';
import { H264Decoder } from './scrcpy/video.js';
import { AKEY } from './scrcpy/keycodes.js';
import { attachInput } from './input.js';
import { icon } from './icons.js';
import { downloadBlob, toast } from './ui.js';

const $ = (id) => document.getElementById(id);

const el = {
  root: $('viewer'),
  name: $('v-name'),
  stats: $('v-stats'),
  stage: $('v-stage'),
  canvas: $('v-canvas'),
  overlay: $('v-overlay'),
  spinner: $('v-spinner'),
  status: $('v-status'),
  log: $('v-log'),
  overlayActions: $('v-overlay-actions'),
  retry: $('v-retry'),
  back: $('v-back'),
  drop: $('v-drop'),
  keys: $('v-keys'),
  file: $('v-file'),
  audio: $('v-audio'),
  close: $('v-close'),
  screenPower: document.querySelector('[data-action="screenPower"]'),
};

let session = null; // { device, options, client, detachInput, audioContext, cancelled, screenOn }
let historyPushed = false;

function setStatus(text, { error = false, busy = true } = {}) {
  el.overlay.hidden = false;
  el.overlay.classList.toggle('error', error);
  el.spinner.hidden = !busy;
  el.status.textContent = text;
  el.overlayActions.hidden = busy;
}

function appendLog(line) {
  el.log.hidden = false;
  el.log.textContent += `${line}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}

function layout() {
  const w = el.canvas.width;
  const h = el.canvas.height;
  if (!w || !h) return;
  const rect = el.stage.getBoundingClientRect();
  const pad = rect.width < 500 ? 8 : 16;
  const scale = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h);
  if (!(scale > 0)) return;
  el.canvas.style.width = `${Math.floor(w * scale)}px`;
  el.canvas.style.height = `${Math.floor(h * scale)}px`;
}
new ResizeObserver(layout).observe(el.stage);

function updateAudioButton() {
  const client = session?.client;
  const playing = client?.audioState === 'playing';
  el.audio.hidden = !playing;
  if (playing) {
    el.audio.innerHTML = icon(client.muted ? 'speakerOff' : 'speaker');
    el.audio.title = client.muted ? 'Bật tiếng' : 'Tắt tiếng';
  }
}

function updateScreenPowerButton() {
  const on = session?.screenOn ?? true;
  el.screenPower.classList.toggle('active', !on);
  el.screenPower.title = on ? 'Tắt màn hình điện thoại (vẫn phản chiếu)' : 'Bật lại màn hình điện thoại';
}

async function uploadFiles(files) {
  const s = session;
  if (!s?.device.upload) return;
  for (const file of files) {
    const t = toast(`Đang gửi ${file.name}…`, { timeout: 0 });
    try {
      const result = await s.device.upload(file, (f) => t.progress(f));
      if (result?.installed) t.done(`Đã cài đặt ${file.name}`);
      else {
        t.done(`Đã lưu vào ${result?.path ?? 'Download'}`);
        if (result?.path) s.client?.scanFile(result.path);
      }
    } catch (err) {
      t.done(`Lỗi khi gửi ${file.name}:\n${err.message}`, 'error');
    }
  }
}

const actions = {
  back: (c) => c.back(),
  home: (c) => c.home(),
  recents: (c) => c.pressKey(AKEY.APP_SWITCH),
  volUp: (c) => c.pressKey(AKEY.VOLUME_UP),
  volDown: (c) => c.pressKey(AKEY.VOLUME_DOWN),
  power: (c) => c.pressKey(AKEY.POWER),
  rotate: (c) => c.rotate(),
  notifications: (c) => c.expandNotifications(),
  quickSettings: (c) => c.expandSettings(),
  screenPower: (c) => {
    session.screenOn = !session.screenOn;
    c.setDisplayPower(session.screenOn);
    updateScreenPowerButton();
  },
  keyboard: () => {
    el.keys.focus();
    toast('Đang nhận phím — gõ để nhập vào điện thoại', { timeout: 2000 });
  },
  paste: async (c) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) c.paste(text);
    } catch {
      toast('Trình duyệt không cho đọc clipboard. Bấm vào màn hình rồi dùng Ctrl+V.', { type: 'error' });
    }
  },
  screenshot: async (c) => {
    const blob = await c.screenshot();
    if (!blob) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(blob, `screenshot-${stamp}.png`);
  },
  upload: () => el.file.click(),
  fullscreen: () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else el.root.requestFullscreen?.().catch(() => {});
  },
};

el.root.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !session) return;
  const name = btn.dataset.action;
  if (name === 'upload' || name === 'fullscreen') return actions[name]();
  if (!session.client) return;
  actions[name]?.(session.client);
  if (name !== 'keyboard' && matchMedia('(pointer: fine)').matches) el.keys.focus({ preventScroll: true });
});

// Browsers keep an AudioContext suspended until a user gesture.
el.root.addEventListener('pointerdown', () => {
  if (session?.audioContext?.state === 'suspended') session.audioContext.resume().catch(() => {});
});

el.audio.addEventListener('click', () => {
  if (!session?.client) return;
  session.client.muted = !session.client.muted;
  updateAudioButton();
});

el.close.addEventListener('click', () => closeViewer());
el.back.addEventListener('click', () => closeViewer());
el.retry.addEventListener('click', () => {
  if (session) openViewer(session.device, session.options);
});
el.file.addEventListener('change', () => {
  const files = [...el.file.files];
  el.file.value = '';
  uploadFiles(files);
});

let dragDepth = 0;
el.stage.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  el.drop.hidden = false;
});
el.stage.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
el.stage.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.drop.hidden = true;
});
el.stage.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) uploadFiles(files);
});

window.addEventListener('popstate', () => {
  if (session) {
    historyPushed = false;
    closeViewer();
  }
});

function teardown() {
  if (!session) return;
  session.cancelled = true;
  session.detachInput?.();
  session.client?.close();
  session.audioContext?.close().catch(() => {});
}

export function closeViewer() {
  teardown();
  session = null;
  el.root.hidden = true;
  document.body.classList.remove('viewing');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (historyPushed) {
    historyPushed = false;
    history.back();
  }
  window.dispatchEvent(new Event('viewer:closed'));
}

/** Must be called from a user gesture (audio needs one). */
export async function openViewer(device, options) {
  teardown();
  const s = { device, options, client: null, detachInput: null, audioContext: null, cancelled: false, screenOn: !options.turnScreenOff };
  session = s;

  el.root.hidden = false;
  document.body.classList.add('viewing');
  if (!historyPushed) {
    history.pushState({ viewer: true }, '');
    historyPushed = true;
  }
  el.name.textContent = device.name;
  el.stats.textContent = '';
  el.log.textContent = '';
  el.log.hidden = true;
  el.canvas.width = 0;
  el.canvas.height = 0;
  el.canvas.style.width = '0px';
  el.canvas.style.height = '0px';
  el.audio.hidden = true;
  updateScreenPowerButton();
  setStatus('Đang kết nối…');

  if (!H264Decoder.supported) {
    setStatus('Trình duyệt không hỗ trợ WebCodecs (VideoDecoder).\nHãy dùng Chrome, Edge, Firefox 130+ hoặc Safari 17+.', { error: true, busy: false });
    return;
  }

  if (options.audio) {
    try {
      s.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      s.audioContext.resume().catch(() => {});
    } catch {
      s.audioContext = null;
    }
  }

  let conn;
  try {
    conn = await device.openStream(options, {
      onStatus: (text) => !s.cancelled && setStatus(text),
      onLog: (line) => !s.cancelled && appendLog(line),
    });
  } catch (err) {
    if (!s.cancelled) setStatus(err.message || String(err), { error: true, busy: false });
    return;
  }
  if (s.cancelled) {
    conn.close();
    return;
  }

  setStatus('Đang chờ khung hình đầu tiên…');
  const client = new ScrcpyClient(conn, { canvas: el.canvas, audioContext: s.audioContext, options });
  s.client = client;

  client.addEventListener('framesize', () => {
    if (s.cancelled) return;
    el.overlay.hidden = true;
    layout();
  });
  client.addEventListener('stats', (e) => {
    const { fps, kbps, size } = e.detail;
    if (!size) return;
    el.stats.textContent = `${size.width}×${size.height} · ${Math.round(fps)} fps · ${(kbps / 1000).toFixed(1)} Mbps`;
  });
  client.addEventListener('audio', (e) => {
    updateAudioButton();
    if (e.detail.message) toast(e.detail.message, { type: e.detail.state === 'error' ? 'error' : 'info' });
  });
  client.addEventListener('clipboard', (e) => {
    if (!options.clipboardAutosync) return;
    navigator.clipboard?.writeText(e.detail).then(
      () => toast('Đã sao chép clipboard từ điện thoại', { timeout: 1800 }),
      () => {},
    );
  });
  client.closed.then((reason) => {
    if (s.cancelled || session !== s) return;
    s.detachInput?.();
    setStatus(reason ? reason.message || String(reason) : 'Phiên đã kết thúc', { error: Boolean(reason), busy: false });
  });

  s.detachInput = attachInput(client, el.canvas, el.keys);
  el.keys.focus({ preventScroll: true });
}
