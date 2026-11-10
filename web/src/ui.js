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

/**
 * Glass tooltips for [data-tip] elements. One floating element positioned
 * with getBoundingClientRect, so scroll containers never clip it.
 * Shown for viewer controls always, and for sidebar items when collapsed.
 */
export function setupTooltips({ shell }) {
  const tip = h('div', { class: 'tooltip', role: 'tooltip' });
  document.body.append(tip);
  let current = null;

  const placement = (el) => {
    if (el.closest('.rail')) return matchMedia('(max-width: 900px)').matches ? 'top' : 'left';
    if (el.closest('.viewer-bar')) return 'bottom';
    if (el.closest('.sidebar')) {
      const wide = matchMedia('(min-width: 901px)').matches;
      return wide && shell.classList.contains('collapsed') ? 'right' : null;
    }
    return null;
  };

  const show = (el) => {
    const side = placement(el);
    if (!side || !el.dataset.tip) return hide();
    current = el;
    tip.textContent = el.dataset.tip;
    tip.classList.toggle('dark', Boolean(el.closest('.viewer')));
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 10;
    let x;
    let y;
    if (side === 'right') [x, y] = [r.right + gap, r.top + r.height / 2 - t.height / 2];
    else if (side === 'left') [x, y] = [r.left - gap - t.width, r.top + r.height / 2 - t.height / 2];
    else if (side === 'top') [x, y] = [r.left + r.width / 2 - t.width / 2, r.top - gap - t.height];
    else [x, y] = [r.left + r.width / 2 - t.width / 2, r.bottom + gap];
    x = Math.max(8, Math.min(innerWidth - t.width - 8, x));
    y = Math.max(8, Math.min(innerHeight - t.height - 8, y));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.classList.add('on');
  };
  const hide = () => {
    current = null;
    tip.classList.remove('on');
  };

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (el !== current) el ? show(el) : hide();
  });
  document.addEventListener('pointerdown', hide);
  document.addEventListener('scroll', hide, true);
  return { hide };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
