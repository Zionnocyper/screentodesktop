import { icon } from './icons.js';

/** Tiny DOM builder. Strings become text nodes (never HTML). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'icon') el.innerHTML = icon(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Button with an icon and an optional label. */
export function iconButton(name, label, props = {}) {
  const btn = h('button', { type: 'button', class: 'btn', ...props });
  btn.innerHTML = icon(name);
  if (label) btn.append(h('span', {}, label));
  return btn;
}

export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
}

const toastRoot = () => document.getElementById('toasts');

/**
 * Shows a toast. Returns { update(text), progress(fraction), close(), done(text, type) }.
 * timeout 0 keeps it open until closed.
 */
export function toast(text, { type = 'info', timeout = 3500 } = {}) {
  const msg = h('div', {}, text);
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, msg);
  toastRoot().append(el);
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  const arm = (ms) => {
    clearTimeout(timer);
    if (ms) timer = setTimeout(close, ms);
  };
  arm(timeout);
  el.addEventListener('click', close);
  let bar = null;
  return {
    update(t) {
      msg.textContent = t;
    },
    progress(fraction) {
      bar ??= el.appendChild(h('progress', { max: '1' }));
      bar.value = fraction;
    },
    done(t, kind = 'ok') {
      msg.textContent = t;
      bar?.remove();
      el.className = `toast ${kind}`;
      arm(kind === 'error' ? 8000 : 3500);
    },
    close,
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
