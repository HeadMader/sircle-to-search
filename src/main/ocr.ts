import { nativeImage } from 'electron';

export interface OcrBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  bbox: OcrBBox;
}

export interface OcrLine {
  text: string;
  bbox: OcrBBox;
  confidence: number;
  paragraph: number;
  words: OcrWord[];
}

// chrome-lens-ocr is ESM-only; the Function wrapper keeps esbuild's CJS output
// from rewriting this into a require() call, which cannot load ESM.
const dynamicImport = new Function('m', 'return import(m)') as (
  m: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLens = any;

let lensPromise: Promise<AnyLens> | null = null;
function getLens(): Promise<AnyLens> {
  // One shared instance (cookie reuse). _sendProtoRequest is patched to stash
  // the raw protobuf response: the library flattens it to line segments and
  // drops the per-word geometry we need.
  lensPromise ??= dynamicImport('chrome-lens-ocr').then(({ default: Lens }) => {
    const lens = new Lens();
    const orig = lens._sendProtoRequest.bind(lens);
    lens._sendProtoRequest = async (serialized: unknown) => {
      const resp = await orig(serialized);
      lens.__lastResponse = resp;
      return resp;
    };
    return lens;
  });
  return lensPromise;
}

const NORMALIZED = 1; // proto.lens.CoordinateType.NORMALIZED

function toPx(msg: AnyLens, W: number, H: number): OcrBBox | null {
  if (!msg?.hasGeometry?.() || !msg.getGeometry().hasBoundingBox()) return null;
  const b = msg.getGeometry().getBoundingBox();
  if (b.getCoordinateType() !== NORMALIZED) return null;
  const cx = b.getCenterX() * W;
  const cy = b.getCenterY() * H;
  const w = b.getWidth() * W;
  const h = b.getHeight() * H;
  return {
    x0: Math.max(0, Math.round(cx - w / 2)),
    y0: Math.max(0, Math.round(cy - h / 2)),
    x1: Math.min(W, Math.round(cx + w / 2)),
    y1: Math.min(H, Math.round(cy + h / 2))
  };
}

function unionOf(words: OcrWord[]): OcrBBox | null {
  if (words.length === 0) return null;
  return {
    x0: Math.min(...words.map((w) => w.bbox.x0)),
    y0: Math.min(...words.map((w) => w.bbox.y0)),
    x1: Math.max(...words.map((w) => w.bbox.x1)),
    y1: Math.max(...words.map((w) => w.bbox.y1))
  };
}

/**
 * OCR via Google Lens at FULL native resolution: scanByData bypasses the
 * library's 1200px downscale (the endpoint accepts full screenshots), and the
 * raw protobuf gives paragraph→line→word hierarchy with per-word boxes.
 */
export async function ocrImage(png: Buffer): Promise<OcrLine[]> {
  const { width: W, height: H } = nativeImage.createFromBuffer(png).getSize();
  const lens = await getLens();
  const flat = await lens.scanByData(new Uint8Array(png), 'image/png');

  const lines: OcrLine[] = [];
  try {
    const layout = lens.__lastResponse?.getObjectsResponse?.()?.getText?.()?.getTextLayout?.();
    const paragraphs: AnyLens[] = layout?.getParagraphsList?.() ?? [];
    paragraphs.forEach((para, pIdx) => {
      for (const line of para.getLinesList()) {
        const words: OcrWord[] = [];
        let text = '';
        const wl: AnyLens[] = line.getWordsList();
        for (let i = 0; i < wl.length; i++) {
          const w = wl[i];
          const plain: string = w.getPlainText();
          text += plain + (w.hasTextSeparator() ? w.getTextSeparator() : i < wl.length - 1 ? ' ' : '');
          const bbox = toPx(w, W, H);
          if (bbox && plain.trim()) words.push({ text: plain.trim(), bbox });
        }
        text = text.replace(/\s+/g, ' ').trim();
        const bbox = toPx(line, W, H) ?? unionOf(words);
        if (!text || !bbox || bbox.x1 - bbox.x0 < 4 || bbox.y1 - bbox.y0 < 4) continue;
        lines.push({ text, bbox, confidence: 100, paragraph: pIdx, words });
      }
    });
  } catch (err) {
    console.warn('word-level OCR extraction failed, using line segments:', err);
  }
  if (lines.length > 0) return lines;

  // fallback: the library's flattened line segments (still full-resolution)
  interface FlatSegment {
    text: string;
    boundingBox: { pixelCoords: { x: number; y: number; width: number; height: number } };
  }
  return ((flat.segments ?? []) as FlatSegment[])
    .map((s) => {
      const p = s.boundingBox.pixelCoords;
      return {
        text: s.text.replace(/\s+/g, ' ').trim(),
        bbox: { x0: p.x, y0: p.y, x1: p.x + p.width, y1: p.y + p.height },
        confidence: 100,
        paragraph: 0,
        words: []
      };
    })
    .filter((l) => l.text.length > 0 && l.bbox.x1 - l.bbox.x0 > 3 && l.bbox.y1 - l.bbox.y0 > 3);
}
