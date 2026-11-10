// Encoders for scrcpy control messages (client -> device), matching
// server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java (v5.0.1).
// All integers are big-endian.

export const MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  SCAN_FILE: 22,
};

export const KEY_ACTION = { DOWN: 0, UP: 1 };
export const MOTION_ACTION = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };

export const POINTER_ID_MOUSE = -1n;
export const POINTER_ID_GENERIC_FINGER = -2n;
export const POINTER_ID_VIRTUAL_FINGER = -3n;

export const INJECT_TEXT_MAX_BYTES = 300;

const encoder = new TextEncoder();

function view(size) {
  const buf = new Uint8Array(size);
  return [buf, new DataView(buf.buffer)];
}

function toU16FixedPoint(f) {
  const v = Math.round(Math.min(1, Math.max(0, f)) * 0x10000);
  return v >= 0xffff ? 0xffff : v;
}

function toI16FixedPoint(f) {
  const v = Math.round(Math.min(1, Math.max(-1, f)) * 0x8000);
  return Math.max(-0x8000, Math.min(0x7fff, v));
}

function writePosition(dv, offset, x, y, width, height) {
  dv.setInt32(offset, Math.round(x));
  dv.setInt32(offset + 4, Math.round(y));
  dv.setUint16(offset + 8, width);
  dv.setUint16(offset + 10, height);
}

export function injectKeycode(action, keycode, repeat = 0, metaState = 0) {
  const [buf, dv] = view(14);
  dv.setUint8(0, MSG.INJECT_KEYCODE);
  dv.setUint8(1, action);
  dv.setInt32(2, keycode);
  dv.setInt32(6, repeat);
  dv.setInt32(10, metaState);
  return buf;
}

export function injectText(text) {
  const bytes = encoder.encode(text);
  const [buf, dv] = view(5 + bytes.length);
  dv.setUint8(0, MSG.INJECT_TEXT);
  dv.setUint32(1, bytes.length);
  buf.set(bytes, 5);
  return buf;
}

export function injectTouch({ action, pointerId, x, y, width, height, pressure = 1, actionButton = 0, buttons = 0 }) {
  const [buf, dv] = view(32);
  dv.setUint8(0, MSG.INJECT_TOUCH_EVENT);
  dv.setUint8(1, action);
  dv.setBigInt64(2, BigInt(pointerId));
  writePosition(dv, 10, x, y, width, height);
  dv.setUint16(22, toU16FixedPoint(pressure));
  dv.setInt32(24, actionButton);
  dv.setInt32(28, buttons);
  return buf;
}

/** hScroll/vScroll in "notches", range [-16, 16]. Positive vScroll scrolls up. */
export function injectScroll({ x, y, width, height, hScroll, vScroll, buttons = 0 }) {
  const [buf, dv] = view(21);
  dv.setUint8(0, MSG.INJECT_SCROLL_EVENT);
  writePosition(dv, 1, x, y, width, height);
  dv.setInt16(13, toI16FixedPoint(hScroll / 16));
  dv.setInt16(15, toI16FixedPoint(vScroll / 16));
  dv.setInt32(17, buttons);
  return buf;
}

export function backOrScreenOn(action) {
  return Uint8Array.of(MSG.BACK_OR_SCREEN_ON, action);
}

export function simple(type) {
  return Uint8Array.of(type);
}

export function getClipboard(copyKey = 0) {
  return Uint8Array.of(MSG.GET_CLIPBOARD, copyKey);
}

export function setClipboard(text, paste, sequence = 0n) {
  const bytes = encoder.encode(text);
  const [buf, dv] = view(14 + bytes.length);
  dv.setUint8(0, MSG.SET_CLIPBOARD);
  dv.setBigUint64(1, BigInt(sequence));
  dv.setUint8(9, paste ? 1 : 0);
  dv.setUint32(10, bytes.length);
  buf.set(bytes, 14);
  return buf;
}

export function setDisplayPower(on) {
  return Uint8Array.of(MSG.SET_DISPLAY_POWER, on ? 1 : 0);
}

/** name: package name, prefix "?" to search by app label, "+" to force-stop first. */
export function startApp(name) {
  const bytes = encoder.encode(name).subarray(0, 255);
  const buf = new Uint8Array(2 + bytes.length);
  buf[0] = MSG.START_APP;
  buf[1] = bytes.length;
  buf.set(bytes, 2);
  return buf;
}

export function scanFile(path) {
  const bytes = encoder.encode(path);
  const [buf, dv] = view(5 + bytes.length);
  dv.setUint8(0, MSG.SCAN_FILE);
  dv.setUint32(1, bytes.length);
  buf.set(bytes, 5);
  return buf;
}
