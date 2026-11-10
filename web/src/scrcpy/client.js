// Transport-independent scrcpy client: parses the device streams, decodes
// and renders video, plays audio and encodes control messages.
//
// `conn` (from a transport):
//   video: ByteQueue, audio: ByteQueue|null, controlIn: ByteQueue|null,
//   writeControl(Uint8Array), close()
import { u16, u32, StreamClosedError } from './byte-queue.js';
import { CODEC_ID } from '../shared/scrcpy-options.js';
import { CanvasRenderer, H264Decoder } from './video.js';
import { AudioPlayer } from './audio.js';
import * as C from './control.js';
import { AKEY } from './keycodes.js';

const textDecoder = new TextDecoder();
const FLAG_SESSION = 0x80000000;
const FLAG_CONFIG = 0x40000000;
const FLAG_KEY_FRAME = 0x20000000;
const PTS_HIGH_MASK = 0x1fffffff;

export function parsePacketHeader(h) {
  const hi = u32(h, 0);
  return {
    config: (hi & FLAG_CONFIG) !== 0,
    keyFrame: (hi & FLAG_KEY_FRAME) !== 0,
    pts: (hi & PTS_HIGH_MASK) * 0x100000000 + u32(h, 4),
    length: u32(h, 8),
  };
}

export class ScrcpyClient extends EventTarget {
  #conn;
  #closed = false;
  #lastReset = 0;
  #statsTimer = null;
  #lastStats = { time: performance.now(), frames: 0, bytes: 0 };
  deviceName = '';
  videoSize = null; // { width, height } of the current encoding session
  audioState = 'off'; // off | playing | unsupported | error
  closeReason = null;

