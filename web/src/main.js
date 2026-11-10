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

function renderServer({ devices = [], error = null }) {
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
  if (error) {
    grid.after(h('div', { class: 'empty' }, `Không kết nối được adb trên server: ${error}`));
    return;
  }
  if (!serverDevices.size) {
    grid.after(h('div', { class: 'empty' }, 'Chưa có thiết bị nào. Cắm điện thoại vào máy chủ (đã bật Gỡ lỗi USB) hoặc kết nối qua Wi-Fi.'));
    return;
  }
  for (const d of serverDevices.values()) {
    const i = d.info;
    const meta = [i.androidVersion && `Android ${i.androidVersion}`, i.wireless ? 'Wi-Fi' : 'USB', d.serial].filter(Boolean).join(' · ');
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

function startServerWatch() {
  stopWatching?.();
  stopWatching = watchServerDevices(renderServer, () => showLogin());
}

function showLogin() {
  stopWatching?.();
  stopWatching = null;
  $('server-devices').replaceChildren();
  $('panel-server').querySelector('.empty')?.remove();
  $('server-login').hidden = false;
  $('form-connect').hidden = true;
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
    $('form-connect').hidden = false;
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
  const t = toast(`Đang kết nối ${address}…`, { timeout: 0 });
  try {
    const { message } = await api('/api/adb/connect', { method: 'POST', body: { address } });
    t.done(message);
    input.value = '';
  } catch (err) {
    t.done(err.message, 'error');
  }
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
  const devices = new Map();

  const render = async () => {
    const list = await usb.listUsbDevices().catch(() => []);
    const seen = new Set();
    for (const raw of list) {
      seen.add(raw.serial);
      if (!devices.has(raw.serial)) devices.set(raw.serial, new usb.UsbDevice(raw));
    }
    for (const serial of devices.keys()) if (!seen.has(serial)) devices.delete(serial);
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
  await render();
}
setupUsb().catch((err) => console.error(err));
