# YouTube Realtime ASR (Side Panel) — MVP

A local-only Chrome Extension (Manifest V3) that captures audio from the active
**YouTube tab** and prepares it for realtime ASR (speech-to-text), displayed live
in a React-based Chrome **Side Panel**.

- No backend server.
- No Web Speech API.
- No microphone permission — audio is captured directly from the browser tab.
- No overlay/subtitles injected into the YouTube page — all UI lives in the Side Panel.

> A real streaming ASR engine (Vosk WASM) is wired in behind the `initAsr()` /
> `feedToAsr()` interface and produces live partial/final transcripts in the
> side panel. See [Setting up the ASR models](#setting-up-the-vosk-asr-models)
> below — **you must supply a model file before transcription will work.**

## Demo

https://github.com/user-attachments/assets/39d0f06d-48a5-4729-88bb-beb44c12c2e3

## Architecture

```
YouTube livestream tab audio
  → chrome.tabCapture.getMediaStreamId()
  → offscreen document (offscreen.html / offscreen.js)
  → Web Audio API (AudioContext + MediaStreamSource)
  → AudioWorklet (pcm-worklet.js)
  → Float32 PCM chunks
  → downsample to 16kHz
  → feedToAsr(pcm16k)
  → asr-engine.js: createAsrEngine() → acceptAudio(pcm16k) → { partialText?, finalText? }
  → background service worker (broadcasts ASR_STATUS / ASR_TEXT / ASR_ERROR)
  → React Side Panel (chrome.runtime.connect port)
```

## Project structure

```
youtube-asr-sidepanel/
├─ package.json
├─ vite.config.js
├─ public/
│  ├─ manifest.json
│  └─ models/                # place your Vosk model archives here (see below)
├─ src/
│  ├─ background/
│  │  └─ background.js       # service worker: side panel + tabCapture + offscreen + message routing
│  ├─ offscreen/
│  │  ├─ offscreen.html
│  │  ├─ offscreen.js        # getUserMedia(tab), AudioContext, AudioWorklet wiring, ASR wiring
│  │  ├─ asr-engine.js       # createAsrEngine() abstraction (Vosk WASM implementation)
│  │  └─ pcm-worklet.js      # AudioWorkletProcessor — posts raw Float32 PCM chunks
│  └─ sidepanel/
│     ├─ sidepanel.html
│     ├─ main.jsx
│     ├─ App.jsx             # status / live text / transcript / log / settings UI
│     └─ style.css
└─ dist/                     # build output — load this folder as unpacked extension
```

## Requirements

- Node.js + npm
- Google Chrome 116 or newer (required for `chrome.sidePanel`, `chrome.offscreen`, `chrome.runtime.getContexts`)

## Build & install

```bash
npm install
npm run build
```

Then load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the generated `dist/` folder

## Try it out

1. Open a YouTube livestream (or any YouTube video) in a tab: `https://www.youtube.com/...`
2. Click the extension's toolbar icon
3. The Chrome side panel opens and shows:
   - `Starting YouTube audio capture...`
   - `Audio captured. Listening to YouTube tab audio...`
   - Repeated `Receiving YouTube audio... RMS=0.0xxx` messages, changing in real time as the stream plays
4. YouTube audio keeps playing normally (tab audio is still audible)
5. No subtitle overlay appears on the YouTube page itself — everything shows in the side panel

If the active tab isn't YouTube, the panel shows an error status asking you to open a YouTube tab.

## Development notes

- `npm run dev` starts the Vite dev server, but this project is built around the
  `npm run build` → **Load unpacked** workflow above; MV3 service workers and
  offscreen documents are not meant to be hot-reloaded via a dev server.
- Rebuild (`npm run build`) and click the **reload icon** on the extension card
  in `chrome://extensions` after making changes.
- Capture is started directly inside `chrome.action.onClicked`, not via
  `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. That's
  intentional: `chrome.tabCapture.getMediaStreamId({ targetTabId })` only works on
  a tab that currently holds the `activeTab` grant, and `activeTab` is only
  granted by a direct user gesture such as an action click — `setPanelBehavior`
  would swallow the click internally (so `onClicked` never fires) and capture
  would fail with `"Extension has not been invoked for the current page (see
  activeTab permission)."`. So `onClicked` both opens the side panel
  (`chrome.sidePanel.open()`) and starts capture for the clicked tab.
- The background service worker keeps the last 100 ASR/status messages in memory
  so reopening the side panel replays recent history via a `HISTORY` message.

## Plugging in a different ASR engine

ASR logic is isolated behind a small abstraction in `src/offscreen/asr-engine.js`:

```js
export async function createAsrEngine(config) {
  // config: { sampleRate }
  return {
    async acceptAudio(pcm16k) {
      // Feed Float32Array PCM (16kHz) into your engine and return:
      return { partialText: '...', finalText: '...' }; // both optional
    },
    destroy() {},
  };
}
```

`src/offscreen/offscreen.js` calls `initAsr({ sampleRate })` once (creates the
engine) and `feedToAsr(pcm16k)` continuously (buffers ~200ms of audio, then
calls `asrEngine.acceptAudio()` and turns `partialText`/`finalText` into
`ASR_TEXT` messages) — the audio capture/downsampling pipeline never needs to
change when swapping engines.

