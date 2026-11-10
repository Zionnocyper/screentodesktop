import './styles.css';
import { SCRCPY_VERSION } from './shared/scrcpy-options.js';
import { opusSupported } from './scrcpy/audio.js';
import { H264Decoder } from './scrcpy/video.js';
import { ServerDevice, api, getServerSession, watchServerDevices } from './transport/server.js';
import { setupSettings } from './settings.js';
import { closeViewer, currentSession, openViewer, restoreViewer } from './viewer.js';
import { fillIcons, h, iconButton, setupTooltips, toast } from './ui.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const shell = $('shell');
fillIcons();
$('scrcpy-version').textContent = SCRCPY_VERSION;
setupTooltips({ shell });

// ------------------------------------------------------------ settings + quick toggles
function syncQuickSettings(o) {
  $('sb-quality').textContent = o.maxSize ? String(o.maxSize) : 'Gốc';
  $('btn-settings').dataset.tip = `Chất lượng · ${o.maxSize || 'gốc'} · ${o.videoBitRate / 1e6} Mbps · ${o.maxFps} fps`;
  $('sb-audio').checked = o.audio;
  document.querySelector('.sb-toggle').dataset.tip = `Âm thanh: ${o.audio ? 'bật' : 'tắt'}`;
}

const settings = setupSettings({
  dialog: $('settings'),
  form: $('settings-form'),
  openButton: $('btn-settings'),
  resetButton: $('settings-reset'),
  onChange: (o) => {
    syncQuickSettings(o);
    toast('Đã lưu. Áp dụng cho lần xem tiếp theo.', { timeout: 2000 });
  },
});
syncQuickSettings(settings.options);
$('sb-audio').addEventListener('change', (e) => settings.update({ audio: e.target.checked }));

let canUseOpus = false;
opusSupported().then((ok) => {
  canUseOpus = ok;
});

function streamOptions() {
  const o = { ...settings.options };
  if (o.audio && !canUseOpus) o.audioCodec = 'raw'; // no WebCodecs AudioDecoder: uncompressed PCM
  return o;
}

function view(device) {
  closeDrawer();
  const s = currentSession();
  if (s && s.device === device && s.minimized) return restoreViewer();
  openViewer(device, streamOptions());
}

// ------------------------------------------------------------ warnings
function warn(text) {
  const box = h('div', { class: 'warning glass-inset' });
  box.innerHTML = icon('alert');
  box.append(h('div', {}, text));
  $('warnings').append(box);
}
if (!H264Decoder.supported) {
  warn('Trình duyệt này không có WebCodecs nên không giải mã được video. Hãy dùng Chrome, Edge, Firefox 130+ hoặc Safari 17+.');
}

// ------------------------------------------------------------ device presentation
const STATE = {
  device: ['Sẵn sàng', 'ok'],
  unauthorized: ['Chưa cho phép', 'warn'],
  authorizing: ['Đang xác thực', 'warn'],
  offline: ['Ngoại tuyến', 'off'],
  connecting: ['Đang kết nối', 'warn'],
  'no permissions': ['Thiếu quyền USB', 'warn'],
};

function look(device) {
  if (device.kind === 'usb') return { variant: 'blue', glyph: 'usb', where: 'WebUSB' };
  if (device.info?.wireless) return { variant: 'green', glyph: 'wifi', where: 'Wi-Fi' };
  return { variant: 'indigo', glyph: 'phone', where: 'USB · server' };
}

function appIcon(variant, glyph, { size = '', state = null, live = false } = {}) {
  const el = h('span', { class: `app-icon app-icon--${variant}${size ? ` app-icon--${size}` : ''}${live ? ' live' : ''}` });
  el.innerHTML = icon(glyph);
  if (state !== null && !live) el.append(h('i', { class: `state ${state}` }));
  return el;
}

function searchText(device) {
  return `${device.name} ${device.serial} ${device.info?.address ?? ''}`.toLowerCase();
}

