import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface Settings {
  /** BCP-47ish code ('uk', 'pt-BR') or 'system' = resolve from app.getLocale() */
  translateTarget: string;
  defaultMode: 'search' | 'translate';
  launchAtStartup: boolean;
}

const DEFAULTS: Settings = {
  translateTarget: 'system',
  defaultMode: 'search',
  launchAtStartup: false
};

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

let cached: Settings | null = null;
let settingsWindow: BrowserWindow | null = null;
let ipcRegistered = false;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Coerce arbitrary JSON into a valid Settings object (unknown fields dropped). */
function sanitize(raw: unknown): Settings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const translateTarget =
    typeof obj.translateTarget === 'string' &&
    (obj.translateTarget === 'system' || LANG_RE.test(obj.translateTarget))
      ? obj.translateTarget
      : DEFAULTS.translateTarget;
  const defaultMode =
    obj.defaultMode === 'search' || obj.defaultMode === 'translate'
      ? obj.defaultMode
      : DEFAULTS.defaultMode;
  return { translateTarget, defaultMode, launchAtStartup: Boolean(obj.launchAtStartup) };
}

/** Synchronous, cached read; a missing or corrupt file yields defaults. */
export function getSettings(): Settings {
  if (cached) return cached;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    raw = null;
  }
  cached = sanitize(raw);
  return cached;
}

function saveSettings(raw: unknown): Settings {
  const settings = sanitize(raw);
  cached = settings;
  try {
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('settings: failed to persist', err);
  }
  app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup });
  return settings;
}

/** Translation target language, with 'system' resolved from the OS locale. */
export function resolveTranslateTarget(): string {
  const { translateTarget } = getSettings();
  if (translateTarget !== 'system') return translateTarget;
  return app.getLocale().split('-')[0] || 'en';
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, raw: unknown) => saveSettings(raw));
}

export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }
  registerIpc();
  const win = new BrowserWindow({
    width: 400,
    height: 480,
    title: 'Sircle to Search — Settings',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#202124',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      contextIsolation: true
    }
  });
  settingsWindow = win;
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  void win.loadFile(path.join(__dirname, 'settings.html'));
}
