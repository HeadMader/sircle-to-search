import type { Bridge, OverlayInit, OcrLine, TrackInfo } from '../preload/preload';

declare global {
  interface Window {
    bridge: Bridge;
  }
}

const bridge = window.bridge;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const shot = $<HTMLImageElement>('shot');
const canvas = $<HTMLCanvasElement>('lasso');
const ctx = canvas.getContext('2d')!;
const toolbar = $<HTMLDivElement>('toolbar');
const btnSearch = $<HTMLButtonElement>('btn-search');
const btnTranslate = $<HTMLButtonElement>('btn-translate');
const btnMusic = $<HTMLButtonElement>('btn-music');
const statusChip = $<HTMLDivElement>('status-chip');
const statusText = $<HTMLSpanElement>('status-text');
const translateLayer = $<HTMLDivElement>('translate-layer');
const musicUi = $<HTMLDivElement>('music-ui');
const musicListening = $<HTMLDivElement>('music-listening');
const musicResult = $<HTMLDivElement>('music-result');
const toast = $<HTMLDivElement>('toast');
const sheet = $<HTMLDivElement>('sheet');
const sheetSpinner = $<HTMLSpanElement>('sheet-spinner');
const textActions = $<HTMLDivElement>('text-actions');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

type Point = { x: number; y: number };
type Mode = OverlayInit['defaultMode'];
type Rect = { x: number; y: number; w: number; h: number };
/** one pointer gesture at a time: lasso drawing or text-selection dragging */
type Gesture = 'none' | 'lasso' | 'text';

let init: OverlayInit | null = null;
let mode: Mode = 'search';
let gesture: Gesture = 'none';
let points: Point[] = [];
let selection: Point[] | null = null;
let busy = false;
let closing = false;
let selectedAt = 0;
let musicStream: MediaStream | null = null;
let musicCancelled = false;

// Offscreen copy of the screenshot for cropping and color sampling.
const shotCanvas = document.createElement('canvas');
const shotCtx = shotCanvas.getContext('2d', { willReadFrequently: true })!;

/* ---------- boot ---------- */

bridge.onInit((payload) => {
  init = payload;
  const raw = payload.png;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
  const copy = bytes.slice();
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: 'image/png' });
  setMode(payload.defaultMode);
  shot.onload = () => {
    shotCanvas.width = shot.naturalWidth;
    shotCanvas.height = shot.naturalHeight;
    shotCtx.drawImage(shot, 0, 0);
    document.body.classList.add('ready');
    void loadTextMap(); // background OCR: makes on-screen text selectable
  };
  shot.onerror = (e) => console.log('overlay: shot FAILED to load', String(e));
  shot.src = URL.createObjectURL(blob);
  resizeCanvas();
});

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

/** screenshot device px per css px */
function pxScale() {
  return shot.naturalWidth ? shot.naturalWidth / innerWidth : window.devicePixelRatio || 1;
}

/* ---------- toast / status ---------- */

let toastTimer = 0;
function showToast(msg: string) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 3200);
}

function setBusy(b: boolean, label = '') {
  busy = b;
  statusText.textContent = label;
  statusChip.hidden = !b || !label;
  document.body.classList.toggle('busy', b);
}

/* ---------- results sheet ---------- */

const SHEET_HEADER_H = 36;
let sheetOpen = false;

/** Sizes the sheet chrome and returns the body rect main should cover with the results view. */
function openSheet() {
  const w = Math.round(Math.min(1040, innerWidth * 0.86));
  const h = Math.round(innerHeight * 0.56);
  const x = Math.round((innerWidth - w) / 2);
  sheet.style.width = `${w}px`;
  sheet.style.height = `${h}px`;
  sheetOpen = true;
  sheetSpinner.hidden = false;
  document.body.classList.add('sheet');
  return { x, y: innerHeight - h + SHEET_HEADER_H, w, h: h - SHEET_HEADER_H };
}

function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  document.body.classList.remove('sheet');
  bridge.sheetClose();
}

