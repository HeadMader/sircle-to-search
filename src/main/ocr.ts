import { nativeImage } from 'electron';

export interface OcrLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

interface LensSegment {
  text: string;
  boundingBox: { centerPerX: number; centerPerY: number; perWidth: number; perHeight: number };
}

// chrome-lens-ocr is ESM-only; the Function wrapper keeps esbuild's CJS output
// from rewriting this into a require() call, which cannot load ESM.
const dynamicImport = new Function('m', 'return import(m)') as (
  m: string
) => Promise<{ default: new () => { scanByBuffer(b: Buffer): Promise<{ segments: LensSegment[] }> } }>;

let lensPromise: ReturnType<typeof createLens> | null = null;
function createLens() {
  return dynamicImport('chrome-lens-ocr').then(({ default: Lens }) => new Lens());
}

/**
 * OCR via Google Lens — the same engine Google's screen translate uses.
 * One shared instance so Google's NID cookie is reused between scans.
 * ponystack: full-screen scans downscale internally to 1200px; tiling the
 * image into quadrants would keep small text sharp if quality ever lags.
 */
export async function ocrImage(png: Buffer): Promise<OcrLine[]> {
  const { width, height } = nativeImage.createFromBuffer(png).getSize();
  lensPromise ??= createLens();
  const lens = await lensPromise;
  const { segments } = await lens.scanByBuffer(png);
  return (segments ?? [])
    .map(({ text, boundingBox: b }) => {
      const x0 = (b.centerPerX - b.perWidth / 2) * width;
      const y0 = (b.centerPerY - b.perHeight / 2) * height;
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        bbox: {
          x0: Math.max(0, Math.round(x0)),
          y0: Math.max(0, Math.round(y0)),
          x1: Math.min(width, Math.round(x0 + b.perWidth * width)),
          y1: Math.min(height, Math.round(y0 + b.perHeight * height))
        },
        confidence: 100
      };
    })
    .filter((l) => l.text.length > 0 && l.bbox.x1 - l.bbox.x0 > 3 && l.bbox.y1 - l.bbox.y0 > 3);
}