The current implementation uses **Vosk WASM** (via the [`vosk-browser`](https://github.com/ccoreilly/vosk-browser)
package). sherpa-onnx WASM (the spec's first preference) has no ready-to-use npm
package — its WebAssembly build must be compiled from source with Emscripten,
which isn't practical to wire up here, so per the spec's documented fallback this
uses Vosk WASM instead, behind the same `createAsrEngine` interface. To swap in
sherpa-onnx or Whisper WebGPU later, write a new module with the same interface
and change the one `import` at the top of `offscreen.js`.

LLM-based translation is intentionally out of scope for this phase.

## Setting up the Vosk ASR models

`public/models/` ships with **two** prebuilt model archives, one per supported
language:

- `en.tar.gz` — `vosk-model-small-en-us-0.15` (English, ~40MB)
- `ja.tar.gz` — `vosk-model-small-ja-0.22` (Japanese, ~47MB)

The side panel's **Source language** dropdown switches between them live —
choosing a language sends a `SET_LANGUAGE` message that background.js persists
(`chrome.storage.local`) and offscreen.js uses to tear down the current Vosk
recognizer/model and load the new one, without restarting audio capture. The
language you pick is remembered across side panel reopens and service worker
restarts.

`asr-engine.js` resolves the model file for a given language as
`models/${lang}.tar.gz`, so adding another language is just a matter of
dropping in a new archive and adding an `<option>` to the dropdown:

1. Download a small model from the official [Vosk models page](https://alphacephei.com/vosk/models)
   (e.g. `vosk-model-small-vn-0.4` for Vietnamese, `vosk-model-small-ko-0.22` for
   Korean).
2. Extract the zip, rename the extracted folder to `model` (so paths inside the
   archive are `model/am/...`, `model/conf/...`, etc. — this matters, it's what
   `vosk-browser`'s worker expects), and repackage it as a gzipped tar archive:
   ```bash
   mv vosk-model-small-vn-0.4 model
   tar czf vi.tar.gz model/
   ```
3. Copy the archive to `public/models/<lang>.tar.gz` (`<lang>` matching the
   `value` you'll use for the new `<option>` in `App.jsx`'s Source language
   dropdown), then rebuild:
   ```bash
   npm run build
   ```

If a model archive is ever missing or fails to load, the side panel still
shows RMS/status updates plus a clear `ASR_ERROR` explaining the problem —
audio capture keeps working either way.

> Note: each `<lang>.tar.gz` is a ~40-50MB binary checked into
> `public/models/`. If you use git and don't want to commit large binaries,
> add them to `.gitignore` and document the download step for other
> contributors instead.

## Permissions used

| Permission | Why |
|---|---|
| `activeTab` | Identify the current tab when the action is clicked |
| `tabCapture` | Capture audio from the YouTube tab |
| `offscreen` | Run the Web Audio / getUserMedia pipeline outside the service worker |
| `sidePanel` | Render the React UI in Chrome's side panel |
| `storage` | Reserved for future settings persistence |
| `host_permissions: *://*.youtube.com/*` | Restrict tab-audio capture/behavior to YouTube |

`manifest.json` sets a custom `content_security_policy.extension_pages` of
`"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"` — the
`'wasm-unsafe-eval'` part is required for `WebAssembly.instantiate()` to run at
all (Chrome enforces just `script-src 'self'` if you don't declare this
explicitly, which blocks WASM compilation entirely). This value is explicitly
sanctioned by Chrome's MV3 CSP validator (unlike `'unsafe-eval'` or `blob:`,
which are always rejected).

Separately, `vosk-browser`'s own `Model` class normally spawns its WASM engine
inside a Web Worker created from a `blob:` URL — but MV3 extension pages reject
`blob:` as a worker-src CSP value outright (Chrome refuses to even load the
extension: *"Insecure CSP value 'blob:' in directive 'worker-src'"*), with no
override able to allow it. Instead, `vite.config.js` extracts that same worker
source (which `vosk-browser` embeds as a base64 string in its bundle) at build
time, patches out its one `new Function(...)` call (Emscripten's cosmetic
`createNamedFunction` embind helper — also blocked by CSP, since only
`'wasm-unsafe-eval'` is allowed, not general `eval`/`new Function`), and emits
it as a real, same-origin file at `dist/offscreen/vosk-worker.js`.
`src/offscreen/asr-engine.js` loads that file directly with
`new Worker(chrome.runtime.getURL(...))` (a `'self'` URL) and speaks
`vosk-browser`'s own postMessage protocol to it by hand, instead of using its
blob-spawning `Model`/`KaldiRecognizer` classes. As a bonus, this also means
the 5MB+ Vosk WASM bundle is no longer duplicated into the offscreen
document's own JS bundle.

## Support

If this project helps you, you can support development by scanning the Buy Me a
Coffee QR code below.

<a href="https://buymeacoffee.com/mink1203">
  <img src="bmc_qr.png" alt="Buy Me a Coffee QR code" width="240">
</a>