/* ---------- text selection (Google-style: press on text selects it) ---------- */

interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  idx: number;
  lineIdx: number;
}

let words: Word[] = [];
let textSel: { anchor: number; focus: number } | null = null;

async function loadTextMap() {
  try {
    const png = await cropRegion(fullScreenBox());
    const lines = await bridge.ocr(png);
    const s = pxScale();
    const measure = document.createElement('canvas').getContext('2d')!;
    words = [];
    lines.forEach((line, lineIdx) => {
      if (line.words.length > 0) {
        // real per-word boxes from the OCR engine
        for (const w of line.words) {
          words.push({
            text: w.text,
            x0: w.bbox.x0 / s,
            y0: w.bbox.y0 / s,
            x1: w.bbox.x1 / s,
            y1: w.bbox.y1 / s,
            idx: words.length,
            lineIdx
          });
        }
        return;
      }
      // fallback: split the line box proportionally to measured word widths
      const x0 = line.bbox.x0 / s;
      const y0 = line.bbox.y0 / s;
      const x1 = line.bbox.x1 / s;
      const y1 = line.bbox.y1 / s;
      const parts = line.text.split(' ').filter(Boolean);
      if (parts.length === 0) return;
      const h = y1 - y0;
      measure.font = `${Math.max(8, h * 0.75)}px "Segoe UI", Roboto, sans-serif`;
      const widths = parts.map((p) => Math.max(1, measure.measureText(p).width));
      const spaceW = measure.measureText(' ').width;
      const total = widths.reduce((a, b) => a + b, 0) + spaceW * (parts.length - 1);
      const k = (x1 - x0) / total;
      let x = x0;
      parts.forEach((text, i) => {
        const w = widths[i]! * k;
        words.push({ text, x0: x, y0, x1: x + w, y1, idx: words.length, lineIdx });
        x += w + spaceW * k;
      });
    });
  } catch {
    /* no text map: everything stays lasso-selectable */
  }
}

function wordAt(x: number, y: number): Word | null {
  for (const w of words) {
    if (x >= w.x0 - 2 && x <= w.x1 + 2 && y >= w.y0 - 3 && y <= w.y1 + 3) return w;
  }
  return null;
}

/** maps a free cursor position to the nearest word in reading order */
function nearestWordIdx(x: number, y: number): number {
  const direct = wordAt(x, y);
  if (direct) return direct.idx;
  let best = 0;
  let bestD = Infinity;
  for (const w of words) {
    const cx = Math.max(w.x0, Math.min(x, w.x1));
    const cy = Math.max(w.y0, Math.min(y, w.y1));
    const d = (cx - x) ** 2 + (cy - y) ** 2 * 4;
    if (d < bestD) {
      bestD = d;
      best = w.idx;
    }
  }
  return best;
}

function selectedWords(): Word[] {
  if (!textSel) return [];
  const lo = Math.min(textSel.anchor, textSel.focus);
  const hi = Math.max(textSel.anchor, textSel.focus);
  return words.slice(lo, hi + 1);
}

function selectedText(): string {
  const byLine = new Map<number, string[]>();
  for (const w of selectedWords()) {
    byLine.set(w.lineIdx, [...(byLine.get(w.lineIdx) ?? []), w.text]);
  }
  return [...byLine.values()].map((l) => l.join(' ')).join('\n');
}

function clearTextSel() {
  textSel = null;
  textActions.hidden = true;
}

function clearAllSelections() {
  clearTextSel();
  clearTranslations();
  selection = null;
  document.body.classList.remove('selected');
}

function showTextActions() {
  const sel = selectedWords();
  if (sel.length === 0) return;
  const minX = Math.min(...sel.map((w) => w.x0));
  const minY = Math.min(...sel.map((w) => w.y0));
  const maxY = Math.max(...sel.map((w) => w.y1));
  textActions.hidden = false;
  const left = Math.max(8, Math.min(minX, innerWidth - 180));
  const top = minY > 56 ? minY - 48 : maxY + 10;
  textActions.style.left = `${left}px`;
  textActions.style.top = `${top}px`;
}

