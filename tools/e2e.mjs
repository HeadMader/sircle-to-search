// CDP regression harness for the running app (needs `npm start` in another
// process; unpackaged builds expose devtools on 9223).
// Usage: node tools/e2e.mjs [all|words|textselect|lasso|translate|music]
import WebSocket from 'ws';
import { execSync } from 'node:child_process';

const DBG = 'http://127.0.0.1:9223';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

const targets = async () => (await fetch(`${DBG}/json/list`)).json();

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  });
  ws.on('close', () => {
    for (const p of pending.values()) p.resolve(null);
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== 1) return resolve(null);
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, send }));
    ws.on('error', reject);
  });
}

async function openOverlay() {
  let t = (await targets()).find((x) => x.url.includes('overlay.html'));
  if (!t) {
    execSync('npx electron .', { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 40 && !t; i++) {
      await sleep(250);
      t = (await targets()).find((x) => x.url.includes('overlay.html'));
    }
  }
  if (!t) throw new Error('overlay never appeared — is the app running?');
  const { ws, send } = await connect(t.webSocketDebuggerUrl);
  await send('Runtime.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (!r) throw new Error('overlay connection closed');
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const mouse = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  const click = async (x, y) => {
    await mouse('mousePressed', x, y, 1);
    await mouse('mouseReleased', x, y, 0);
  };
  const clickEl = async (idSel) => {
    const c = await ev(
      `(() => { const r = document.getElementById('${idSel}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
    );
    await click(c.x, c.y);
  };
  const esc = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(350);
  };
  for (let i = 0; i < 40; i++) {
    if (await ev(`document.body.classList.contains('ready')`)) break;
    await sleep(150);
  }
  return { ws, send, ev, mouse, click, clickEl, esc };
}

async function waitWords(o) {
  for (let i = 0; i < 30; i++) {
    const n = await o.ev('window.__sircle ? window.__sircle.words().length : 0');
    if (n > 0) return n;
    await sleep(500);
  }
  return 0;
}

async function testWords(o) {
  const n = await waitWords(o);
  report.words = { count: n, pass: n > 20 };
}

async function testTextSelect(o) {
  await waitWords(o);
  const w = await o.ev(
    `window.__sircle.words().find((w) => w.text.replace(/\\W/g, '').length > 3 && w.y > 120 && w.y < innerHeight - 160)`
  );
  if (!w) {
    report.textselect = { pass: false, reason: 'no suitable word' };
    return;
  }
  const under = await o.ev(
    `(() => { const el = document.elementFromPoint(${w.x}, ${w.y}); return el ? el.id || el.tagName : null; })()`
  );
  await o.click(w.x, w.y);
  await sleep(300);
  const selected = await o.ev('window.__sircle.selectedText()');
  const chips = await o.ev(`!document.getElementById('text-actions').hidden`);
  report.textselect = { word: w.text, under, selected, chips, pass: selected === w.text && chips };
  if (selected) await o.esc(); // only clear when something was selected — a bare Esc closes the overlay
}

async function testLasso(o) {
  await waitWords(o);
  // start the stroke on a point clear of all words so it routes to the lasso
  const start = await o.ev(`(() => {
    const words = window.__sircle.words();
    const clear = (x, y) => words.every((w) => {
      const px = Math.max(w.x0, Math.min(x, w.x1));
      const py = Math.max(w.y0, Math.min(y, w.y1));
      return Math.hypot(px - x, py - y) > 60;
    });
    for (let y = 200; y < innerHeight - 220; y += 60) {
      for (let x = 200; x < innerWidth - 220; x += 80) {
        if (clear(x, y)) return { x, y };
      }
    }
    return null;
  })()`);
  if (!start) {
    report.lasso = { pass: false, reason: 'no clear spot' };
    return;
  }
  const r = 70;
  const cx = start.x - r;
  const cy = start.y;
  await o.mouse('mousePressed', start.x, start.y, 1);
  for (let a = 6; a <= 348; a += 6) {
    await o.mouse(
      'mouseMoved',
      Math.round(cx + r * Math.cos((a * Math.PI) / 180)),
      Math.round(cy + r * Math.sin((a * Math.PI) / 180)),
      1
    );
    await sleep(3);
  }
  await o.mouse('mouseReleased', Math.round(cx + r * Math.cos((348 * Math.PI) / 180)), Math.round(cy + r * Math.sin((348 * Math.PI) / 180)), 0);
  let sheet = false;
  for (let i = 0; i < 40 && !sheet; i++) {
    await sleep(500);
    sheet = await o.ev(`document.body.classList.contains('sheet')`);
  }
  const google = sheet && (await targets()).some((x) => /google\.com\/search|lens\.google\.com/.test(x.url));
  report.lasso = { sheet, googleTarget: google, pass: sheet };
  await o.esc(); // sheet
  await o.esc(); // selection
}

async function testTranslate(o) {
  const attempt = async () => {
    await o.clickEl('btn-translate');
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (!(await o.ev(`document.body.classList.contains('busy')`))) break;
    }
    return o.ev(`document.querySelectorAll('.tr-line').length`);
  };
  let n = await attempt();
  if (n === 0) n = await attempt(); // endpoint occasionally returns empty once
  const sample = await o.ev(`[...document.querySelectorAll('.tr-line')].slice(0, 3).map((e) => e.textContent)`);
  report.translate = { lines: n, sample, pass: n >= 3 };
  if (n > 0) await o.esc(); // Esc with nothing to clear would close the overlay
  await o.ev(`document.getElementById('btn-search').click()`); // back to default mode
}

async function testMusic(o) {
  await o.clickEl('btn-music');
  await sleep(2000);
  const st = await o.ev(
    `({ music: document.body.classList.contains('music'), shot: getComputedStyle(document.getElementById('shot')).display, iw: innerWidth })`
  );
  report.music = { ...st, pass: st.music && st.shot === 'none' && st.iw < 700 };
  await o.esc(); // cancel music, window restores
  await sleep(600);
  report.music.restoredWidth = await o.ev('innerWidth');
  report.music.pass = report.music.pass && report.music.restoredWidth > 700;
}

const TESTS = { words: testWords, textselect: testTextSelect, lasso: testLasso, translate: testTranslate, music: testMusic };

async function main() {
  const which = process.argv[2] ?? 'all';
  const names = which === 'all' ? Object.keys(TESTS) : [which];
  const o = await openOverlay();
  for (const name of names) {
    if (!TESTS[name]) throw new Error(`unknown test: ${name}`);
    await TESTS[name](o);
  }
  await o.esc();
  await o.esc();
  o.ws.close();
  const failed = names.filter((n) => report[n] && report[n].pass === false);
  console.log(JSON.stringify(report, null, 2));
  console.log(failed.length ? `FAIL: ${failed.join(', ')}` : 'ALL PASS');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('E2E ERROR:', e.message);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
});