function card(device, { meta, hint, actions }) {
  const [label, cls] = STATE[device.state] ?? [device.state, 'off'];
  const { variant, glyph } = look(device);
  return h(
    'article',
    { class: 'device-card', dataset: { search: searchText(device) } },
    h(
      'div',
      { class: 'device-top' },
      appIcon(variant, glyph, { size: 'lg', state: cls }),
      h('div', { class: 'device-text' }, h('div', { class: 'device-name', title: device.name }, device.name), h('div', { class: 'device-meta', title: meta }, meta)),
      h('span', { class: `badge ${cls}` }, label),
    ),
    hint && h('div', { class: 'device-hint' }, hint),
    h('div', { class: 'device-actions' }, actions),
  );
}

function viewButton(device) {
  return iconButton('play', 'Xem', {
    class: 'btn primary',
    disabled: device.state !== 'device' || undefined,
    onclick: () => view(device),
  });
}

// ------------------------------------------------------------ sidebar
const COLLAPSE_KEY = 'screentodesktop.sidebar.collapsed';
const wide = () => matchMedia('(min-width: 901px)').matches;

function setCollapsed(collapsed) {
  shell.classList.toggle('collapsed', collapsed);
  const btn = $('sb-collapse');
  btn.dataset.tip = collapsed ? 'Mở rộng' : 'Thu gọn';
  btn.setAttribute('aria-label', collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên');
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {}
}
try {
  setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
} catch {
  setCollapsed(false);
}
$('sb-collapse').addEventListener('click', () => setCollapsed(!shell.classList.contains('collapsed')));

function openDrawer() {
  shell.classList.add('drawer');
}
function closeDrawer() {
  shell.classList.remove('drawer');
}
$('sb-open').addEventListener('click', openDrawer);
$('sb-scrim').addEventListener('click', closeDrawer);

function focusSearch() {
  if (wide()) setCollapsed(false);
  else openDrawer();
  requestAnimationFrame(() => $('sb-filter').focus());
}
document.querySelector('.sb-search').addEventListener('click', () => {
  if (wide() && shell.classList.contains('collapsed')) focusSearch();
});
document.addEventListener('keydown', (e) => {
  if (document.body.classList.contains('viewing')) return; // keys belong to the phone
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    focusSearch();
  } else if (e.key === 'Escape') {
    closeDrawer();
  }
});
$('sb-filter').addEventListener('input', applyFilter);
$('sb-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    applyFilter();
    e.target.blur();
  } else if (e.key === 'Enter') {
    document.querySelector('#sb-devices .sb-item:not(.filtered-out)')?.click();
  }
});

function applyFilter() {
  const q = $('sb-filter').value.trim().toLowerCase();
  for (const el of document.querySelectorAll('#sb-devices .sb-item, .device-grid .device-card')) {
    el.classList.toggle('filtered-out', Boolean(q) && !(el.dataset.search ?? '').includes(q));
  }
}

// The lifted glass highlight that glides between sidebar items.
(function setupHoverHighlight() {
  const nav = $('sb-nav');
  const hl = nav.querySelector('.sb-hover');
  nav.addEventListener('pointerover', (e) => {
    const item = e.target.closest('.sb-item');
    if (!item || item.disabled || !nav.contains(item)) return;
    hl.style.transform = `translateY(${item.offsetTop}px)`;
    hl.style.height = `${item.offsetHeight}px`;
    hl.classList.add('on');
  });
  nav.addEventListener('pointerleave', () => hl.classList.remove('on'));
})();

