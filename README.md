# Sircle to Search

Windows clone of Google's Circle to Search, per [SPEC.md](SPEC.md). Press
**Win+Space**, the screen freezes under a glowing overlay:

- **Search** — circle (lasso) or tap anything; results appear in a Google
  Lens bottom sheet right in the overlay.
- **Translate** — OCR the whole screen (or your selection) and overlay the
  translation in place, matching each line's background color.
- **Music** — identify the song playing through your speakers (system
  loopback, not the microphone).

## Stack

TypeScript + Electron, bundled with esbuild. OCR, visual search, and
translation use Google's public Lens/Translate web endpoints
(`chrome-lens-ocr` for OCR — the same engine Google's screen translate
uses); music recognition uses the `shazam-api` package. No API keys.

The Win+Space combo is owned by the Windows shell, so a small native helper
(`src/native/HotkeyHelper.cs`, compiled during build by the `csc.exe` that
ships with Windows) takes it with a low-level keyboard hook. While the app
runs, Win+Space no longer switches input language (Ctrl+Shift still does).
If the helper is unavailable the app falls back to Ctrl+Shift+Space — the
tray tooltip shows the active combo.

## Run

```powershell
npm install
npm start
```

The app lives in the tray (blue dot icon).

## Usage

| Action | How |
| --- | --- |
| Open overlay | Win+Space (or click the tray icon) |
| Search | Circle anything, or tap it |
| Search whole screen | Enter |
| Translate | Click **Translate** (translates selection if you circled one) |
| Identify music | Click **Music** while a song plays — the overlay turns see-through so the video keeps playing visibly |
| Back / close | Esc (closes results, then selection, then overlay) |

Translation target language follows your Windows display language.

## Verification

`npm run typecheck` + `node build.mjs` must pass. With the app running
unpackaged it exposes CDP on port 9223; the harness in the session scratchpad
(`verify.js`) draws a synthetic lasso, asserts stroke pixels land exactly on
the dispatched coordinates, and checks the Lens sheet loads real results.

## Notes

- Lens/Translate endpoints are unofficial and may change; each lives in its
  own module (`lens.ts`, `translate.ts`, `music.ts`).
- Lens result URLs are session-bound — that is why results render in-app
  instead of opening the external browser.
