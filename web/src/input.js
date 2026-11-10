// Maps browser input on the canvas to scrcpy control messages.
//
// Mouse:  left = touch, right = BACK (or screen on), middle = HOME,
//         wheel = scroll, Ctrl+drag = pinch (virtual second finger)
// Touch:  multi-touch passthrough
// Keys:   text via INJECT_TEXT (non-ASCII/IME via clipboard paste), other keys as keycodes
import { MOTION_ACTION, POINTER_ID_GENERIC_FINGER, POINTER_ID_VIRTUAL_FINGER } from './scrcpy/control.js';
import { AKEY, CODE_TO_KEYCODE, MODIFIER_CODES, NON_TEXT_CODES, metaStateOf } from './scrcpy/keycodes.js';

export function attachInput(client, canvas, textSink) {
  const pointers = new Map(); // DOM pointerId -> scrcpy pointer id (BigInt)
  let pinch = null; // { cx, cy } when Ctrl+drag
  const pressedKeys = new Map(); // code -> { keycode, repeat }
  const disposers = [];

  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    disposers.push(() => target.removeEventListener(type, fn, opts));
  };

  const toVideo = (e) => {
    const size = client.videoSize;
    if (!size) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((e.clientX - rect.left) / rect.width) * size.width;
    const y = ((e.clientY - rect.top) / rect.height) * size.height;
    return {
      x: Math.max(0, Math.min(size.width - 1, x)),
      y: Math.max(0, Math.min(size.height - 1, y)),
    };
  };

  const mirror = (p) => ({ x: 2 * pinch.cx - p.x, y: 2 * pinch.cy - p.y });
  const pressureOf = (e) => (e.pointerType === 'mouse' || !e.pressure ? 1 : e.pressure);

  on(canvas, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse') {
      if (e.button === 2 || e.button === 3) {
        e.preventDefault();
        client.back();
        return;
      }
      if (e.button === 1) {
        e.preventDefault();
        client.home();
        return;
      }
      if (e.button === 4) {
        client.pressKey(AKEY.APP_SWITCH);
        return;
      }
      if (e.button !== 0) return;
      textSink.focus({ preventScroll: true });
    }
    const p = toVideo(e);
    if (!p) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const id = e.pointerType === 'mouse' ? POINTER_ID_GENERIC_FINGER : BigInt(e.pointerId);
    pointers.set(e.pointerId, id);
    client.touch(MOTION_ACTION.DOWN, id, p.x, p.y, pressureOf(e));
    if (e.pointerType === 'mouse' && (e.ctrlKey || e.metaKey) && client.videoSize) {
      pinch = { cx: client.videoSize.width / 2, cy: client.videoSize.height / 2 };
      const m = mirror(p);
      client.touch(MOTION_ACTION.DOWN, POINTER_ID_VIRTUAL_FINGER, m.x, m.y, 1);
    }
  });

  on(canvas, 'pointermove', (e) => {
    const id = pointers.get(e.pointerId);
    if (id === undefined) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    const last = events[events.length - 1] ?? e;
    const p = toVideo(last);
    if (!p) return;
    client.touch(MOTION_ACTION.MOVE, id, p.x, p.y, pressureOf(last));
    if (pinch && id === POINTER_ID_GENERIC_FINGER) {
      const m = mirror(p);
      client.touch(MOTION_ACTION.MOVE, POINTER_ID_VIRTUAL_FINGER, m.x, m.y, 1);
    }
  });

  const release = (action) => (e) => {
    const id = pointers.get(e.pointerId);
    if (id === undefined) return;
    pointers.delete(e.pointerId);
    const p = toVideo(e) ?? { x: 0, y: 0 };
    if (pinch && id === POINTER_ID_GENERIC_FINGER) {
      const m = mirror(p);
      client.touch(action, POINTER_ID_VIRTUAL_FINGER, m.x, m.y, 0);
      pinch = null;
    }
    client.touch(action, id, p.x, p.y, 0);
  };
  on(canvas, 'pointerup', release(MOTION_ACTION.UP));
  on(canvas, 'pointercancel', release(MOTION_ACTION.CANCEL));
  on(canvas, 'contextmenu', (e) => e.preventDefault());
  on(canvas, 'mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
  });

  on(
    canvas,
    'wheel',
    (e) => {
      const p = toVideo(e);
      if (!p) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 0.1 : 100; // lines / pages / pixels per notch
      const clamp = (v) => Math.max(-16, Math.min(16, v));
      client.scroll(p.x, p.y, clamp(-e.deltaX / unit), clamp(-e.deltaY / unit));
    },
    { passive: false },
  );

  // ------------------------------------------------------------ keyboard
  const flushText = () => {
    const text = textSink.value;
    textSink.value = '';
    if (text) client.typeText(text);
  };

  on(textSink, 'keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME in progress
    const { code } = e;
    if ((e.ctrlKey || e.metaKey) && code === 'KeyV') return; // handled by the paste event
    if (MODIFIER_CODES.has(code)) return;
    const altGr = e.getModifierState?.('AltGraph');
    const withModifier = e.ctrlKey || e.metaKey || (e.altKey && !altGr);
    if (!NON_TEXT_CODES.has(code) && !withModifier) return; // printable: arrives through 'input'
    const keycode = CODE_TO_KEYCODE[code];
    if (keycode === undefined) return;
    e.preventDefault();
    const state = pressedKeys.get(code);
    const repeat = e.repeat && state ? state.repeat + 1 : 0;
    pressedKeys.set(code, { keycode, repeat });
    client.keyDown(keycode, metaStateOf(e), repeat);
  });

  on(textSink, 'keyup', (e) => {
    const state = pressedKeys.get(e.code);
    if (!state) return;
    pressedKeys.delete(e.code);
    e.preventDefault();
    client.keyUp(state.keycode, metaStateOf(e));
  });

  on(textSink, 'blur', () => {
    for (const { keycode } of pressedKeys.values()) client.keyUp(keycode);
    pressedKeys.clear();
  });

  on(textSink, 'input', (e) => {
    if (e.isComposing) return;
    flushText();
  });
  on(textSink, 'compositionend', flushText);

  on(textSink, 'paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) client.paste(text);
  });

  return () => {
    for (const d of disposers) d();
    pointers.clear();
  };
}