$<HTMLButtonElement>('ta-copy').addEventListener('click', () => {
  const text = selectedText();
  if (!text) return;
  bridge.copyText(text);
  showToast('Copied');
});
$<HTMLButtonElement>('ta-search').addEventListener('click', () => {
  const query = selectedText().replace(/\n/g, ' ');
  if (!query) return;
  textActions.hidden = true;
  void searchInSheet((rect) => bridge.textSearch(query, rect));
});

/* ---------- lasso drawing ---------- */

interface Sparkle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  star: boolean;
}
const sparkles: Sparkle[] = [];

function spawnSparkles(x: number, y: number, n: number) {
  if (reducedMotion) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 0.2 + Math.random() * 0.9;
    sparkles.push({
      x: x + (Math.random() - 0.5) * 14,
      y: y + (Math.random() - 0.5) * 14,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 0.15,
      life: 0,
      max: 500 + Math.random() * 450,
      size: 1 + Math.random() * 2.4,
      star: Math.random() < 0.18
    });
  }
}

function pathFrom(pts: Point[], close: boolean) {
  const p = new Path2D();
  if (pts.length === 0) return p;
  p.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
    const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
    p.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
  }
  const last = pts[pts.length - 1]!;
  p.lineTo(last.x, last.y);
  if (close) p.closePath();
  return p;
}

