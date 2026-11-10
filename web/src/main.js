import './styles.css';
import { SCRCPY_VERSION } from './shared/scrcpy-options.js';
import { opusSupported } from './scrcpy/audio.js';
import { H264Decoder } from './scrcpy/video.js';
import { ServerDevice, api, getServerSession, watchServerDevices } from './transport/server.js';
import { setupSettings } from './settings.js';
import { closeViewer, currentSession, openViewer, restoreViewer } from './viewer.js';
import { fillIcons, h, iconButton, setupTooltips, toast } from './ui.js';
import { icon } from './icons.js';
import { applyI18n, getLang, setLang, t } from './i18n.js';
import { getThemePref, isDark, setThemePref } from './theme.js';

const $ = (id) => document.getElementById(id);
const shell = $('shell');
fillIcons();
applyI18n();
$('scrcpy-version').textContent = SCRCPY_VERSION;
setupTooltips({ shell });

// ------------------------------------------------------------ settings + quick toggles
function syncQuickSettings(o) {
  $('sb-quality').textContent = o.maxSize ? String(o.maxSize) : t('sb.native');
  $('btn-settings').dataset.tip = t('sb.qualityTip', { size: o.maxSize || t('sb.nativeLower'), mbps: o.videoBitRate / 1e6, fps: o.maxFps });
  $('sb-audio').checked = o.audio;
  $('sb-audio-row').dataset.tip = o.audio ? t('sb.audioOn') : t('sb.audioOff');
}

