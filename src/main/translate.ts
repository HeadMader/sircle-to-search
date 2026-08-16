import { app } from 'electron';

// read at request time: main.ts assigns the clean Chrome UA to
// userAgentFallback after this module is loaded
const headers = () => ({
  'User-Agent': app.userAgentFallback,
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
});

export interface TranslateResult {
  detectedLang: string;
  translatedLines: string[];
}

/**
 * Free Google Translate endpoints (no API key).
 * Primary: translate_a/t (client=dict-chrome-ex) — detects the source
 * language PER LINE, which mixed-language screens need (the gtx batch
 * endpoint detects once for the whole batch; when that matches the target
 * it echoes every line back untranslated).
 * Fallback: translate_a/single (client=gtx), lines joined with \n.
 */
export async function translateLines(lines: string[], targetLang: string): Promise<TranslateResult> {
  if (lines.length === 0) return { detectedLang: '', translatedLines: [] };
  try {
    return await translateDictChromeEx(lines, targetLang);
  } catch {
    return await translateGtx(lines, targetLang);
  }
}

async function translateGtx(lines: string[], targetLang: string): Promise<TranslateResult> {
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t`,
    { method: 'POST', headers: headers(), body: new URLSearchParams({ q: lines.join('\n') }) }
  );
  if (!res.ok) throw new Error(`translate gtx HTTP ${res.status}`);
  const data = (await res.json()) as [Array<[string, ...unknown[]]> | null, unknown, string];
  const fullText = (data[0] ?? []).map((seg) => seg?.[0] ?? '').join('');
  const translatedLines = fullText.split('\n');
  if (translatedLines.length !== lines.length) throw new Error('translate gtx line mismatch');
  return { detectedLang: data[2] ?? '', translatedLines };
}

async function translateDictChromeEx(lines: string[], targetLang: string): Promise<TranslateResult> {
  const body = new URLSearchParams();
  for (const line of lines) body.append('q', line);
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(targetLang)}`,
    { method: 'POST', headers: headers(), body }
  );
  if (!res.ok) throw new Error(`translate /t HTTP ${res.status}`);
  const data = (await res.json()) as Array<string | [string, string]>;
  const first = data[0];
  return {
    detectedLang: Array.isArray(first) ? first[1] : '',
    translatedLines: data.map((e) => (Array.isArray(e) ? e[0] : e))
  };
}