function renderSidebar() {
  const group = $('sb-devices');
  group.dataset.empty = 'Chưa có thiết bị';
  const active = currentSession()?.device ?? null;
  const all = [...usbPresent.values(), ...serverDevices.values()];
  group.replaceChildren(
    ...all.map((d) => {
      const { variant, glyph, where } = look(d);
      const [label, cls] = STATE[d.state] ?? [d.state, 'off'];
      const isActive = d === active;
      const item = h('button', {
        type: 'button',
        class: `sb-item${isActive ? ' active' : ''}`,
        dataset: { tip: d.name, search: searchText(d) },
      });
      item.append(
        appIcon(variant, glyph, { state: cls, live: isActive }),
        h('span', { class: 'sb-text' }, d.name, h('span', { class: 'sb-sub' }, d.state === 'device' ? where : `${where} · ${label}`)),
      );
      if (isActive) item.append(h('span', { class: 'badge-count' }, 'Đang xem'));
      item.addEventListener('click', () => {
        if (d.state !== 'device') {
          toast(`${d.name}: ${label}`, { type: 'error' });
          return;
        }
        view(d);
      });
      return item;
    }),
  );
  const waiting = (serverData.discovered ?? []).filter((s) => s.type === 'pairing' && !s.connected).length;
  $('sb-pair-count').textContent = waiting ? String(waiting) : '';
  $('sb-pair-count').hidden = !waiting;
  applyFilter();
}

