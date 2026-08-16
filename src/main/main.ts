import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
  WebContentsView
} from 'electron';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lensUploadRequest } from './lens';
import { ocrImage } from './ocr';
import { translateLines } from './translate';
import { recognizeMusic } from './music';

if (!app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', '9223');

// Google 403s the Lens results page over h2/h3 from embedded browsers;
// over HTTP/1.1 the same request succeeds (verified by header/protocol bisect).
app.commandLine.appendSwitch('disable-http2');
app.commandLine.appendSwitch('disable-quic');

// Google flags UAs carrying Electron/app-name tokens as bots (403 / sorry
// page); present as plain Chrome matching the real Chromium version.
app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

let overlay: BrowserWindow | null = null;
let sheetView: WebContentsView | null = null;
let tray: Tray | null = null;
let activeShortcut = '';
let hotkeyHelper: ChildProcess | null = null;
let lastHotkeyAt = 0;

const FALLBACK_SHORTCUT = 'Control+Shift+Space';

async function captureDisplayUnderCursor() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    }
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source) throw new Error('No screen source available');
  return { display, png: source.thumbnail.toPNG() };
}

function closeSheet() {
  if (sheetView) {
    overlay?.contentView.removeChildView(sheetView);
    sheetView.webContents.close();
    sheetView = null;
  }
}

function closeOverlay() {
  closeSheet();
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
}

interface SheetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function showResultsInSheet(win: BrowserWindow, png: Buffer, rect: SheetRect) {
  if (!sheetView || sheetView.webContents.isDestroyed()) {
    const view = new WebContentsView();
    sheetView = view;
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//.test(target)) {
        // dismiss the always-on-top overlay first or the browser opens under it
        closeOverlay();
        void shell.openExternal(target);
      }
      return { action: 'deny' };
    });
    const v = view as unknown as { setBorderRadius?: (r: number) => void };
    v.setBorderRadius?.(16);
    view.setBackgroundColor('#202124');
    win.contentView.addChildView(view);
  }
  const view = sheetView;
  // stay out of sight until the sheet chrome's slide-up lands
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  setTimeout(() => {
    if (view === sheetView && !win.isDestroyed()) {
      view.setBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.w),
        height: Math.round(rect.h)
      });
    }
  }, 440);
  const req = lensUploadRequest(png);
  try {
    await view.webContents.loadURL(req.url, {
      postData: req.postData,
      extraHeaders: req.extraHeaders
    });
  } catch (err) {
    // ERR_ABORTED: the results page immediately re-navigates itself to its
    // canonical URL — that is the success path, not a failure.
    if (!/ERR_ABORTED/.test(String(err))) throw err;
  }
}

async function toggleOverlay() {
  if (overlay) {
    closeOverlay();
    return;
  }
  const { display, png } = await captureDisplayUnderCursor();
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true
    }
  });
  overlay = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);
  win.setBounds(display.bounds);
  win.on('closed', () => {
    if (overlay === win) {
      overlay = null;
      sheetView = null;
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win.webContents.on('console-message' as any, (...args: any[]) => {
    const d = args[0];
    const msg = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
    console.log('[overlay]', msg);
  });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('overlay:init', {
      png,
      scaleFactor: display.scaleFactor,
      targetLang: app.getLocale().split('-')[0] || 'en',
      shortcut: activeShortcut
    });
    win.show();
    win.focus();
  });
  await win.loadFile(path.join(__dirname, 'overlay.html'));
}

function onHotkey() {
  // the low-level hook fires on key auto-repeat too
  const now = Date.now();
  if (now - lastHotkeyAt < 350) return;
  lastHotkeyAt = now;
  void toggleOverlay().catch(console.error);
}

function registerFallbackShortcut() {
  if (activeShortcut === FALLBACK_SHORTCUT) return;
  if (globalShortcut.register(FALLBACK_SHORTCUT, onHotkey)) {
    setActiveShortcut(FALLBACK_SHORTCUT);
    console.log(`Shortcut registered: ${FALLBACK_SHORTCUT}`);
  } else {
    console.error('Could not register any global shortcut');
  }
}

