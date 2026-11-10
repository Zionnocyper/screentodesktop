// Shared between the Node server and the browser.
// Builds the scrcpy-server command line from user options. Every value is
// validated/whitelisted here because the server concatenates the result into
// an `adb shell` command line.

export const SCRCPY_VERSION = '5.0.1';
export const SERVER_FILENAME = `scrcpy-server-v${SCRCPY_VERSION}`;
export const DEVICE_SERVER_PATH = '/data/local/tmp/screentodesktop-server.jar';

export const CODEC_ID = {
  H264: 0x68323634,
  H265: 0x68323635,
  AV1: 0x00617631,
  OPUS: 0x6f707573,
  AAC: 0x00616163,
  FLAC: 0x666c6163,
  RAW: 0x00726177,
};

export const DEFAULT_OPTIONS = Object.freeze({
  maxSize: 1280, // 0 = native resolution
  videoBitRate: 8_000_000,
  maxFps: 60,
  audio: true,
  audioCodec: 'opus', // 'opus' | 'raw'
  audioSource: 'output', // 'output' | 'playback' | 'mic'
  control: true,
  stayAwake: true,
  showTouches: false,
  turnScreenOff: false, // applied by the client after start (control message)
  powerOffOnClose: false,
  powerOn: true,
  clipboardAutosync: true,
  displayId: 0,
  hardwareDecoding: false, // browser-side only
});

const AUDIO_CODECS = ['opus', 'raw'];
const AUDIO_SOURCES = ['output', 'playback', 'mic'];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Returns a sanitized copy of `input` merged over DEFAULT_OPTIONS. */
export function normalizeOptions(input = {}) {
  const d = DEFAULT_OPTIONS;
  const o = input && typeof input === 'object' ? input : {};
  let maxSize = clampInt(o.maxSize, 0, 8192, d.maxSize);
  if (maxSize !== 0 && maxSize < 240) maxSize = 240;
  return {
    maxSize,
    videoBitRate: clampInt(o.videoBitRate, 250_000, 100_000_000, d.videoBitRate),
    maxFps: clampInt(o.maxFps, 1, 240, d.maxFps),
    audio: bool(o.audio, d.audio),
    audioCodec: oneOf(o.audioCodec, AUDIO_CODECS, d.audioCodec),
    audioSource: oneOf(o.audioSource, AUDIO_SOURCES, d.audioSource),
    control: bool(o.control, d.control),
    stayAwake: bool(o.stayAwake, d.stayAwake),
    showTouches: bool(o.showTouches, d.showTouches),
    turnScreenOff: bool(o.turnScreenOff, d.turnScreenOff),
    powerOffOnClose: bool(o.powerOffOnClose, d.powerOffOnClose),
    powerOn: bool(o.powerOn, d.powerOn),
    clipboardAutosync: bool(o.clipboardAutosync, d.clipboardAutosync),
    displayId: clampInt(o.displayId, 0, 1000, d.displayId),
    hardwareDecoding: bool(o.hardwareDecoding, d.hardwareDecoding),
  };
}

/** Random 31-bit session id, as the official client does. */
export function randomScid() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] & 0x7fffffff;
}

export function scidHex(scid) {
  return scid.toString(16).padStart(8, '0');
}

/** ADB service name of the device-side abstract socket. */
export function socketService(scid) {
  return `localabstract:scrcpy_${scidHex(scid)}`;
}

/** Server arguments (after the version), all of the form key=value. */
export function buildServerArgs(scid, input) {
  const o = normalizeOptions(input);
  const args = [
    `scid=${scidHex(scid)}`,
    'log_level=info',
    'tunnel_forward=true',
    'video_codec=h264',
    `video_bit_rate=${o.videoBitRate}`,
    `max_fps=${o.maxFps}`,
    `max_size=${o.maxSize}`,
    `display_id=${o.displayId}`,
    `audio=${o.audio}`,
    `control=${o.control}`,
    `stay_awake=${o.stayAwake}`,
    `show_touches=${o.showTouches}`,
    `power_off_on_close=${o.powerOffOnClose}`,
    `power_on=${o.powerOn}`,
    `clipboard_autosync=${o.clipboardAutosync}`,
    'cleanup=true',
  ];
  if (o.audio) {
    args.push(`audio_codec=${o.audioCodec}`, `audio_source=${o.audioSource}`);
    if (o.audioCodec === 'opus') args.push('audio_bit_rate=128000');
  }
  for (const a of args) {
    if (!/^[a-z_]+=[a-z0-9_.]+$/.test(a)) throw new Error(`Invalid server argument: ${a}`);
  }
  return args;
}

/** Full shell command that starts scrcpy-server on the device. */
export function buildServerCommand(scid, input) {
  return [
    `CLASSPATH=${DEVICE_SERVER_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SCRCPY_VERSION,
    ...buildServerArgs(scid, input),
  ].join(' ');
}