  constructor(conn, { canvas, audioContext = null, options = {} }) {
    super();
    this.#conn = conn;
    this.options = options;
    this.canvas = canvas;
    this.renderer = new CanvasRenderer(canvas, () => this.#emit('framesize'));
    this.decoder = new H264Decoder(this.renderer, {
      onError: (err) => this.close(err),
      onNeedKeyFrame: () => this.resetVideo(),
      hardware: Boolean(options.hardwareDecoding),
    });
    this.audio = conn.audio && audioContext ? new AudioPlayer(audioContext) : null;

    this.closed = new Promise((resolve) => {
      this.addEventListener('close', () => resolve(this.closeReason), { once: true });
    });

    this.#videoLoop().catch((err) => this.close(err));
    if (conn.audio) this.#audioLoop().catch((err) => console.warn('[audio]', err));
    if (conn.controlIn) this.#deviceMessageLoop().catch((err) => this.close(err));

    this.#statsTimer = setInterval(() => this.#stats(), 1000);
    if (options.turnScreenOff) this.setDisplayPower(false);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #stats() {
    const now = performance.now();
    const frames = this.renderer.framesDrawn;
    const bytes = this.#conn.video.bytesIn;
    const dt = (now - this.#lastStats.time) / 1000;
    const fps = (frames - this.#lastStats.frames) / dt;
    const kbps = ((bytes - this.#lastStats.bytes) * 8) / 1000 / dt;
    this.#lastStats = { time: now, frames, bytes };
    this.#emit('stats', { fps, kbps, size: this.videoSize, codec: this.decoder.codec });
  }

  async #videoLoop() {
    const q = this.#conn.video;
    const meta = await q.read(64);
    const nul = meta.indexOf(0);
    this.deviceName = textDecoder.decode(meta.subarray(0, nul < 0 ? 64 : nul));
    this.#emit('devicename', this.deviceName);

    const codecId = u32(await q.read(4), 0);
    if (codecId === 0) throw new Error('Thiết bị đã tắt luồng video');
    if (codecId === 1) throw new Error('Lỗi cấu hình trên thiết bị (xem log)');
    if (codecId !== CODEC_ID.H264) throw new Error(`Codec video không hỗ trợ: 0x${codecId.toString(16)}`);

    for (;;) {
      const h = await q.read(12);
      if (u32(h, 0) & FLAG_SESSION) {
        this.videoSize = { width: u32(h, 4), height: u32(h, 8) };
        this.#emit('resize', this.videoSize);
        continue;
      }
      const p = parsePacketHeader(h);
      const data = await q.read(p.length);
      this.decoder.push({ config: p.config, keyFrame: p.keyFrame, pts: p.pts, data });
    }
  }

  async #audioLoop() {
    const q = this.#conn.audio;
    const codecId = u32(await q.read(4), 0);
    if (codecId === 0) {
      this.audioState = 'unsupported';
      this.#emit('audio', { state: this.audioState, message: 'Thiết bị không hỗ trợ chuyển âm thanh (cần Android 11+)' });
      return;
    }
    if (codecId === 1) {
      this.audioState = 'error';
      this.#emit('audio', { state: this.audioState, message: 'Không bắt được âm thanh trên thiết bị' });
      return;
    }
    const codec = codecId === CODEC_ID.OPUS ? 'opus' : codecId === CODEC_ID.RAW ? 'raw' : null;
    if (!codec || !this.audio) {
      this.audioState = 'error';
      this.#emit('audio', { state: this.audioState, message: 'Codec âm thanh không hỗ trợ' });
    } else {
      this.audioState = 'playing';
      this.#emit('audio', { state: this.audioState });
    }
    for (;;) {
      const p = parsePacketHeader(await q.read(12));
      const data = await q.read(p.length);
      if (this.audioState === 'playing') this.audio.push(codec, { config: p.config, pts: p.pts, data });
    }
  }

  async #deviceMessageLoop() {
    const q = this.#conn.controlIn;
    for (;;) {
      const type = (await q.read(1))[0];
      if (type === 0) {
        const len = u32(await q.read(4), 0);
        const text = textDecoder.decode(await q.read(len));
        this.#emit('clipboard', text);
      } else if (type === 1) {
        await q.read(8); // ACK_CLIPBOARD sequence
      } else if (type === 2) {
        await q.read(2); // UHID_OUTPUT id
        const size = u16(await q.read(2), 0);
        await q.read(size);
      } else {
        throw new Error(`Thông điệp thiết bị không xác định: ${type}`);
      }
    }
  }

  // ------------------------------------------------------------ control

  send(bytes) {
    if (this.#closed || !this.options.control) return;
    try {
      this.#conn.writeControl(bytes);
    } catch (err) {
      console.warn('[control]', err);
    }
  }

  keyDown(keycode, metaState = 0, repeat = 0) {
    this.send(C.injectKeycode(C.KEY_ACTION.DOWN, keycode, repeat, metaState));
  }

  keyUp(keycode, metaState = 0) {
    this.send(C.injectKeycode(C.KEY_ACTION.UP, keycode, 0, metaState));
  }

  pressKey(keycode, metaState = 0) {
    this.keyDown(keycode, metaState);
    this.keyUp(keycode, metaState);
  }

  /** x, y in video coordinates. */
  touch(action, pointerId, x, y, pressure = 1) {
    if (!this.videoSize) return;
    const { width, height } = this.videoSize;
    this.send(C.injectTouch({ action, pointerId, x, y, width, height, pressure: action === C.MOTION_ACTION.UP ? 0 : pressure }));
  }

  scroll(x, y, hScroll, vScroll) {
    if (!this.videoSize) return;
    const { width, height } = this.videoSize;
    this.send(C.injectScroll({ x, y, width, height, hScroll, vScroll }));
  }

  /** BACK, or turn the screen on if it is off. */
  back() {
    this.send(C.backOrScreenOn(C.KEY_ACTION.DOWN));
    this.send(C.backOrScreenOn(C.KEY_ACTION.UP));
  }

  home() {
    this.pressKey(AKEY.HOME);
  }

  /** ASCII is injected as key events; anything else goes through the clipboard. */
  typeText(text) {
    if (!text) return;
    if (/^[\x20-\x7e]*$/.test(text)) {
      for (let i = 0; i < text.length; i += C.INJECT_TEXT_MAX_BYTES) {
        this.send(C.injectText(text.slice(i, i + C.INJECT_TEXT_MAX_BYTES)));
      }
    } else {
      this.paste(text);
    }
  }

  /** Puts text in the device clipboard and pastes it. */
  paste(text) {
    this.send(C.setClipboard(text, true));
  }

  setClipboard(text) {
    this.send(C.setClipboard(text, false));
  }

  setDisplayPower(on) {
    this.send(C.setDisplayPower(on));
  }

  rotate() {
    this.send(C.simple(C.MSG.ROTATE_DEVICE));
  }

  expandNotifications() {
    this.send(C.simple(C.MSG.EXPAND_NOTIFICATION_PANEL));
  }

  expandSettings() {
    this.send(C.simple(C.MSG.EXPAND_SETTINGS_PANEL));
  }

  collapsePanels() {
    this.send(C.simple(C.MSG.COLLAPSE_PANELS));
  }

  startApp(name) {
    this.send(C.startApp(name));
  }

  scanFile(path) {
    this.send(C.scanFile(path));
  }

  /** Restarts the encoding session (new config + key frame). Throttled. */
  resetVideo() {
    const now = performance.now();
    if (now - this.#lastReset < 1000) return;
    this.#lastReset = now;
    this.send(C.simple(C.MSG.RESET_VIDEO));
  }

  set muted(value) {
    if (this.audio) this.audio.muted = value;
  }

  get muted() {
    return this.audio?.muted ?? true;
  }

  screenshot() {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  close(reason = null) {
    if (this.#closed) return;
    this.#closed = true;
    if (reason instanceof StreamClosedError) reason = this.#conn.error ? new Error(this.#conn.error) : null;
    this.closeReason = reason;
    clearInterval(this.#statsTimer);
    try {
      this.#conn.close();
    } catch {}
    this.decoder.dispose();
    this.renderer.dispose();
    this.audio?.dispose();
    this.#emit('close', reason);
  }
}