/**
 * Win+Space is owned by the Windows shell, so it is taken over by a small
 * native helper with a low-level keyboard hook (src/native/HotkeyHelper.cs)
 * that reports presses on stdout.
 */
function registerShortcut() {
  const exe = path.join(__dirname, 'hotkey-helper.exe');
  if (process.platform !== 'win32' || !existsSync(exe)) {
    registerFallbackShortcut();
    return;
  }
  const proc = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  hotkeyHelper = proc;
  setActiveShortcut('Super+Space');
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line === 'HOTKEY') onHotkey();
      else if (line === 'READY') console.log('Shortcut registered: Win+Space');
      else if (line === 'HOOK_FAILED') proc.kill();
    }
  });
  const fallBack = () => {
    if (hotkeyHelper === proc) {
      hotkeyHelper = null;
      activeShortcut = '';
      registerFallbackShortcut();
    }
  };
  proc.on('error', fallBack);
  proc.on('exit', fallBack);
}

function setActiveShortcut(combo: string) {
  activeShortcut = combo;
  updateTray();
}

function trayIcon() {
  // 16x16 BGRA blue circle, drawn in memory so we need no icon asset on disk
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = d < 6 ? 255 : d < 7 ? Math.round(255 * (7 - d)) : 0;
      const i = (y * size + x) * 4;
      buf[i] = 244; // B
      buf[i + 1] = 133; // G
      buf[i + 2] = 66; // R
      buf[i + 3] = alpha;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTray() {
  if (!app.isReady()) return;
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.on('click', () => void toggleOverlay().catch(console.error));
  }
  const label = activeShortcut ? activeShortcut.replace('Super', 'Win') : 'no shortcut';
  tray.setToolTip(`Sircle to Search  (${label})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Capture  (${label})`, click: () => void toggleOverlay().catch(console.error) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  );
}

// The NID cookie (minted by the Lens upload itself) makes google.com/search
// return 403 in an embedded browser; the same request cookieless returns the
// real results page. Strip cookies from /search navigations only.
function setupCookieStrip() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.google.com/*'] },
    (details, callback) => {
      const headers = details.requestHeaders;
      if (
        details.resourceType === 'mainFrame' &&
        details.url.startsWith('https://www.google.com/search')
      ) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
        if (key) delete headers[key];
      }
      callback({ requestHeaders: headers });
    }
  );
}

function setupLoopbackAudio() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
}

function setupIpc() {
  ipcMain.handle('lens-search', async (e, png: Uint8Array, rect: SheetRect) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    await showResultsInSheet(win, Buffer.from(png), rect);
  });
  ipcMain.on('sheet:close', () => closeSheet());
  // Music mode shrinks the window to just the card: a fullscreen always-on-top
  // window makes Chrome consider itself occluded and freeze video rendering.
  let fullBounds: Electron.Rectangle | null = null;
  ipcMain.on('music-mode', (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    if (on) {
      fullBounds = win.getBounds();
      const w = 640;
      const h = 420;
      win.setBounds({
        x: fullBounds.x + Math.round((fullBounds.width - w) / 2),
        y: fullBounds.y + fullBounds.height - h - 24,
        width: w,
        height: h
      });
    } else if (fullBounds) {
      win.setBounds(fullBounds);
      fullBounds = null;
    }
  });
  ipcMain.handle('ocr', async (_e, png: Uint8Array) => ocrImage(Buffer.from(png)));
  ipcMain.handle('translate', async (_e, lines: string[], target: string) =>
    translateLines(lines, target)
  );
  ipcMain.handle('recognize-music', async (_e, pcm: ArrayBuffer) =>
    recognizeMusic(new Int16Array(pcm))
  );
  ipcMain.handle('open-url-and-close', async (_e, url: string) => {
    // close first: with the always-on-top overlay alive the browser opens
    // behind it without focus
    closeOverlay();
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.on('overlay:close', () => closeOverlay());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => void toggleOverlay().catch(console.error));
  app.whenReady().then(() => {
    setupCookieStrip();
    setupLoopbackAudio();
    setupIpc();
    registerShortcut();
    updateTray();
    console.log('Sircle to Search ready.');
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    hotkeyHelper?.kill();
  });
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
}
