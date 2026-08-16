# Sircle to Search — Specification

Windows desktop clone of Google's Circle to Search: press a global shortcut,
the screen freezes under a glowing overlay, and anything can be circled to
search, translated in place, or identified as music. Feel and motion follow
Google's implementation as closely as the desktop allows.

## Stack

- TypeScript (strict) everywhere; Electron 43; esbuild bundling (`build.mjs`).
- No frameworks in the renderer: hand-written DOM + canvas + CSS animation.
- Native piece: `src/native/HotkeyHelper.cs`, compiled at build time by the
  .NET Framework `csc.exe` that ships with Windows.
- No API keys. Google Lens and Translate via public web endpoints, Shazam via
  the `shazam-api` package, OCR local via tesseract.js.

## Global shortcut

- **Win+Space** opens/closes the overlay. The Windows shell owns this combo,
  so the helper takes it with a WH_KEYBOARD_LL hook: swallows the keystroke,
  injects a dummy key (so releasing Win does not open the Start menu), prints
  `HOTKEY` on stdout. Electron main debounces (350 ms, key auto-repeat).
- Helper exits when its stdin closes (parent died). If the helper is missing
  or fails, fall back to `Ctrl+Shift+Space` via `globalShortcut`.
- Tray icon (drawn in memory) with tooltip showing the active combo, click =
  toggle overlay, context menu = Capture / Quit. App lives in tray; closing
  the overlay never quits the app.

## Overlay

- One frameless, **transparent**, always-on-top (`screen-saver`) window
  covering the display under the cursor exactly, corner to corner (a
  transparent window also avoids Windows 11's DWM corner rounding).
  Background = full-resolution frozen screenshot of that display
  (`desktopCapturer`, thumbnail at physical pixel size); since the window is
  transparent, the shot fades in over the identical live screen with no
  visible seam.
- All hit-testing and drawing in CSS pixels; every fixed-position layer,
  including the lasso canvas, is explicitly sized `100vw × 100vh` (a canvas
  left to its intrinsic attribute size misaligns on scaled displays).
- Esc walks back one step at a time: results sheet → selection/translations →
  overlay. Clicking tray or pressing the shortcut again also closes it.

### Invocation motion (Google reference: user's screenshots, Aug 2026)

1. Screen dims slightly (~0.25 black) over ~300 ms.
2. **Color wash, not a border ring**: large, heavily blurred pastel radial
   gradients (Google blue / green / amber / red) bleed in from the corners
   and edge midpoints, drifting slowly around the perimeter (~14 s loop);
   the center stays readable via a radial mask. A soft white bloom rises
   from the bottom edge on entry. Whole wash at low alpha, breathing gently.
3. Bottom pill toolbar slides up: dark rounded pill (Google dark surface
   #202124-ish), actions **Search · Translate · Music**, white iconography.
4. Hint pill "Circle or tap anything to search" above the toolbar.
5. A soft glowing dot follows the pointer (system cursor hidden on canvas).

### Lasso

- Freehand stroke: light-blue glowing stroke (white core, #4285f4 halo),
  quadratic-midpoint smoothing, sparkle/stardust particles trailing the tip.
- Tap (<6 px movement) blooms a rounded rectangle out from the tap point.
- On release the path closes, outside area darkens (spotlight via
  destination-out), stroke pulses; selection immediately triggers the active
  mode (search by default).
- Enter with no selection = whole-screen search.

## Search (Google Lens)

- Crop = selection bounding box + 4 px pad, at physical resolution,
  downscaled so the longest side ≤1000 px, PNG.
- Upload: `POST https://lens.google.com/v3/upload` (multipart field
  `encoded_image`) **through `session.defaultSession.fetch`** so Google's
  session cookies land in the app's cookie store; follow redirects and take
  the final URL. Result URLs are session-bound — opened without the upload
  cookies Google shows "Expired visual search", so results must render
  inside the app, never in the external browser.
- Consent: pre-seed the `SOCS` cookie on `.google.com` to skip the EU
  consent interstitial.
- **Results bottom sheet** (Google-style): renderer animates a rounded-top
  dark sheet (~86 vw wide, max ~1040 px, ~56 vh tall, drag-handle header,
  close button) sliding up; when the slide lands, main attaches a
  `WebContentsView` (default session, rounded corners when the API exists)
  over the sheet body and loads the results URL. New selection while the
  sheet is open just re-searches and reloads the view. `target=_blank`
  links open in the system browser.

## Translate

- Translate button: OCR the selection if one exists, else the whole screen.
- OCR via Google Lens (`chrome-lens-ocr` in main) — the same engine Google's
  own screen translate uses, so segmentation and Cyrillic quality match it.
- Translation: `translate_a/single?client=gtx` (lines joined with `\n`),
  fallback `translate_a/t?client=dict-chrome-ex` (true per-line batching).
  Target language = Windows display language.
- Each OCR line is covered by a positioned div: background = averaged pixels
  just outside the line's bbox, text color by luminance, font sized to the
  box (shrunk to fit width), staggered fade-in. Esc clears.

## Music

- Music button switches to a **live widget mode**: the overlay window itself
  shrinks to a small bottom-center card (640×420). Nothing else on screen is
  covered by any window, so background video keeps rendering (a fullscreen
  always-on-top window makes Chrome treat itself as occluded and freeze
  frames) and the desktop stays fully interactive while listening. Esc (or
  Cancel) restores the fullscreen frozen overlay. System loopback audio via
  `getDisplayMedia` + `setDisplayMediaRequestHandler` with
  `audio: 'loopback'` (video track requested, then stopped+removed).
- PCM: AudioContext at 16 kHz (Chromium resamples), mono, s16.
- Progressive recognition while still recording: try at 4 s, 8 s, 12 s
  (Shazam's signature window caps at 12 s). `shazam-api`'s
  `fullRecognizeSong` in main.
- Result card: cover art, title, artist; Open = track URL or YouTube search.

## Verification

- `npm run typecheck` clean; `node build.mjs` green.
- App runs with `--remote-debugging-port=9223` when unpackaged; a CDP
  harness (scratchpad, `ws` devDependency) drives the real overlay:
  synthetic pointer lasso → assert stroke pixels land exactly on the
  dispatched coordinates (canvas `getImageData`), assert the sheet
  WebContents appears with a google.com/search URL that does NOT contain
  "Expired visual search", capture screenshots for visual review.
- OCR+translate pipeline has a standalone node smoke test (scratchpad).

## Non-goals

- No packaging/installer, no auto-update, no macOS/Linux, no settings UI.
- Unofficial endpoints may break; modules isolate them (`lens.ts`,
  `translate.ts`, `music.ts`).
