// H.264 (Annex B) decoding with WebCodecs and low-latency canvas rendering.

/** Splits an Annex B buffer into NAL units (without start codes). */
export function* annexBNalUnits(data) {
  const n = data.length;
  let i = 0;
  let start = -1;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && data[end - 1] === 0) end--; // 4-byte start code
        yield data.subarray(start, end);
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) yield data.subarray(start);
}

/** "avc1.PPCCLL" from the SPS in a config packet, or null. */
export function h264CodecString(config) {
  for (const nal of annexBNalUnits(config)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
    }
  }
  return null;
}

export class CanvasRenderer {
  #pending = null;
  #scheduled = false;
  framesDrawn = 0;

  constructor(canvas, onResize) {
    this.canvas = canvas;
    this.onResize = onResize;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  }

  /** Takes ownership of the frame. Older undrawn frames are dropped. */
  push(frame) {
    this.#pending?.close();
    this.#pending = frame;
    if (!this.#scheduled) {
      this.#scheduled = true;
      requestAnimationFrame(() => this.#draw());
    }
  }

  #draw() {
    this.#scheduled = false;
    const frame = this.#pending;
    this.#pending = null;
    if (!frame) return;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.onResize?.(w, h);
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.framesDrawn++;
  }

  dispose() {
    this.#pending?.close();
    this.#pending = null;
  }
}

export class H264Decoder {
  #decoder = null;
  #config = null; // last config packet (SPS/PPS)
  #codec = null;
  #pendingConfig = null; // prepended to the next key frame
  #needKeyFrame = true;
  #onError;
  framesDecoded = 0;

  /**
   * hardware=false (default) asks for software decoding: some hardware decoders
   * (e.g. D3D11 on Windows) hold back several frames, which adds latency and
   * leaves the last frames of a static screen undisplayed.
   */
  constructor(renderer, { onError, onNeedKeyFrame, hardware = false } = {}) {
    this.renderer = renderer;
    this.#onError = onError;
    this.onNeedKeyFrame = onNeedKeyFrame;
    this.hardwareAcceleration = hardware ? 'no-preference' : 'prefer-software';
  }

  static get supported() {
    return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
  }

  #create() {
    this.#decoder = new VideoDecoder({
      output: (frame) => {
        this.framesDecoded++;
        this.renderer.push(frame);
      },
      error: (err) => {
        if (err?.name === 'NotSupportedError' && this.hardwareAcceleration === 'prefer-software') {
          // e.g. Safari: no software H.264 decoder, use whatever is available
          this.hardwareAcceleration = 'no-preference';
        } else {
          console.warn('[video] decoder error', err);
        }
        this.#recover(err);
      },
    });
  }

  #recover(err) {
    try {
      if (this.#decoder?.state !== 'closed') this.#decoder?.close();
    } catch {}
    this.#decoder = null;
    this.#needKeyFrame = true;
    if (this.#config) {
      try {
        this.#configure(this.#config);
      } catch (e) {
        this.#onError?.(e);
        return;
      }
    }
    // Ask the device for a new key frame (restarts the encoding session).
    this.onNeedKeyFrame?.(err);
  }

  #configure(config) {
    const codec = h264CodecString(config);
    if (!codec) throw new Error('Config packet không chứa SPS H.264');
    if (!this.#decoder) this.#create();
    this.#decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: this.hardwareAcceleration });
    this.#codec = codec;
    this.#pendingConfig = config;
    this.#needKeyFrame = true;
  }

  get codec() {
    return this.#codec;
  }

  get queueSize() {
    return this.#decoder?.decodeQueueSize ?? 0;
  }

  /** Feeds one scrcpy packet. */
  push({ config, keyFrame, pts, data }) {
    if (config) {
      this.#config = data.slice();
      this.#configure(this.#config);
      return;
    }
    if (!this.#decoder || this.#decoder.state !== 'configured') return;
    if (this.#needKeyFrame && !keyFrame) return;

    let payload = data;
    if (this.#pendingConfig && keyFrame) {
      payload = new Uint8Array(this.#pendingConfig.length + data.length);
      payload.set(this.#pendingConfig, 0);
      payload.set(data, this.#pendingConfig.length);
      this.#pendingConfig = null;
    }
    this.#needKeyFrame = false;
    this.#decoder.decode(new EncodedVideoChunk({ type: keyFrame ? 'key' : 'delta', timestamp: pts, data: payload }));
  }

  dispose() {
    try {
      if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close();
    } catch {}
    this.#decoder = null;
  }
}
