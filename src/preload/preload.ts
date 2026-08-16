import { contextBridge, ipcRenderer } from 'electron';

export interface OverlayInit {
  png: Uint8Array;
  scaleFactor: number;
  targetLang: string;
  shortcut: string;
  defaultMode?: 'search' | 'translate';
}

export interface OcrLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

export interface TrackInfo {
  title: string;
  artist: string;
  coverUrl: string | null;
  url: string | null;
}

const bridge = {
  onInit: (cb: (init: OverlayInit) => void) =>
    ipcRenderer.on('overlay:init', (_e, payload: OverlayInit) => cb(payload)),
  lensSearch: (
    png: ArrayBuffer,
    rect: { x: number; y: number; w: number; h: number }
  ): Promise<void> => ipcRenderer.invoke('lens-search', new Uint8Array(png), rect),
  sheetClose: () => ipcRenderer.send('sheet:close'),
  musicMode: (on: boolean) => ipcRenderer.send('music-mode', on),
  copyText: (text: string) => ipcRenderer.send('copy-text', text),
  textSearch: (
    query: string,
    rect: { x: number; y: number; w: number; h: number }
  ): Promise<void> => ipcRenderer.invoke('text-search', query, rect),
  ocr: (png: ArrayBuffer): Promise<OcrLine[]> => ipcRenderer.invoke('ocr', new Uint8Array(png)),
  translate: (
    lines: string[],
    target: string
  ): Promise<{ detectedLang: string; translatedLines: string[] }> =>
    ipcRenderer.invoke('translate', lines, target),
  recognizeMusic: (pcm: ArrayBuffer): Promise<TrackInfo | null> =>
    ipcRenderer.invoke('recognize-music', pcm),
  openUrlAndClose: (url: string): Promise<void> => ipcRenderer.invoke('open-url-and-close', url),
  close: () => ipcRenderer.send('overlay:close')
};

export type Bridge = typeof bridge;

contextBridge.exposeInMainWorld('bridge', bridge);
