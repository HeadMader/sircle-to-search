import { contextBridge, ipcRenderer } from 'electron';
import type { OcrLine } from '../main/ocr';
import type { TrackInfo } from '../main/music';
import type { TranslateResult } from '../main/translate';

export type { OcrLine, TrackInfo };

export interface OverlayInit {
  png: Uint8Array;
  targetLang: string;
  defaultMode: 'search' | 'translate';
}

export interface SheetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const bridge = {
  onInit: (cb: (init: OverlayInit) => void) =>
    ipcRenderer.on('overlay:init', (_e, payload: OverlayInit) => cb(payload)),
  lensSearch: (png: ArrayBuffer, rect: SheetRect): Promise<void> =>
    ipcRenderer.invoke('lens:search', new Uint8Array(png), rect),
  sheetClose: () => ipcRenderer.send('sheet:close'),
  musicMode: (on: boolean) => ipcRenderer.send('music:mode', on),
  copyText: (text: string) => ipcRenderer.send('text:copy', text),
  textSearch: (query: string, rect: SheetRect): Promise<void> =>
    ipcRenderer.invoke('text:search', query, rect),
  ocr: (png: ArrayBuffer): Promise<OcrLine[]> =>
    ipcRenderer.invoke('ocr:image', new Uint8Array(png)),
  translate: (lines: string[], target: string): Promise<TranslateResult> =>
    ipcRenderer.invoke('translate:lines', lines, target),
  recognizeMusic: (pcm: ArrayBuffer): Promise<TrackInfo | null> =>
    ipcRenderer.invoke('music:recognize', pcm),
  openUrlAndClose: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-url', url),
  close: () => ipcRenderer.send('overlay:close')
};

export type Bridge = typeof bridge;

contextBridge.exposeInMainWorld('bridge', bridge);
