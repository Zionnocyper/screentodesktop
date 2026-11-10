// Plays the scrcpy audio stream (48 kHz stereo) through Web Audio.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const START_LATENCY = 0.06; // seconds of cushion after an underrun
const MAX_LATENCY = 0.3; // drop audio when we are further ahead than this

export async function opusSupported() {
  if (typeof AudioDecoder === 'undefined') return false;
  try {
    const { supported } = await AudioDecoder.isConfigSupported({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
    });
    return Boolean(supported);
  } catch {
    return false;
  }
}

export class AudioPlayer {
  #ctx;
  #gain;
  #nextTime = 0;
  #decoder = null;
  #planes = [];

  /** ctx must be created/resumed from a user gesture. */
  constructor(ctx) {
    this.#ctx = ctx;
    this.#gain = ctx.createGain();
    this.#gain.connect(ctx.destination);
  }

  set muted(value) {
    this.#gain.gain.value = value ? 0 : 1;
  }

  get muted() {
    return this.#gain.gain.value === 0;
  }

  #schedule(buffer) {
    const ctx = this.#ctx;
    const now = ctx.currentTime;
    if (this.#nextTime < now) this.#nextTime = now + START_LATENCY;
    if (this.#nextTime - now > MAX_LATENCY) return; // too far behind real time: drop
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.#gain);
    src.start(this.#nextTime);
    this.#nextTime += buffer.duration;
  }

  #playAudioData(audioData) {
    const frames = audioData.numberOfFrames;
    const channels = Math.min(audioData.numberOfChannels, CHANNELS);
    const buffer = this.#ctx.createBuffer(CHANNELS, frames, audioData.sampleRate);
    for (let ch = 0; ch < CHANNELS; ch++) {
      const src = Math.min(ch, channels - 1);
      if (!this.#planes[ch] || this.#planes[ch].length < frames) this.#planes[ch] = new Float32Array(frames);
      const plane = this.#planes[ch].subarray(0, frames);
      audioData.copyTo(plane, { planeIndex: src, format: 'f32-planar' });
      buffer.copyToChannel(plane, ch);
    }
    audioData.close();
    this.#schedule(buffer);
  }

  #playPcm(data) {
    // signed 16-bit little-endian, interleaved stereo
    const frames = Math.floor(data.length / 4);
    if (!frames) return;
    const dv = new DataView(data.buffer, data.byteOffset, frames * 4);
    const buffer = this.#ctx.createBuffer(CHANNELS, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = dv.getInt16(i * 4, true) / 32768;
      right[i] = dv.getInt16(i * 4 + 2, true) / 32768;
    }
    this.#schedule(buffer);
  }

  /** Feeds one scrcpy packet. codec: 'opus' | 'raw'. */
  push(codec, { config, pts, data }) {
    if (codec === 'raw') {
      if (!config) this.#playPcm(data);
      return;
    }
    if (config) {
      this.#decoder?.close();
      this.#decoder = new AudioDecoder({
        output: (ad) => this.#playAudioData(ad),
        error: (e) => console.warn('[audio] decoder error', e),
      });
      this.#decoder.configure({
        codec: 'opus',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: CHANNELS,
        description: data.slice(),
      });
      return;
    }
    if (this.#decoder?.state === 'configured') {
      this.#decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data }));
    }
  }

  dispose() {
    try {
      if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close();
    } catch {}
    this.#decoder = null;
  }
}