$('sb-guide').addEventListener('click', () => {
  closeDrawer();
  $('guide').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('sb-connect').addEventListener('click', () => {
  closeDrawer();
  $('panel-server').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('connect-address').focus({ preventScroll: true }), 350);
});
$('sb-pair').addEventListener('click', () => {
  closeDrawer();
  openPair();
});
$('sb-usb').addEventListener('click', () => {
  closeDrawer();
  addUsbDevice();
});

function setStatus(kind, title, sub = '') {
  $('sb-status-dot').className = `status-dot ${kind}`;
  $('sb-status-title').textContent = title;
  $('sb-status-sub').textContent = sub;
  document.querySelector('.sb-foot .avatar').dataset.tip = `${title}${sub ? ` · ${sub}` : ''}`;
}

// "Now viewing" card: a minimized viewer keeps streaming in the background.
window.addEventListener('viewer:state', (e) => {
  const { state, name } = e.detail;
  $('sb-session').hidden = state !== 'minimized';
  $('sb-session-name').textContent = name;
  if (state === 'minimized') $('sb-session-stats').textContent = 'Đang chạy nền';
  renderSidebar();
});
window.addEventListener('viewer:stats', (e) => {
  if ($('sb-session').hidden) return;
  const { fps, kbps, size, maxFps } = e.detail;
  $('sb-session-stats').textContent = `${size.width}×${size.height} · ${Math.round(fps)} fps · ${(kbps / 1000).toFixed(1)} Mbps`;
  $('sb-session-meter').style.width = `${Math.min(100, Math.max(4, (fps / (maxFps || 60)) * 100))}%`;
});
$('sb-session-open').addEventListener('click', () => restoreViewer());
$('sb-session-stop').addEventListener('click', () => closeViewer());

// ------------------------------------------------------------ server devices
const serverDevices = new Map();
let stopWatching = null;
let serverData = { devices: [], discovered: [], mdns: null, error: null };

function renderServer(data) {
  serverData = { devices: [], discovered: [], mdns: null, error: null, ...data };
  const { devices, error } = serverData;
  const grid = $('server-devices');
  const seen = new Set();
  for (const info of devices) {
    seen.add(info.serial);
    const existing = serverDevices.get(info.serial);
    if (existing) existing.update(info);
    else serverDevices.set(info.serial, new ServerDevice(info));
  }
  for (const serial of serverDevices.keys()) if (!seen.has(serial)) serverDevices.delete(serial);

  $('sb-pair').hidden = false;
  $('sb-connect').hidden = false;
  if (error) setStatus('warn', 'adb chưa sẵn sàng', error);
  else setStatus('ok', 'Server đang chạy', `${location.host} · ${serverDevices.size} thiết bị`);

  grid.replaceChildren();
  $('panel-server').querySelector('.empty')?.remove();
  renderDiscovered();
  renderPairDetected();
  renderSidebar();
  if (error) {
    grid.after(h('div', { class: 'empty' }, `Không kết nối được adb trên server: ${error}`));
    return;
  }
  if (!serverDevices.size) {
    grid.after(
      h('div', { class: 'empty' }, 'Chưa có thiết bị nào. Cắm cáp vào máy chủ (đã bật Gỡ lỗi USB), hoặc bấm “Ghép đôi Wi-Fi” để kết nối không dây.'),
    );
    return;
  }
  for (const d of serverDevices.values()) {
    const i = d.info;
    const where = i.wireless ? `Wi-Fi${i.address ? ` ${i.address}` : ''}` : 'USB';
    const meta = [i.androidVersion && `Android ${i.androidVersion}`, where, i.wireless && i.address ? null : d.serial].filter(Boolean).join(' · ');
    const hint =
      d.state === 'unauthorized'
        ? 'Mở khóa điện thoại và bấm “Cho phép” trong hộp thoại gỡ lỗi USB.'
        : d.state === 'no permissions'
          ? 'Server thiếu quyền truy cập USB (udev rules trên Linux).'
          : null;
    const actions = [viewButton(d)];
    if (i.wireless) {
      actions.push(
        iconButton('unlink', 'Ngắt', {
          onclick: async () => {
            try {
              await api('/api/adb/disconnect', { method: 'POST', body: { address: d.serial } });
            } catch (err) {
              toast(err.message, { type: 'error' });
            }
          },
        }),
      );
    } else if (d.state === 'device') {
      actions.push(iconButton('wifi', 'Wi-Fi', { title: 'Bật ADB qua Wi-Fi để rút cáp', onclick: () => enableWifi(d) }));
    }
    grid.append(card(d, { meta, hint, actions }));
  }
  applyFilter();
}

async function enableWifi(device) {
  const t = toast('Đang bật ADB qua Wi-Fi…', { timeout: 0 });
  try {
    const { ip, port } = await device.enableWifi();
    if (!ip) {
      t.done('Đã bật chế độ TCP/IP nhưng không tìm thấy IP Wi-Fi của điện thoại.', 'error');
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const { message } = await api('/api/adb/connect', { method: 'POST', body: { address: `${ip}:${port}` } });
    t.done(`${message}\nGiờ có thể rút cáp USB.`);
  } catch (err) {
    t.done(err.message, 'error');
  }
}

// ------------------------------------------------------------ Wi-Fi: discovery + pairing
function discoveredName(s) {
  return s.name || (s.serialHint ? `Điện thoại ${s.serialHint}` : s.instance);
}

/** Phones advertising Wireless debugging (or a pairing code) that are not connected yet. */
function renderDiscovered() {
  const all = serverData.discovered ?? [];
  // A phone showing its pairing dialog also advertises its connect service: show it once.
  const waiting = new Set(all.filter((s) => s.type === 'pairing').map((s) => s.instance));
  const items = all.filter((s) => !s.connected && !(s.type === 'connect' && waiting.has(s.instance)));
  const grid = $('discovered-list');
  grid.replaceChildren();
  $('server-discovered').hidden = !items.length;
  for (const s of items) {
    const pairing = s.type === 'pairing';
    const action = pairing
      ? iconButton('link', 'Ghép đôi', { class: 'btn primary', onclick: () => openPair(s.address) })
      : iconButton('wifi', 'Kết nối', { class: 'btn primary', onclick: () => connectAddress(s.target, discoveredName(s)) });
    grid.append(
      h(
        'article',
        { class: 'device-card', dataset: { search: `${discoveredName(s)} ${s.address}`.toLowerCase() } },
        h(
          'div',
          { class: 'device-top' },
          appIcon(pairing ? 'orange' : 'green', pairing ? 'link' : 'wifi', { size: 'lg' }),
          h(
            'div',
            { class: 'device-text' },
            h('div', { class: 'device-name', title: s.instance }, discoveredName(s)),
            h('div', { class: 'device-meta' }, `${pairing ? 'Đang chờ ghép đôi' : 'Gỡ lỗi không dây'} · ${s.address}`),
          ),
          h('span', { class: `badge ${pairing ? 'warn' : 'off'}` }, pairing ? 'Chờ ghép đôi' : 'Chưa kết nối'),
        ),
        !pairing && h('div', { class: 'device-note' }, 'Kết nối không được? Ghép đôi trước bằng mã 6 số.'),
        h('div', { class: 'device-actions' }, action),
      ),
    );
  }
}

async function connectAddress(address, label = address) {
  const t = toast(`Đang kết nối ${label}…`, { timeout: 0 });
  try {
    const { message } = await api('/api/adb/connect', { method: 'POST', body: { address } });
    t.done(message);
    return true;
  } catch (err) {
    t.done(err.message, 'error');
    return false;
  }
}

const pairDialog = $('pair-dialog');

function renderPairDetected() {
  if (!pairDialog.open) return;
  const pairing = (serverData.discovered ?? []).filter((s) => s.type === 'pairing');
  $('pair-mdns-off').hidden = serverData.mdns !== false;
  $('pair-detected').hidden = !pairing.length;
  $('pair-chips').replaceChildren(
    ...pairing.map((s) => {
      const chip = h('button', { type: 'button', class: 'chip', title: s.instance });
      chip.innerHTML = icon('phone');
      chip.append(h('span', {}, discoveredName(s)), h('small', {}, s.address));
      chip.addEventListener('click', () => {
        $('pair-address').value = s.address;
        $('pair-code').focus();
      });
      return chip;
    }),
  );
  // Fill the address automatically when exactly one phone is waiting.
  if (pairing.length === 1 && !$('pair-address').value) $('pair-address').value = pairing[0].address;
}

function openPair(address = '') {
  $('pair-address').value = address;
  $('pair-code').value = '';
  $('pair-error').hidden = true;
  setPairBusy(false);
  pairDialog.showModal();
  renderPairDetected();
  ($('pair-address').value ? $('pair-code') : $('pair-address')).focus();
}

function setPairBusy(busy) {
  const btn = $('pair-submit');
  btn.disabled = busy;
  btn.querySelector('span:last-child').textContent = busy ? 'Đang ghép đôi…' : 'Ghép đôi';
}

$('btn-pair').addEventListener('click', () => openPair());
$('pair-x').addEventListener('click', () => pairDialog.close());
$('pair-cancel').addEventListener('click', () => pairDialog.close());
$('pair-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const address = $('pair-address').value.trim();
  const code = $('pair-code').value.trim();
  const error = $('pair-error');
  error.hidden = true;
  const fail = (msg, field) => {
    error.textContent = msg;
    error.hidden = false;
    field?.focus();
  };
  if (!/^(\[[^\]]+\]|[\w.-]+):\d{1,5}$/.test(address)) return fail('Nhập địa chỉ dạng IP:cổng, ví dụ 192.168.1.23:37159.', $('pair-address'));
  if (!/^\d{6}$/.test(code)) return fail('Mã ghép đôi gồm 6 chữ số.', $('pair-code'));
  setPairBusy(true);
  try {
    const result = await api('/api/adb/pair', { method: 'POST', body: { address, code } });
    pairDialog.close();
    if (result.connected) toast('Đã ghép đôi và kết nối qua Wi-Fi. Bấm “Xem” để mở màn hình.', { type: 'ok', timeout: 6000 });
    else toast(result.hint || 'Đã ghép đôi.', { type: 'ok', timeout: 10000 });
  } catch (err) {
    fail(err.message);
  } finally {
    setPairBusy(false);
  }
});