function bboxOf(pts: Point[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pt of pts) {
    x0 = Math.min(x0, pt.x); y0 = Math.min(y0, pt.y);
    x1 = Math.max(x1, pt.x); y1 = Math.max(y1, pt.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* glowing dot that replaces the cursor over the canvas; I-beam over text */
let pointerPos: Point | null = null;
window.addEventListener('pointermove', (e) => {
  if (e.target !== canvas) {
    pointerPos = null;
    return;
  }
  const overText = gesture !== 'lasso' && wordAt(e.clientX, e.clientY) !== null;
  canvas.style.cursor = overText ? 'text' : 'none';
  pointerPos = overText ? null : { x: e.clientX, y: e.clientY };
});
window.addEventListener('pointerleave', () => (pointerPos = null));

/** per-line highlight rects, like regular text selection */
function drawTextHighlight() {
  if (!textSel) return;
  const byLine = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (const w of selectedWords()) {
    const r = byLine.get(w.lineIdx);
    if (!r) byLine.set(w.lineIdx, { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
    else {
      r.x0 = Math.min(r.x0, w.x0);
      r.y0 = Math.min(r.y0, w.y0);
      r.x1 = Math.max(r.x1, w.x1);
      r.y1 = Math.max(r.y1, w.y1);
    }
  }
  ctx.save();
  ctx.fillStyle = 'rgba(138, 180, 248, 0.4)';
  for (const r of byLine.values()) {
    ctx.beginPath();
    ctx.roundRect(r.x0 - 2, r.y0 - 2, r.x1 - r.x0 + 4, r.y1 - r.y0 + 4, 3);
    ctx.fill();
  }
  ctx.restore();
}

function drawLasso(now: number) {
  const active = gesture === 'lasso';
  const activePts = active ? points : selection;
  if (!activePts || activePts.length < 2) return;
  const path = pathFrom(activePts, !active);

  if (!active && selection) {
    // spotlight: darken everything outside the selection
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(path);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill(path);
    ctx.restore();
  }

  const pulse = reducedMotion ? 1 : 0.75 + 0.25 * Math.sin((now - selectedAt) / 260);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = '#4285f4';
  ctx.shadowBlur = active ? 16 : 18 * pulse;
  ctx.strokeStyle = 'rgba(174, 203, 250, 0.95)';
  ctx.lineWidth = 4;
  ctx.stroke(path);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.6;
  ctx.stroke(path);
  ctx.restore();
}

function drawSparkles(dt: number) {
  for (let i = sparkles.length - 1; i >= 0; i--) {
    const s = sparkles[i]!;
    s.life += dt;
    if (s.life > s.max) {
      sparkles.splice(i, 1);
      continue;
    }
    s.x += s.vx * dt * 0.06;
    s.y += s.vy * dt * 0.06;
    const t = 1 - s.life / s.max;
    ctx.save();
    ctx.globalAlpha = t;
    if (s.star) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      const r = s.size * 2.4 * t;
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x + r, s.y);
      ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x, s.y + r);
      ctx.stroke();
    } else {
      ctx.fillStyle = i % 3 === 0 ? '#aecbfa' : '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size * t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawCursorDot() {
  if (!pointerPos || closing) return;
  const active = gesture === 'lasso';
  ctx.save();
  ctx.shadowColor = 'rgba(138, 180, 248, 0.95)';
  ctx.shadowBlur = active ? 24 : 16;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.arc(pointerPos.x, pointerPos.y, active ? 6 : 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

let lastFrame = performance.now();
function frame(now: number) {
  const dt = now - lastFrame;
  lastFrame = now;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  drawTextHighlight();
  drawLasso(now);
  drawSparkles(dt);
  drawCursorDot();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- pointer input ---------- */

let downPoint: Point | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (busy || closing || !musicUi.hidden) return;
  canvas.setPointerCapture(e.pointerId);
  clearAllSelections();
  const hit = wordAt(e.clientX, e.clientY);
  if (hit) {
    // press landed on text: behave like regular text selection, not lasso
    gesture = 'text';
    textSel = { anchor: hit.idx, focus: hit.idx };
    return;
  }
  downPoint = { x: e.clientX, y: e.clientY };
  gesture = 'lasso';
  points = [downPoint];
});

canvas.addEventListener('pointermove', (e) => {
  if (gesture === 'text' && textSel) {
    textSel.focus = nearestWordIdx(e.clientX, e.clientY);
    return;
  }
  if (gesture !== 'lasso') return;
  const evts = 'getCoalescedEvents' in e ? e.getCoalescedEvents() : [e];
  for (const ev of evts) points.push({ x: ev.clientX, y: ev.clientY });
  spawnSparkles(e.clientX, e.clientY, 2);
});

canvas.addEventListener('pointerup', (e) => {
  if (gesture === 'text') {
    gesture = 'none';
    showTextActions();
    return;
  }
  if (gesture !== 'lasso') return;
  gesture = 'none';
  const dist = downPoint ? Math.hypot(e.clientX - downPoint.x, e.clientY - downPoint.y) : 0;
  if (dist < 6 || points.length < 5) {
    tapBloom(e.clientX, e.clientY);
  } else {
    finalizeSelection(points);
  }
});

/** Tap: bloom a rounded rect out from the tap point, then treat it as the selection. */
function tapBloom(cx: number, cy: number) {
  const targetW = Math.min(280, innerWidth * 0.3);
  const targetH = Math.min(190, innerHeight * 0.3);
  const start = performance.now();
  const dur = reducedMotion ? 0 : 240;
  function grow(now: number) {
    const t = dur === 0 ? 1 : Math.min(1, (now - start) / dur);
    const ease = 1 - Math.pow(1 - t, 3);
    const w = 30 + (targetW - 30) * ease;
    const h = 20 + (targetH - 20) * ease;
    selection = roundedRectPoints(cx - w / 2, cy - h / 2, w, h, Math.min(24, h / 3));
    selectedAt = performance.now();
    if (t < 1) requestAnimationFrame(grow);
    else finalizeSelection(selection);
  }
  requestAnimationFrame(grow);
}

function roundedRectPoints(x: number, y: number, w: number, h: number, r: number): Point[] {
  const pts: Point[] = [];
  const seg = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + ((a1 - a0) * i) / 6;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  seg(x + r, y + r, Math.PI, Math.PI * 1.5);
  seg(x + w - r, y + r, Math.PI * 1.5, Math.PI * 2);
  seg(x + w - r, y + h - r, 0, Math.PI * 0.5);
  seg(x + r, y + h - r, Math.PI * 0.5, Math.PI);
  return pts;
}

function finalizeSelection(pts: Point[]) {
  const box = bboxOf(pts);
  if (box.w < 12 || box.h < 12) {
    selection = null;
    return;
  }
  selection = pts;
  selectedAt = performance.now();
  document.body.classList.add('selected');
  spawnSparkles(box.x + box.w / 2, box.y + box.h / 2, 10);
  if (mode === 'search') void runSearch();
  else void runTranslate();
}

/* ---------- crop ---------- */

// OCR bboxes from cropRegion output are relative to this padded origin;
// renderTranslations reverses it when placing translation divs.
const CROP_PAD = 4;

function cropRegion(box: Rect): Promise<ArrayBuffer> {
  const s = pxScale();
  const x = Math.max(0, Math.round((box.x - CROP_PAD) * s));
  const y = Math.max(0, Math.round((box.y - CROP_PAD) * s));
  const w = Math.min(shotCanvas.width - x, Math.round((box.w + CROP_PAD * 2) * s));
  const h = Math.min(shotCanvas.height - y, Math.round((box.h + CROP_PAD * 2) * s));
  if (w <= 0 || h <= 0) return Promise.reject(new Error('selection is off-screen'));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(shotCanvas, x, y, w, h, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (!blob) return reject(new Error('crop failed'));
      resolve(blob.arrayBuffer());
    }, 'image/png');
  });
}

function fullScreenBox(): Rect {
  return { x: 0, y: 0, w: innerWidth, h: innerHeight };
}

const selectionBox = () => (selection ? bboxOf(selection) : fullScreenBox());

/* ---------- actions ---------- */

/** Shared sheet-search flow: busy guard, sheet chrome, spinner, error toast. */
async function searchInSheet(go: (rect: Rect) => Promise<void>) {
  if (busy) return;
  setBusy(true);
  const rect = openSheet();
  try {
    await go(rect);
    sheetSpinner.hidden = true;
  } catch (err) {
    console.error(err);
    closeSheet();
    showToast('Search failed. Check your connection and try again.');
  } finally {
    setBusy(false);
  }
}

async function runSearch() {
  const box = selectionBox();
  await searchInSheet(async (rect) => {
    const png = await cropRegion(box);
    await bridge.lensSearch(png, rect);
  });
}

async function runTranslate() {
  if (busy || !init) return;
  const region = selectionBox();
  setBusy(true, 'Translating…');
  try {
    const png = await cropRegion(region);
    const lines = await bridge.ocr(png);
    if (lines.length === 0) {
      showToast('No text found.');
      return;
    }
    const { translatedLines } = await bridge.translate(
      lines.map((l) => l.text),
      init.targetLang
    );
    renderTranslations(lines, translatedLines, region);
  } catch (err) {
    console.error(err);
    showToast('Translation failed. Check your connection and try again.');
  } finally {
    setBusy(false);
  }
}

function clearTranslations() {
  translateLayer.innerHTML = '';
  translateLayer.hidden = true;
}

function renderTranslations(lines: OcrLine[], translated: string[], region: Rect) {
  clearTranslations();
  translateLayer.hidden = false;
  const s = pxScale();
  const originX = Math.max(0, region.x - CROP_PAD);
  const originY = Math.max(0, region.y - CROP_PAD);
  const measure = document.createElement('canvas').getContext('2d')!;

  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const overlaps = (b: { x0: number; y0: number; x1: number; y1: number }) =>
    placed.some((p) => {
      const ix = Math.min(b.x1, p.x1) - Math.max(b.x0, p.x0);
      const iy = Math.min(b.y1, p.y1) - Math.max(b.y0, p.y0);
      if (ix <= 0 || iy <= 0) return false;
      const inter = ix * iy;
      const union = (b.x1 - b.x0) * (b.y1 - b.y0) + (p.x1 - p.x0) * (p.y1 - p.y0) - inter;
      return inter / union > 0.55;
    });

  lines.forEach((line, i) => {
    const text = translated[i]?.trim();
    if (!text) return;
    // untranslated content (URLs, numbers, already-target-language text)
    // reads better as the untouched original
    if (text.toLowerCase() === line.text.trim().toLowerCase()) return;
    if (overlaps(line.bbox)) return;
    placed.push(line.bbox);
    const x = originX + line.bbox.x0 / s;
    const y = originY + line.bbox.y0 / s;
    const w = (line.bbox.x1 - line.bbox.x0) / s;
    const h = (line.bbox.y1 - line.bbox.y0) / s;
    if (h < 7 || w < 10) return;

    const { bg, fg } = sampleColors(line.bbox);
    let fontSize = Math.max(9, h * 0.72);
    measure.font = `500 ${fontSize}px "Segoe UI", Roboto, sans-serif`;
    const textW = measure.measureText(text).width;
    if (textW > w) fontSize = Math.max(8, (fontSize * w) / textW);

    const el = document.createElement('div');
    el.className = 'tr-line';
    el.textContent = text;
    el.style.cssText = `left:${x}px;top:${y}px;min-width:${w}px;height:${h}px;` +
      `background:${bg};color:${fg};--tr-bg:${bg};` +
      `font-size:${fontSize}px;font-weight:500;padding:0 3px;` +
      `animation-delay:${Math.min(i * 24, 400)}ms`;
    translateLayer.appendChild(el);
  });
}

/** Average the pixels just outside a text line's bbox to fake its background. */
function sampleColors(bbox: OcrLine['bbox']) {
  let r = 0, g = 0, b = 0, n = 0;
  try {
    const s = pxScale();
    const pad = Math.max(2, Math.round(2 * s));
    const x = Math.max(0, bbox.x0 - pad);
    const y = Math.max(0, bbox.y0 - pad);
    const w = Math.min(shotCanvas.width - x, bbox.x1 - bbox.x0 + pad * 2);
    const h = Math.min(shotCanvas.height - y, bbox.y1 - bbox.y0 + pad * 2);
    const img = shotCtx.getImageData(x, y, w, h);
    const rows = [0, h - 1];
    for (const row of rows) {
      for (let col = 0; col < w; col += 3) {
        const idx = (row * w + col) * 4;
        r += img.data[idx]!; g += img.data[idx + 1]!; b += img.data[idx + 2]!;
        n++;
      }
    }
  } catch {
    /* sampling is cosmetic; fall through to default */
  }
  if (n === 0) return { bg: '#fff', fg: '#1f1f1f' };
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { bg: `rgb(${r},${g},${b})`, fg: lum > 140 ? '#1f1f1f' : '#ffffff' };
}

/* ---------- music ---------- */

const SAMPLE_RATE = 16000;
// Shazam's signature window caps at 12 s; try early, keep capturing on a miss.
const MUSIC_STAGES_S = [4, 8, 12];

interface Capture {
  until(samples: number): Promise<void>;
  snapshot(): Int16Array;
  stop(): void;
}

function startCapture(stream: MediaStream): Capture {
  const ac = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ac.createMediaStreamSource(stream);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let total = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  proc.onaudioprocess = (e) => {
    const ch = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(ch));
    total += ch.length;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (total >= waiters[i]!.n) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  source.connect(proc);
  proc.connect(ac.destination);
  return {
    until: (n) =>
      total >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })),
    snapshot: () => {
      const flat = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        flat.set(c, off);
        off += c.length;
      }
      const out = new Int16Array(flat.length);
      for (let i = 0; i < flat.length; i++) {
        const v = Math.max(-1, Math.min(1, flat[i]!));
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      return out;
    },
    stop: () => {
      proc.disconnect();
      source.disconnect();
      void ac.close();
    }
  };
}

