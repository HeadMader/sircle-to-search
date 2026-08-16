import type { Settings, SettingsBridge } from '../preload/settings-preload';

declare global {
  interface Window {
    settingsBridge: SettingsBridge;
  }
}

const bridge = window.settingsBridge;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const translateTarget = $<HTMLSelectElement>('translate-target');
const launchStartup = $<HTMLInputElement>('launch-startup');
const saved = $<HTMLDivElement>('saved');
const modeRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="default-mode"]')
);

let savedTimer = 0;

function currentState(): Settings {
  const checked = modeRadios.find((r) => r.checked);
  return {
    translateTarget: translateTarget.value,
    defaultMode: checked?.value === 'translate' ? 'translate' : 'search',
    launchAtStartup: launchStartup.checked
  };
}

function applyState(s: Settings) {
  // a stored code outside the built-in list still gets shown faithfully
  if (!Array.from(translateTarget.options).some((o) => o.value === s.translateTarget)) {
    const opt = document.createElement('option');
    opt.value = s.translateTarget;
    opt.textContent = s.translateTarget;
    translateTarget.append(opt);
  }
  translateTarget.value = s.translateTarget;
  for (const r of modeRadios) r.checked = r.value === s.defaultMode;
  launchStartup.checked = s.launchAtStartup;
}

function flashSaved() {
  saved.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => saved.classList.remove('show'), 1400);
}

async function save() {
  await bridge.set(currentState());
  flashSaved();
}

const onChange = () => void save().catch(console.error);
for (const el of [translateTarget, launchStartup, ...modeRadios]) {
  el.addEventListener('change', onChange);
}

void bridge
  .get()
  .then((s) => applyState(s))
  .catch(console.error);