function startServerWatch() {
  stopWatching?.();
  stopWatching = watchServerDevices(renderServer, () => showLogin());
}

function showLogin() {
  stopWatching?.();
  stopWatching = null;
  serverDevices.clear();
  $('server-devices').replaceChildren();
  $('server-discovered').hidden = true;
  $('panel-server').querySelector('.empty')?.remove();
  $('server-login').hidden = false;
  $('server-actions').hidden = true;
  $('sb-pair').hidden = true;
  $('sb-connect').hidden = true;
  setStatus('warn', 'Cần đăng nhập', location.host);
  renderSidebar();
  $('login-password').focus();
}

$('server-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: { password: $('login-password').value } });
    $('login-password').value = '';
    $('server-login').hidden = true;
    $('server-actions').hidden = false;
    $('btn-logout').hidden = false;
    startServerWatch();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  $('btn-logout').hidden = true;
  showLogin();
});

$('form-connect').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('connect-address');
  const address = input.value.trim();
  if (!address) return input.focus();
  if (await connectAddress(address)) input.value = '';
});

getServerSession().then((session) => {
  if (!session) {
    // static hosting: WebUSB only
    const usbOk = 'usb' in navigator && window.isSecureContext;
    setStatus(usbOk ? 'ok' : 'warn', 'Chế độ WebUSB', usbOk ? 'Không có server · cắm cáp vào máy này' : 'Trình duyệt không hỗ trợ WebUSB');
    return;
  }
  $('panel-server').hidden = false;
  if (session.authRequired) $('btn-logout').hidden = !session.authenticated;
  if (session.authRequired && !session.authenticated) showLogin();
  else startServerWatch();
});