/** system loopback audio; the video track must be requested, then discarded */
async function getLoopbackAudio(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  musicStream = stream;
  stream.getVideoTracks().forEach((t) => {
    t.stop();
    stream.removeTrack(t);
  });
  if (stream.getAudioTracks().length === 0) throw new Error('no system audio track');
  return stream;
}

/** try recognition at each stage while capture continues; null on miss or cancel */
async function recognizeStaged(cap: Capture): Promise<TrackInfo | null> {
  for (const secs of MUSIC_STAGES_S) {
    await cap.until(secs * SAMPLE_RATE);
    if (musicCancelled) return null;
    const track = await bridge.recognizeMusic(cap.snapshot().buffer as ArrayBuffer);
    if (track || musicCancelled) return track;
  }
  return null;
}

async function startMusic() {
  clearTextSel();
  musicUi.hidden = false;
  musicListening.hidden = false;
  musicResult.hidden = true;
  musicCancelled = false;
  document.body.classList.add('music');
  // window shrinks to just the card so background video keeps rendering live
  bridge.musicMode(true);
  let cap: Capture | null = null;
  try {
    cap = startCapture(await getLoopbackAudio());
    const track = await recognizeStaged(cap);
    if (musicCancelled) return;
    if (!track) {
      showToast('No match found. Is music playing?');
      hideMusic();
      return;
    }
    showMusicResult(track);
  } catch (err) {
    console.error(err);
    if (!musicCancelled) showToast('Could not capture system audio.');
    hideMusic();
  } finally {
    cap?.stop();
    stopMusicStream();
  }
}