const settings = setupSettings({
  dialog: $('settings'),
  form: $('settings-form'),
  openButton: $('btn-settings'),
  resetButton: $('settings-reset'),
  onChange: (o) => {
    syncQuickSettings(o);
    toast(t('v.savedSettings'), { timeout: 2000 });
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

// ------------------------------------------------------------ night mode + language
function syncTheme() {
  const dark = isDark();
  $('sb-night').checked = dark;
  $('sb-night-row').dataset.tip = dark ? t('sb.nightOn') : t('sb.nightOff');
  $('ui-theme').value = getThemePref();
}
$('sb-night').addEventListener('change', (e) => setThemePref(e.target.checked ? 'dark' : 'light'));
$('ui-theme').addEventListener('change', (e) => setThemePref(e.target.value));
window.addEventListener('themechange', syncTheme);
syncTheme();

function syncLang() {
  const lang = getLang();
  for (const b of document.querySelectorAll('.seg [data-lang]')) b.setAttribute('aria-checked', String(b.dataset.lang === lang));
  $('ui-lang').value = lang;
  $('sb-lang-row').dataset.tip = t('sb.languageTip');
}
for (const b of document.querySelectorAll('.seg [data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));
$('sb-lang-icon').addEventListener('click', () => setLang(getLang() === 'vi' ? 'en' : 'vi'));
$('ui-lang').addEventListener('change', (e) => setLang(e.target.value));
syncLang();

// Re-render everything that is built in JS when the language changes.
window.addEventListener('langchange', () => {
  syncLang();
  syncTheme();
  syncQuickSettings(settings.options);
  setCollapsed(shell.classList.contains('collapsed'));
  setGuideCollapsed($('wifi-guide').classList.contains('collapsed'));
  renderStatus();
  renderServer(serverData);
  renderUsb?.();
  renderWifiGuide();
  renderQrState();
  setPairBusy($('pair-submit').disabled);
  if (stopWatching && serverAuthed) startServerWatch(); // server-side messages follow the language too
  $('warnings').replaceChildren();
  checkSupport();
});

// ------------------------------------------------------------ warnings
function warn(text) {
  const box = h('div', { class: 'warning glass-inset' });
  box.innerHTML = icon('alert');
  box.append(h('div', {}, text));
  $('warnings').append(box);
}
function checkSupport() {
  if (!H264Decoder.supported) warn(t('warn.webcodecs'));
}
checkSupport();

// ------------------------------------------------------------ device presentation
const STATE = {
  device: ['dev.ready', 'ok'],
  unauthorized: ['dev.unauthorized', 'warn'],
  authorizing: ['dev.authorizing', 'warn'],
  offline: ['dev.offline', 'off'],
  connecting: ['dev.connecting', 'warn'],
  'no permissions': ['dev.noPermissions', 'warn'],
};

function stateOf(device) {
  const [key, cls] = STATE[device.state] ?? [null, 'off'];
  return [key ? t(key) : device.state, cls];
}

function look(device) {
  if (device.kind === 'usb') return { variant: 'blue', glyph: 'usb', where: 'WebUSB' };
  if (device.info?.wireless) return { variant: 'green', glyph: 'wifi', where: 'Wi-Fi' };
  return { variant: 'indigo', glyph: 'phone', where: t('dev.whereServer') };
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
  const [label, cls] = stateOf(device);
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

function viewButton(device, label = t('dev.view')) {
  return iconButton('play', label, {
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
  btn.dataset.tip = collapsed ? t('sb.expand') : t('sb.collapse');
  btn.setAttribute('aria-label', collapsed ? t('sb.expandAria') : t('sb.collapseAria'));
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
  group.dataset.empty = t('sb.noDevices');
  const active = currentSession()?.device ?? null;
  const all = [...usbPresent.values(), ...serverDevices.values()];
  group.replaceChildren(
    ...all.map((d) => {
      const { variant, glyph, where } = look(d);
      const [label, cls] = stateOf(d);
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
      if (isActive) item.append(h('span', { class: 'badge-count' }, t('sb.viewing')));
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
  pairOrGuide('qr');
});
$('sb-wifi-guide').addEventListener('click', () => {
  closeDrawer();
  showWifiGuide();
});
$('sb-usb').addEventListener('click', () => {
  closeDrawer();
  addUsbDevice();
});

// Status footer: a function so it can be re-rendered in another language.
let statusFn = () => ({ kind: '', title: t('sb.checking'), sub: '' });
function setStatus(fn) {
  statusFn = fn;
  renderStatus();
}
function renderStatus() {
  const { kind, title, sub } = statusFn();
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
  if (state === 'minimized') $('sb-session-stats').textContent = t('sb.running');
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

// ------------------------------------------------------------ Wi-Fi guide (live stepper)
let serverMode = null; // null = unknown, false = static hosting (no Node server), true = server
let serverAuthed = false;
const WG_COLLAPSED_KEY = 'screentodesktop.wifiGuide.collapsed';

function setGuideCollapsed(collapsed) {
  $('wifi-guide').classList.toggle('collapsed', collapsed);
  $('wg-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('wg-toggle-label').textContent = collapsed ? t('wg.expand') : t('wg.collapse');
  try {
    localStorage.setItem(WG_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {}
}
try {
  setGuideCollapsed(localStorage.getItem(WG_COLLAPSED_KEY) === '1');
} catch {
  setGuideCollapsed(false);
}
$('wg-toggle').addEventListener('click', () => setGuideCollapsed(!$('wifi-guide').classList.contains('collapsed')));

function showWifiGuide() {
  setGuideCollapsed(false);
  const current = document.querySelector('#wifi-guide .step.current') ?? $('wifi-guide');
  current.scrollIntoView({ behavior: 'smooth', block: current.id === 'wifi-guide' ? 'start' : 'center' });
}
$('hero-wifi').addEventListener('click', (e) => {
  e.preventDefault();
  showWifiGuide();
});

/** Opens the pairing dialog when a server is available, otherwise explains what is missing. */
function pairOrGuide(tab = 'qr') {
  if (serverMode && serverAuthed) return openPair({ tab });
  showWifiGuide();
  toast(serverMode ? t('wg.signInToast') : t('wg.needServerToast'), { type: 'error', timeout: 5000 });
}
$('wg-pair-qr').addEventListener('click', () => pairOrGuide('qr'));
$('wg-pair').addEventListener('click', () => pairOrGuide('code'));

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(btn.dataset.copy).textContent);
      toast(t('wg.copied'), { type: 'ok', timeout: 1600 });
    } catch {
      toast(t('wg.copyFailed'), { type: 'error' });
    }
  });
}

function live(id, text, kind = 'ok') {
  const el = $(id);
  el.className = `step-live${kind === 'ok' ? '' : ` ${kind}`}`;
  el.replaceChildren();
  if (!text) return;
  if (kind === 'ok') el.insertAdjacentHTML('afterbegin', icon('check'));
  el.append(text);
}

function renderWifiGuide() {
  const wireless = [...serverDevices.values()].filter((d) => d.info?.wireless && d.state === 'device');
  const discovered = serverData.discovered ?? [];
  const waiting = discovered.filter((s) => s.type === 'pairing' && !s.connected);
  const advertising = discovered.filter((s) => s.type === 'connect' && !s.connected);
  const names = (list) => [...new Set(list.map(discoveredName))].join(', ');

  const done = {
    install: serverMode === true,
    server: serverMode === true,
    phone: wireless.length > 0 || waiting.length > 0 || advertising.length > 0,
    pair: wireless.length > 0,
    view: wireless.length > 0,
  };

  if (serverMode === true) {
    live('wg-live-install', t('wg.live.installed'));
    live('wg-live-server', t('wg.live.serverAt', { host: location.host }) + (serverAuthed ? '' : t('wg.live.needSignIn')));
  } else if (serverMode === false) {
    live('wg-live-install', '');
    live('wg-live-server', t('wg.live.static'), 'warn');
  } else {
    live('wg-live-install', '');
    live('wg-live-server', t('wg.live.checking'), 'wait');
  }
  $('wg-open-local').hidden = serverMode !== false;

  if (wireless.length) live('wg-live-phone', t('wg.live.connected', { names: wireless.map((d) => d.name).join(', ') }));
  else if (waiting.length) live('wg-live-phone', t('wg.live.waiting', { names: names(waiting) }));
  else if (advertising.length) live('wg-live-phone', t('wg.live.advertising', { names: names(advertising) }));
  else if (serverMode && serverAuthed && serverData.mdns === false) live('wg-live-phone', t('wg.live.mdnsOff'), 'warn');
  else if (serverMode && serverAuthed) live('wg-live-phone', t('wg.live.searching'), 'wait');
  else live('wg-live-phone', '');

  if (wireless.length) live('wg-live-pair', t('wg.live.paired'));
  else if (!serverMode) live('wg-live-pair', t('wg.live.needServer'), 'warn');
  else if (!serverAuthed) live('wg-live-pair', t('wg.live.signInFirst'), 'warn');
  else if (waiting.length) live('wg-live-pair', t('wg.live.pairNow', { names: names(waiting) }), 'wait');
  else live('wg-live-pair', '');

  $('wg-view-actions').replaceChildren(...wireless.map((d) => viewButton(d, t('dev.viewName', { name: d.name }))));

  const order = ['install', 'server', 'phone', 'pair', 'view'];
  const current = order.find((k) => !done[k]);
  order.forEach((k, i) => {
    const li = $(`wg-step-${k}`);
    li.classList.toggle('done', done[k]);
    li.classList.toggle('current', k === current);
    li.querySelector('.step-num').innerHTML = done[k] ? icon('check') : String(i + 1);
  });

  const status = $('wg-status');
  if (wireless.length) {
    status.className = 'pill pill--state ok';
    status.textContent = t('wg.status.connected');
  } else if (serverMode === false) {
    status.className = 'pill pill--state warn';
    status.textContent = t('wg.status.needServer');
  } else if (serverMode) {
    status.className = 'pill pill--state';
    status.textContent = t('wg.status.step', { n: order.indexOf(current) + 1 });
  } else status.textContent = '';
}

// ------------------------------------------------------------ server devices
const serverDevices = new Map();
let stopWatching = null;
let serverData = { devices: [], discovered: [], mdns: null, error: null };

function renderServer(data) {
  serverData = { devices: [], discovered: [], mdns: null, error: null, ...data };
  // studio-* pairing services come from our own QR codes: the QR flow handles them
  serverData.discovered = (serverData.discovered ?? []).filter((s) => !(s.type === 'pairing' && s.instance.startsWith('studio-')));
  if (!serverMode) return;
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

  if (!serverAuthed) return;
  $('sb-connect').hidden = false;
  if (error) setStatus(() => ({ kind: 'warn', title: t('st.adbNotReady'), sub: serverData.error }));
  else setStatus(() => ({ kind: 'ok', title: t('st.serverRunning'), sub: t('st.devicesCount', { host: location.host, n: serverDevices.size }) }));

  grid.replaceChildren();
  $('panel-server').querySelector('.empty')?.remove();
  renderDiscovered();
  renderPairDetected();
  renderSidebar();
  renderWifiGuide();
  if (error) {
    grid.after(h('div', { class: 'empty' }, t('server.adbError', { error })));
    return;
  }
  if (!serverDevices.size) {
    grid.after(h('div', { class: 'empty' }, t('server.empty')));
    return;
  }
  for (const d of serverDevices.values()) {
    const i = d.info;
    const where = i.wireless ? `Wi-Fi${i.address ? ` ${i.address}` : ''}` : 'USB';
    const meta = [i.androidVersion && `Android ${i.androidVersion}`, where, i.wireless && i.address ? null : d.serial].filter(Boolean).join(' · ');
    const hint =
      d.state === 'unauthorized' ? t('dev.hintUnauthorized') : d.state === 'no permissions' ? t('dev.hintNoPermissions') : null;
    const actions = [viewButton(d)];
    if (i.wireless) {
      actions.push(
        iconButton('unlink', t('dev.disconnect'), {
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
      actions.push(iconButton('wifi', 'Wi-Fi', { title: t('dev.wifiBtnTip'), onclick: () => enableWifi(d) }));
    }
    grid.append(card(d, { meta, hint, actions }));
  }
  applyFilter();
}

async function enableWifi(device) {
  const tt = toast(t('wifi.enabling'), { timeout: 0 });
  try {
    const { ip, port } = await device.enableWifi();
    if (!ip) {
      tt.done(t('wifi.noIp'), 'error');
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const { message } = await api('/api/adb/connect', { method: 'POST', body: { address: `${ip}:${port}` } });
    tt.done(t('wifi.unplug', { message }));
  } catch (err) {
    tt.done(err.message, 'error');
  }
}

// ------------------------------------------------------------ Wi-Fi: discovery
function discoveredName(s) {
  return s.name || (s.serialHint ? t('server.phone', { serial: s.serialHint }) : s.instance);
}

/** Phones advertising Wireless debugging (or a pairing code) that are not connected yet. */
function renderDiscovered() {
  const all = serverData.discovered ?? [];
  // A phone showing its pairing dialog also advertises its connect service: show it once.
  const waiting = new Set(all.filter((s) => s.type === 'pairing').map((s) => s.instance));
  const items = all.filter((s) => !s.connected && !(s.type === 'connect' && waiting.has(s.instance)) && !s.instance.startsWith('studio-'));
  const grid = $('discovered-list');
  grid.replaceChildren();
  $('server-discovered').hidden = !items.length;
  for (const s of items) {
    const pairing = s.type === 'pairing';
    const action = pairing
      ? iconButton('link', t('server.pair'), { class: 'btn primary', onclick: () => openPair({ tab: 'code', address: s.address }) })
      : iconButton('wifi', t('server.connect'), { class: 'btn primary', onclick: () => connectAddress(s.target, discoveredName(s)) });
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
            h('div', { class: 'device-meta' }, `${pairing ? t('server.waitingPair') : t('server.wirelessDebugging')} · ${s.address}`),
          ),
          h('span', { class: `badge ${pairing ? 'warn' : 'off'}` }, pairing ? t('server.badgeWaiting') : t('server.badgeNotConnected')),
        ),
        !pairing && h('div', { class: 'device-note' }, t('server.connectNote')),
        h('div', { class: 'device-actions' }, action),
      ),
    );
  }
}

async function connectAddress(address, label = address) {
  const tt = toast(t('server.connecting', { label }), { timeout: 0 });
  try {
    const { message } = await api('/api/adb/connect', { method: 'POST', body: { address } });
    tt.done(message);
    return true;
  } catch (err) {
    tt.done(err.message, 'error');
    return false;
  }
}

// ------------------------------------------------------------ pairing dialog (QR + 6-digit code)
const pairDialog = $('pair-dialog');
let pairTab = 'qr';

function setPairTab(tab) {
  pairTab = tab;
  for (const b of document.querySelectorAll('#pair-dialog .tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('pair-panel-qr').hidden = tab !== 'qr';
  $('pair-panel-code').hidden = tab !== 'code';
  $('pair-submit').hidden = tab !== 'code';
  if (tab === 'qr') startQr();
  else {
    stopQr();
    renderPairDetected();
    ($('pair-address').value ? $('pair-code') : $('pair-address')).focus();
  }
}
for (const b of document.querySelectorAll('#pair-dialog .tab')) b.addEventListener('click', () => setPairTab(b.dataset.tab));

function renderPairDetected() {
  if (!pairDialog.open) return;
  const pairing = (serverData.discovered ?? []).filter((s) => s.type === 'pairing' && !s.instance.startsWith('studio-'));
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

function openPair({ tab = 'qr', address = '' } = {}) {
  $('pair-address').value = address;
  $('pair-code').value = '';
  $('pair-error').hidden = true;
  setPairBusy(false);
  pairDialog.showModal();
  // QR pairing needs the server to discover the phone through mDNS.
  setPairTab(serverData.mdns === false ? 'code' : tab);
}

function setPairBusy(busy) {
  $('pair-submit').disabled = busy;
  $('pair-submit-label').textContent = busy ? t('pd.busy') : t('pd.submit');
}

$('btn-pair').addEventListener('click', () => openPair({ tab: 'qr' }));
$('pair-x').addEventListener('click', () => pairDialog.close());
$('pair-cancel').addEventListener('click', () => pairDialog.close());
pairDialog.addEventListener('close', stopQr);
$('pair-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (pairTab !== 'code') return;
  const address = $('pair-address').value.trim();
  const code = $('pair-code').value.trim();
  const error = $('pair-error');
  error.hidden = true;
  const fail = (msg, field) => {
    error.textContent = msg;
    error.hidden = false;
    field?.focus();
  };
  if (!/^(\[[^\]]+\]|[\w.-]+):\d{1,5}$/.test(address)) return fail(t('pd.badAddress'), $('pair-address'));
  if (!/^\d{6}$/.test(code)) return fail(t('pd.badCode'), $('pair-code'));
  setPairBusy(true);
  try {
    const result = await api('/api/adb/pair', { method: 'POST', body: { address, code } });
    pairDialog.close();
    if (result.connected) toast(t('pd.done'), { type: 'ok', timeout: 6000 });
    else toast(result.hint || t('pd.paired'), { type: 'ok', timeout: 10000 });
  } catch (err) {
    fail(err.message);
  } finally {
    setPairBusy(false);
  }
});

// --- QR code pairing
let qr = null; // { id, state, message, hint, expiresIn, poll, tick, mdnsOff }

async function qrSvg(text) {
  const { default: qrcode } = await import('qrcode-generator'); // loaded only when needed
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const n = code.getModuleCount();
  const m = 2; // quiet zone (the white box adds more)
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (code.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const size = n + m * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}

function formatSeconds(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderQrState() {
  const status = $('qr-status');
  const box = $('qr-box');
  if (!qr) {
    status.className = 'qr-status';
    status.textContent = '';
    return;
  }
  const finished = ['connected', 'paired', 'error', 'expired'].includes(qr.state);
  box.classList.toggle('dim', ['error', 'expired', 'creating'].includes(qr.state) || qr.mdnsOff);
  box.classList.toggle('done', qr.state === 'connected' || qr.state === 'paired');
  $('qr-new').hidden = !['error', 'expired'].includes(qr.state) && !qr.mdnsOff;
  $('qr-expires').textContent = !finished && qr.expiresIn > 0 ? t('qr.expiresIn', { t: formatSeconds(qr.expiresIn) }) : '';
  const set = (cls, text) => {
    status.className = `qr-status ${cls}`;
    status.textContent = text;
  };
  if (qr.mdnsOff) return set('error', t('qr.mdnsOff'));
  switch (qr.state) {
    case 'creating':
      return set('wait', t('qr.creating'));
    case 'waiting':
      return set('wait', t('qr.waiting'));
    case 'pairing':
      return set('wait', t('qr.pairing'));
    case 'connected':
      return set('ok', t('qr.connected'));
    case 'paired':
      return set('ok', qr.hint || t('pd.paired'));
    case 'expired':
      return set('error', t('qr.expired'));
    default:
      return set('error', t('qr.error', { m: qr.message || '' }));
  }
}

function stopQr() {
  if (!qr) return;
  clearInterval(qr.poll);
  clearInterval(qr.tick);
  const { id, state } = qr;
  if (id && !['connected', 'paired'].includes(state)) api(`/api/adb/qr/${id}`, { method: 'DELETE' }).catch(() => {});
  qr = null;
}

async function startQr() {
  stopQr();
  const mine = (qr = { id: null, state: 'creating', expiresIn: 0 });
  $('qr-code').innerHTML = '';
  renderQrState();
  let created;
  try {
    created = await api('/api/adb/qr', { method: 'POST', body: {} });
  } catch (err) {
    if (qr !== mine) return;
    Object.assign(qr, { state: 'error', message: err.message });
    return renderQrState();
  }
  if (qr !== mine) return; // closed or restarted meanwhile
  Object.assign(qr, created, { mdnsOff: created.mdns === false });
  const svg = await qrSvg(created.qr);
  if (qr !== mine) return;
  $('qr-code').innerHTML = svg;
  renderQrState();
  qr.tick = setInterval(() => {
    if (qr !== mine) return;
    qr.expiresIn = Math.max(0, qr.expiresIn - 1);
    renderQrState();
  }, 1000);
  qr.poll = setInterval(async () => {
    if (qr !== mine) return;
    let st;
    try {
      st = await api(`/api/adb/qr/${mine.id}`);
    } catch {
      return;
    }
    if (qr !== mine) return;
    Object.assign(qr, st);
    renderQrState();
    if (['connected', 'paired', 'error', 'expired'].includes(st.state)) {
      clearInterval(qr.poll);
      clearInterval(qr.tick);
      if (st.state === 'connected') {
        toast(t('pd.done'), { type: 'ok', timeout: 6000 });
        setTimeout(() => {
          if (qr === mine) pairDialog.close();
        }, 1600);
      }
    }
  }, 1000);
}
$('qr-new').addEventListener('click', () => startQr());

// ------------------------------------------------------------ server session + login
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
  $('sb-connect').hidden = true;
  serverAuthed = false;
  setStatus(() => ({ kind: 'warn', title: t('st.signIn'), sub: location.host }));
  renderSidebar();
  renderWifiGuide();
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
    serverAuthed = true;
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
    serverMode = false;
    renderWifiGuide();
    const usbOk = 'usb' in navigator && window.isSecureContext;
    setStatus(() => ({ kind: usbOk ? 'ok' : 'warn', title: t('st.webusbMode'), sub: usbOk ? t('st.webusbSub') : t('st.noWebusb') }));
    return;
  }
  serverMode = true;
  serverAuthed = !session.authRequired || session.authenticated;
  renderWifiGuide();
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
let renderUsb = null;
let addUsbDevice = () => toast(t('usb.notAvailable'), { type: 'error' });

async function setupUsb() {
  const grid = $('usb-devices');
  const addButton = $('btn-usb-add');
  const panel = $('panel-usb');

  const unsupported = (key) => {
    addButton.disabled = true;
    $('sb-usb').disabled = true;
    const show = () => {
      panel.querySelector('.empty')?.remove();
      panel.append(h('div', { class: 'empty' }, t(key)));
    };
    show();
    renderUsb = show;
  };
  if (!('usb' in navigator)) return unsupported('usb.unsupported');
  if (!window.isSecureContext) return unsupported('usb.insecure');

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
      panel.append(h('div', { class: 'empty' }, t('usb.empty')));
      return;
    }
    for (const d of usbPresent.values()) {
      const actions = [viewButton(d)];
      if (d.connected) {
        actions.push(
          iconButton('unlink', t('dev.disconnect'), {
            title: t('usb.release'),
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
  renderUsb = render;

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
  window.addEventListener('viewer:closed', render); // show the "Disconnect" button once connected
  await render();
}
setupUsb().catch((err) => console.error(err));
renderSidebar();
renderWifiGuide();
renderStatus();
