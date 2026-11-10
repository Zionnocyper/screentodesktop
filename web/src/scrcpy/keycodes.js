// Browser KeyboardEvent.code -> Android KeyEvent keycodes.
export const AKEY = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  VOLUME_MUTE: 164,
  APP_SWITCH: 187,
  SLEEP: 223,
  WAKEUP: 224,
  SCREENSHOT: 120, // KEYCODE_SYSRQ
};

export const CODE_TO_KEYCODE = {
  Escape: 111,
  Tab: 61,
  Enter: 66,
  NumpadEnter: 160,
  Backspace: 67,
  Delete: 112,
  Insert: 124,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Space: 62,
  ShiftLeft: 59,
  ShiftRight: 60,
  ControlLeft: 113,
  ControlRight: 114,
  AltLeft: 57,
  AltRight: 58,
  MetaLeft: 117,
  MetaRight: 118,
  CapsLock: 115,
  NumLock: 143,
  ScrollLock: 116,
  PrintScreen: 120,
  Pause: 121,
  ContextMenu: 82,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Comma: 55,
  Period: 56,
  Slash: 76,
  Backquote: 68,
  NumpadAdd: 157,
  NumpadSubtract: 156,
  NumpadMultiply: 155,
  NumpadDivide: 154,
  NumpadDecimal: 158,
  NumpadEqual: 161,
  AudioVolumeUp: 24,
  AudioVolumeDown: 25,
  AudioVolumeMute: 164,
  MediaPlayPause: 85,
  MediaTrackNext: 87,
  MediaTrackPrevious: 88,
  MediaStop: 86,
};
for (let i = 0; i < 26; i++) CODE_TO_KEYCODE[`Key${String.fromCharCode(65 + i)}`] = 29 + i;
for (let i = 0; i <= 9; i++) {
  CODE_TO_KEYCODE[`Digit${i}`] = 7 + i;
  CODE_TO_KEYCODE[`Numpad${i}`] = 144 + i;
}
for (let i = 1; i <= 12; i++) CODE_TO_KEYCODE[`F${i}`] = 130 + i;

/** Keys that never produce text: always sent as keycodes. */
export const NON_TEXT_CODES = new Set([
  'Escape', 'Tab', 'Enter', 'NumpadEnter', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PrintScreen',
  'Pause', 'ContextMenu', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute',
  'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaStop',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'CapsLock', 'NumLock', 'ScrollLock',
]);

// android.view.KeyEvent meta state flags
const META = {
  SHIFT_ON: 0x1,
  ALT_ON: 0x2,
  CTRL_ON: 0x1000,
  META_ON: 0x10000,
  CAPS_LOCK_ON: 0x100000,
  NUM_LOCK_ON: 0x200000,
};

export function metaStateOf(e) {
  let m = 0;
  if (e.shiftKey) m |= META.SHIFT_ON;
  if (e.altKey) m |= META.ALT_ON;
  if (e.ctrlKey) m |= META.CTRL_ON;
  if (e.metaKey) m |= META.META_ON;
  if (e.getModifierState?.('CapsLock')) m |= META.CAPS_LOCK_ON;
  if (e.getModifierState?.('NumLock')) m |= META.NUM_LOCK_ON;
  return m;
}