function showMusicResult(track: TrackInfo) {
  musicListening.hidden = true;
  musicResult.hidden = false;
  $<HTMLParagraphElement>('music-title').textContent = track.title;
  $<HTMLParagraphElement>('music-artist').textContent = track.artist;
  const cover = $<HTMLImageElement>('music-cover');
  cover.src = track.coverUrl ?? '';
  cover.hidden = !track.coverUrl;
  $<HTMLButtonElement>('music-open').onclick = () => {
    const url =
      track.url ??
      `https://www.youtube.com/results?search_query=${encodeURIComponent(
        `${track.artist} ${track.title}`
      )}`;
    // main closes the overlay window before launching the browser: no stale
    // screenshot flash, and the browser lands in the foreground
    void bridge.openUrlAndClose(url);
  };
}

function stopMusicStream() {
  musicStream?.getTracks().forEach((t) => t.stop());
  musicStream = null;
}

function hideMusic() {
  musicCancelled = true;
  stopMusicStream();
  musicUi.hidden = true;
  document.body.classList.remove('music');
  bridge.musicMode(false);
}

/* ---------- toolbar / keys ---------- */

function setMode(m: Mode) {
  mode = m;
  btnSearch.classList.toggle('active', m === 'search');
  btnTranslate.classList.toggle('active', m === 'translate');
}