// ------------------------------------------------------------ WebUSB devices
// Wrappers are kept even while a phone is briefly gone (USB re-enumeration),
// so an open viewer keeps a wrapper that gets the fresh USBDevice.
const usbKnown = new Map();
const usbPresent = new Map();
let addUsbDevice = () => toast('Trình duyệt này không dùng được WebUSB (cần Chrome/Edge qua HTTPS hoặc localhost).', { type: 'error' });

async function setupUsb() {
  const grid = $('usb-devices');
  const addButton = $('btn-usb-add');
  const panel = $('panel-usb');

  const unsupported = (text) => {
    addButton.disabled = true;
    $('sb-usb').disabled = true;
    panel.append(h('div', { class: 'empty' }, text));
  };
  if (!('usb' in navigator)) return unsupported('Trình duyệt này không hỗ trợ WebUSB. Dùng Chrome hoặc Edge trên máy tính / Android.');
  if (!window.isSecureContext) return unsupported('WebUSB chỉ chạy trên HTTPS hoặc http://localhost. Hãy mở trang qua HTTPS.');

  const usb = await import('./transport/webusb.js');

  const render = async () => {
    const list = await usb.listUsbDevices().catch(() => []);
    usbPresent.clear();
    for (const raw of list) {
      let d = usbKnown.get(raw.serial);
      if (!d) usbKnown.set(raw.serial, (d = new usb.UsbDevice(raw)));
      else if (d.device.raw !== raw.raw) d.update(raw);
      usbPresent.set(raw.serial, d);
    }
    grid.replaceChildren();
    panel.querySelector('.empty')?.remove();
    renderSidebar();
    if (!usbPresent.size) {
      panel.append(h('div', { class: 'empty' }, 'Bấm “Thêm thiết bị USB” và chọn điện thoại trong danh sách của trình duyệt.'));
      return;
    }
    for (const d of usbPresent.values()) {
      const actions = [viewButton(d)];
      if (d.connected) {
        actions.push(
          iconButton('unlink', 'Ngắt', {
            title: 'Giải phóng thiết bị USB (để dùng adb khác)',
            onclick: async () => {
              await d.disconnect();
              render();
            },
          }),
        );
      }
      grid.append(card(d, { meta: `WebUSB · ${d.serial}`, actions }));
    }
    applyFilter();
  };

  addUsbDevice = async () => {
    try {
      const raw = await usb.requestUsbDevice();
      if (!raw) return;
      await render();
      const d = usbPresent.get(raw.serial);
      if (d) view(d);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  };
  addButton.addEventListener('click', () => addUsbDevice());
  navigator.usb.addEventListener('connect', render);
  navigator.usb.addEventListener('disconnect', render);
  window.addEventListener('viewer:closed', render); // show the "Ngắt" button once connected
  await render();
}
setupUsb().catch((err) => console.error(err));
renderSidebar();
