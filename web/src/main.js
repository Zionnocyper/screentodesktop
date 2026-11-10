import './styles.css';
import { SCRCPY_VERSION } from './shared/scrcpy-options.js';
import { opusSupported } from './scrcpy/audio.js';
import { H264Decoder } from './scrcpy/video.js';
import { ServerDevice, api, getServerSession, watchServerDevices } from './transport/server.js';
import { setupSettings } from './settings.js';
import { openViewer } from './viewer.js';
import { fillIcons, h, iconButton, toast } from './ui.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
fillIcons();
$('scrcpy-version').textContent = SCRCPY_VERSION;

const settings = setupSettings({
  dialog: $('settings'),
  form: $('settings-form'),
  openButton: $('btn-settings'),
  resetButton: $('settings-reset'),
  onChange: () => toast('Đã lưu. Áp dụng cho lần xem tiếp theo.', { timeout: 2000 }),
});

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
  openViewer(device, streamOptions());
}

// ------------------------------------------------------------ warnings
function warn(text) {
  const box = h('div', { class: 'warning' });
  box.innerHTML = icon('alert');
  box.append(h('div', {}, text));
  $('warnings').append(box);
}
if (!H264Decoder.supported) {
  warn('Trình duyệt này không có WebCodecs nên không giải mã được video. Hãy dùng Chrome, Edge, Firefox 130+ hoặc Safari 17+.');
}

// ------------------------------------------------------------ device cards
const STATE = {
  device: ['Sẵn sàng', 'ok'],
  unauthorized: ['Chưa cho phép', 'warn'],
  authorizing: ['Đang xác thực', 'warn'],
  offline: ['Ngoại tuyến', 'off'],
  connecting: ['Đang kết nối', 'warn'],
  'no permissions': ['Thiếu quyền USB', 'warn'],
};

function card(device, { meta, hint, actions }) {
  const [label, cls] = STATE[device.state] ?? [device.state, 'off'];
  const avatar = h('div', { class: 'device-avatar' });
  avatar.innerHTML = icon(device.kind === 'usb' ? 'usb' : device.info?.wireless ? 'wifi' : 'phone');
  return h(
    'article',
    { class: 'device-card' },
    h(
      'div',
      { class: 'device-top' },
      avatar,
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

  grid.replaceChildren();
  $('panel-server').querySelector('.empty')?.remove();
  renderDiscovered();
  renderPairDetected();
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
      actions.push(
        iconButton('wifi', 'Wi-Fi', {
          title: 'Bật ADB qua Wi-Fi để rút cáp',
          onclick: () => enableWifi(d),
        }),
      );
    }
    grid.append(card(d, { meta, hint, actions }));
  }
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
    const avatar = h('div', { class: 'device-avatar' });
    avatar.innerHTML = icon(pairing ? 'link' : 'wifi');
    const action = pairing
      ? iconButton('link', 'Ghép đôi', { class: 'btn primary', onclick: () => openPair(s.address) })
      : iconButton('wifi', 'Kết nối', { class: 'btn primary', onclick: () => connectAddress(s.target, discoveredName(s)) });
    grid.append(
      h(
        'article',
        { class: 'device-card' },
        h(
          'div',
          { class: 'device-top' },
          avatar,
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
  $('server-devices').replaceChildren();
  $('server-discovered').hidden = true;
  $('panel-server').querySelector('.empty')?.remove();
  $('server-login').hidden = false;
  $('server-actions').hidden = true;
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
  if (!session) return; // static hosting: WebUSB only
  $('panel-server').hidden = false;
  if (session.authRequired) $('btn-logout').hidden = !session.authenticated;
  if (session.authRequired && !session.authenticated) showLogin();
  else startServerWatch();
});

// ------------------------------------------------------------ WebUSB devices
async function setupUsb() {
  const grid = $('usb-devices');
  const addButton = $('btn-usb-add');
  const panel = $('panel-usb');

  if (!('usb' in navigator)) {
    addButton.disabled = true;
    panel.append(h('div', { class: 'empty' }, 'Trình duyệt này không hỗ trợ WebUSB. Dùng Chrome hoặc Edge trên máy tính / Android.'));
    return;
  }
  if (!window.isSecureContext) {
    addButton.disabled = true;
    panel.append(h('div', { class: 'empty' }, 'WebUSB chỉ chạy trên HTTPS hoặc http://localhost. Hãy mở trang qua HTTPS.'));
    return;
  }

  const usb = await import('./transport/webusb.js');
  // Wrappers are kept even while a phone is briefly gone (USB re-enumeration),
  // so an open viewer keeps a wrapper that gets the fresh USBDevice.
  const known = new Map();
  const devices = new Map(); // currently present

  const render = async () => {
    const list = await usb.listUsbDevices().catch(() => []);
    devices.clear();
    for (const raw of list) {
      let d = known.get(raw.serial);
      if (!d) known.set(raw.serial, (d = new usb.UsbDevice(raw)));
      else if (d.device.raw !== raw.raw) d.update(raw);
      devices.set(raw.serial, d);
    }
    grid.replaceChildren();
    panel.querySelector('.empty')?.remove();
    if (!devices.size) {
      panel.append(h('div', { class: 'empty' }, 'Bấm “Thêm thiết bị USB” và chọn điện thoại trong danh sách của trình duyệt.'));
      return;
    }
    for (const d of devices.values()) {
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
  };

  addButton.addEventListener('click', async () => {
    try {
      const raw = await usb.requestUsbDevice();
      if (!raw) return;
      await render();
      const d = devices.get(raw.serial);
      if (d) view(d);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  });
  navigator.usb.addEventListener('connect', render);
  navigator.usb.addEventListener('disconnect', render);
  window.addEventListener('viewer:closed', render); // show the "Ngắt" button once connected
  await render();
}
setupUsb().catch((err) => console.error(err));