btnSearch.addEventListener('click', () => {
  setMode('search');
  if (selection) void runSearch();
});
btnTranslate.addEventListener('click', () => {
  setMode('translate');
  void runTranslate();
});
btnMusic.addEventListener('click', () => void startMusic());
$<HTMLButtonElement>('music-cancel').addEventListener('click', hideMusic);
$<HTMLButtonElement>('music-retry').addEventListener('click', () => void startMusic());

$<HTMLButtonElement>('sheet-close').addEventListener('click', () => closeSheet());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!musicUi.hidden) {
      hideMusic();
    } else if (sheetOpen) {
      closeSheet();
    } else if (textSel || selection || translateLayer.childElementCount > 0) {
      clearAllSelections();
    } else {
      closeOverlay();
    }
  } else if (e.key === 'Enter' && musicUi.hidden) {
    void runSearch();
  }
});

// hook for the CDP verification harness (scratchpad verify scripts)
(window as unknown as Record<string, unknown>).__sircle = {
  words: () =>
    words.map((w) => ({
      text: w.text,
      x: (w.x0 + w.x1) / 2,
      y: (w.y0 + w.y1) / 2,
      x0: w.x0,
      y0: w.y0,
      x1: w.x1,
      y1: w.y1
    })),
  selectedText: () => selectedText(),
  mode: () => mode
};

function closeOverlay() {
  if (closing) return;
  closing = true;
  hideMusic();
  document.body.classList.add('closing');
  setTimeout(() => bridge.close(), 200);
}
