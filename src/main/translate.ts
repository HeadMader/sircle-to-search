const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
};

export interface TranslateResult {
  detectedLang: string;
  translatedLines: string[];
}

/**
 * Free Google Translate endpoints (no API key).
 * Primary: translate_a/single (client=gtx), lines joined with \n.
 * Fallback: translate_a/t (client=dict-chrome-ex), true per-line batching.
 */
export async function translateLines(lines: string[], targetLang: string): Promise<TranslateResult> {
  if (lines.length === 0) return { detectedLang: '', translatedLines: [] };
  try {
    return await translateGtx(lines, targetLang);
  } catch {
    return await translateDictChromeEx(lines, targetLang);
  }
}

async function translateGtx(lines: string[], targetLang: string): Promise<TranslateResult> {
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t`,
    { method: 'POST', headers: HEADERS, body: new URLSearchParams({ q: lines.join('\n') }) }
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
    { method: 'POST', headers: HEADERS, body }
  );
  if (!res.ok) throw new Error(`translate /t HTTP ${res.status}`);
  const data = (await res.json()) as Array<string | [string, string]>;
  const first = data[0];
  return {
    detectedLang: Array.isArray(first) ? first[1] : '',
    translatedLines: data.map((e) => (Array.isArray(e) ? e[0] : e))
  };
}
