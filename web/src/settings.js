import { DEFAULT_OPTIONS, normalizeOptions } from './shared/scrcpy-options.js';

const KEY = 'screentodesktop.options.v1';

export function loadOptions() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalizeOptions(JSON.parse(raw));
  } catch {}
  return normalizeOptions(DEFAULT_OPTIONS);
}

export function saveOptions(options) {
  try {
    localStorage.setItem(KEY, JSON.stringify(options));
  } catch {}
}

function writeForm(form, options) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in options)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(options[el.name]);
    else el.value = String(options[el.name]);
  }
}

function readForm(form, base) {
  const out = { ...base };
  for (const el of form.elements) {
    if (!el.name || !(el.name in base)) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' && /^\d+$/.test(el.value) ? Number(el.value) : el.value;
  }
  return normalizeOptions(out);
}

export function setupSettings({ dialog, form, openButton, resetButton, onChange }) {
  let current = loadOptions();
  openButton.addEventListener('click', () => {
    writeForm(form, current);
    dialog.returnValue = ''; // Esc keeps the previous returnValue otherwise
    dialog.showModal();
  });
  resetButton.addEventListener('click', () => writeForm(form, normalizeOptions(DEFAULT_OPTIONS)));
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    current = readForm(form, current);
    saveOptions(current);
    onChange?.(current);
  });
  return {
    get options() {
      return current;
    },
  };
}
