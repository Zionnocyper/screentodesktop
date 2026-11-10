// Light / dark (night mode) theme. 'auto' follows the system setting.
// index.html applies the stored choice before first paint (no flash);
// this module keeps it in sync afterwards.
const THEME_KEY = 'screentodesktop.theme';
const media = matchMedia('(prefers-color-scheme: dark)');
let pref = read();

function read() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {}
  return 'auto';
}

export function getThemePref() {
  return pref;
}

export function isDark() {
  return pref === 'dark' || (pref === 'auto' && media.matches);
}

function apply() {
  const dark = isDark();
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = dark ? '#120f1a' : '#e9e1d6';
  document.head.append(meta);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { dark, pref } }));
}

/** 'auto' | 'light' | 'dark' */
export function setThemePref(next) {
  pref = next === 'light' || next === 'dark' ? next : 'auto';
  try {
    if (pref === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {}
  apply();
}

media.addEventListener('change', () => {
  if (pref === 'auto') apply();
});
apply();
