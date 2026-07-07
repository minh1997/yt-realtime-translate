# YouTube Realtime ASR (Side Panel) — MVP

A Chrome Extension (Manifest V3) that captures audio from the active
**YouTube tab** and transcribes it in realtime using a **local Whisper API**
(FastAPI + [faster-whisper](https://github.com/SYSTRAN/faster-whisper)),
displayed live in a React-based Chrome **Side Panel**.

- No remote backend — the Whisper API runs locally on `127.0.0.1` only.
- No Web Speech API.
- No microphone permission — audio is captured directly from the browser tab.
- No overlay/subtitles injected into the YouTube page — all UI lives in the Side Panel.

> Realtime ASR is wired in behind the `initAsr()` / `feedToAsr()` interface in
> `offscreen.js`, which forwards audio over WebSocket to a local Whisper API
> process (see [whisper-api/](whisper-api/README.md)) and shows live
> partial/final transcripts in the side panel. **You must start the local
> Whisper API before transcription will work** — see
> [Local Whisper API](#local-whisper-api) below.

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
  → feedToAsr(pcm16k) → asr-engine.js: createAsrEngine() → acceptAudio(pcm16k)
  → asr-whisper-api.js / stt-client.js: Float32 → Int16 PCM
  → WebSocket ws://127.0.0.1:8787/asr
  → whisper-api/ (local FastAPI + faster-whisper process)
  → ASR_STATUS / ASR_TEXT / ASR_ERROR JSON sent back over the same socket
  → background service worker (broadcasts to all side panels)
  → React Side Panel (chrome.runtime.connect port)
  → optional LLM translation of finalized text (src/background/translator.js)
```

## Project structure

```
youtube-asr-sidepanel/
├─ package.json               # root scripts: dev/build (extension) + dev:whisper (API)
├─ vite.config.js
├─ public/
│  ├─ manifest.json
│  └─ models/                 # Vosk model archives — only needed if you roll back to asr-vosk.js
├─ src/
│  ├─ background/
│  │  ├─ background.js       # service worker: side panel + tabCapture + offscreen + message routing
│  │  └─ translator.js       # optional LLM translation of finalized transcript lines
│  ├─ offscreen/
│  │  ├─ offscreen.html
│  │  ├─ offscreen.js        # getUserMedia(tab), AudioContext, AudioWorklet wiring, ASR wiring
│  │  ├─ asr-engine.js       # active-engine selector — re-exports asr-whisper-api.js
│  │  ├─ asr-whisper-api.js  # createAsrEngine() implementation backed by the local Whisper API
│  │  ├─ stt-client.js       # WebSocket client: PCM→Int16 framing, reconnect, message forwarding
│  │  ├─ asr-vosk.js         # previous Vosk WASM implementation, isolated/unused (rollback option)
│  │  └─ pcm-worklet.js      # AudioWorkletProcessor — posts raw Float32 PCM chunks
│  └─ sidepanel/
│     ├─ sidepanel.html
│     ├─ main.jsx
│     ├─ App.jsx             # status / live text / transcript / log / settings UI
│     └─ style.css
├─ whisper-api/               # local FastAPI + faster-whisper server (see whisper-api/README.md)
│  ├─ requirements.txt
│  ├─ README.md
│  └─ app/
│     ├─ main.py             # GET /health, WebSocket /asr
│     ├─ transcriber.py      # faster-whisper wrapper
│     ├─ audio_buffer.py     # rolling PCM buffer
│     └─ settings.py         # env-driven config (STT_MODEL, STT_DEVICE, ...)
└─ dist/                      # build output — load this folder as unpacked extension
```

## Requirements

- Node.js + npm
- Google Chrome 116 or newer (required for `chrome.sidePanel`, `chrome.offscreen`, `chrome.runtime.getContexts`)
- Python 3.9+ (for the local Whisper API in [whisper-api/](whisper-api/README.md))

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

1. Start the local Whisper API first (see [Local Whisper API](#local-whisper-api)):
   ```bash
   npm run dev:whisper
   ```
2. Open a YouTube livestream (or any YouTube video) in a tab: `https://www.youtube.com/...`
3. Click the extension's toolbar icon
4. The Chrome side panel opens and shows:
   - `Starting YouTube audio capture...`
   - `Audio captured. Listening to YouTube tab audio...`
   - `Connecting to local Whisper API (ws://127.0.0.1:8787/asr)...`
   - `Connected to local Whisper API.`
   - Repeated `Receiving audio... RMS=0.0xxx` messages (sent by the server), changing in real time as the stream plays
5. When people speak, partial transcript text appears live, followed by a finalized line once the audio pauses — and, if an LLM provider is configured in Settings, its translation shortly after
6. YouTube audio keeps playing normally (tab audio is still audible)
7. No subtitle overlay appears on the YouTube page itself — everything shows in the side panel

If the active tab isn't YouTube, the panel shows an error status asking you to open a YouTube tab.
If the local Whisper API isn't running, the panel keeps showing `Disconnected from
local Whisper API. Reconnecting...` — audio capture and playback still work fine either way.

## Development notes

- `npm run dev:extension` starts the Vite dev server for the extension alone
  (`npm run dev` also starts the local Whisper API alongside it), but this
  project is built around the `npm run build:extension` → **Load unpacked**
  workflow above; MV3 service workers and offscreen documents are not meant to
  be hot-reloaded via a dev server.
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

## Local Whisper API

Transcription is done by a local FastAPI + faster-whisper server in
[whisper-api/](whisper-api/README.md), not in the browser. It runs on your
machine only (`127.0.0.1:8787`) — no audio or transcript ever leaves it, and
no remote STT API is called.

```bash
# from the repo root, runs both the Whisper API and the extension's Vite dev build
npm run dev

# or just the Whisper API on its own
npm run dev:whisper
```

See [whisper-api/README.md](whisper-api/README.md) for setup, environment
variables (model size, device, etc.), and the full WebSocket message format.

## Plugging in a different ASR engine

ASR logic is isolated behind a small abstraction re-exported from
`src/offscreen/asr-engine.js`:

```js
export async function createAsrEngine(config) {
  // config: { sampleRate, lang }
  return {
    async acceptAudio(pcm16k) {
      // Feed Float32Array PCM (16kHz) into your engine. Since transcription
      // can happen asynchronously (e.g. over a network/WebSocket), it's fine
      // to just forward the audio here and send ASR_TEXT messages separately
      // via chrome.runtime.sendMessage() as results arrive — or return them
      // directly: { partialText: '...', finalText: '...' } (both optional).
      return {};
    },
    destroy() {},
  };
}
```

`src/offscreen/offscreen.js` calls `initAsr({ sampleRate, lang })` once
(creates the engine) and `feedToAsr(pcm16k)` continuously (buffers ~200ms of
audio, then calls `asrEngine.acceptAudio()`) — the audio capture/downsampling
pipeline never needs to change when swapping engines.

The active implementation, `src/offscreen/asr-whisper-api.js`, forwards audio
to a **local Whisper API** (`whisper-api/`, FastAPI + faster-whisper) over a
WebSocket managed by `src/offscreen/stt-client.js`. Whisper's ASR_STATUS /
ASR_TEXT / ASR_ERROR messages arrive asynchronously from the server and are
sent to `background.js` directly by `stt-client.js`, rather than being
returned from `acceptAudio()`.

The **previous** implementation, **Vosk WASM** (via the
[`vosk-browser`](https://github.com/ccoreilly/vosk-browser) package), is kept
unchanged and unused in `src/offscreen/asr-vosk.js` in case you need to roll
back to a fully in-browser engine (no local server process required) — just
change the one export in `asr-engine.js` back to
`export { createVoskAsrEngine as createAsrEngine } from './asr-vosk.js';`.

LLM-based translation of finalized transcript lines (via
`src/background/translator.js`, configurable per-provider from the side
panel's Settings section) runs independently of whichever ASR engine is
active, and only ever sees `isFinal: true` text.

## ASR models

**The default Whisper engine does not need anything from this repo's
`public/models/` folder.** `faster-whisper` downloads and caches its own
model weights (from Hugging Face) automatically the first time the local
Whisper API starts with a given `STT_MODEL` — see
[whisper-api/README.md](whisper-api/README.md) for the available model sizes
and how to change which one is used.

`public/models/en.tar.gz` and `public/models/ja.tar.gz` (Vosk model archives)
are only used if you roll back to the Vosk WASM engine in `asr-vosk.js` (see
above) — they're otherwise unused and safe to ignore or delete.

## Permissions used

| Permission | Why |
|---|---|
| `activeTab` | Identify the current tab when the action is clicked |
| `tabCapture` | Capture audio from the YouTube tab |
| `offscreen` | Run the Web Audio / getUserMedia pipeline outside the service worker |
| `sidePanel` | Render the React UI in Chrome's side panel |
| `storage` | Persist selected languages / LLM provider config across restarts |
| `host_permissions: http(s)://127.0.0.1:8787/*`, `ws://127.0.0.1:8787/*`, `http://localhost:8787/*`, `ws://localhost:8787/*` | Connect to the local Whisper API (`whisper-api/`) |
| `host_permissions: https://api.openai.com/*`, `http://localhost:1234/*` | Call an LLM API for translation (see `src/background/translator.js`) |
| `host_permissions: *://*.youtube.com/*` | Restrict tab-audio capture/behavior to YouTube |

`manifest.json` sets a custom `content_security_policy.extension_pages` of
`"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"` — the
`'wasm-unsafe-eval'` part is required for `WebAssembly.instantiate()` to run at
all (Chrome enforces just `script-src 'self'` if you don't declare this
explicitly, which blocks WASM compilation entirely). This value is explicitly
sanctioned by Chrome's MV3 CSP validator (unlike `'unsafe-eval'` or `blob:`,
which are always rejected). It's currently unused by the active (Whisper API)
ASR engine, which needs no WASM at all — it's kept because `asr-vosk.js`
(unused, see above) still needs it if you roll back to it.

Separately, `vosk-browser`'s own `Model` class normally spawns its WASM engine
inside a Web Worker created from a `blob:` URL — but MV3 extension pages reject
`blob:` as a worker-src CSP value outright (Chrome refuses to even load the
extension: *"Insecure CSP value 'blob:' in directive 'worker-src'"*), with no
override able to allow it. Instead, `vite.config.js` extracts that same worker
source (which `vosk-browser` embeds as a base64 string in its bundle) at build
time, patches out its one `new Function(...)` call (Emscripten's cosmetic
`createNamedFunction` embind helper — also blocked by CSP, since only
`'wasm-unsafe-eval'` is allowed, not general `eval`/`new Function`), and emits
it as a real, same-origin file at `dist/offscreen/vosk-worker.js`. This build
step still runs (so a Vosk rollback keeps working out of the box), even though
nothing imports `asr-vosk.js` by default.

## Support

If this project helps you, you can support development by scanning the Buy Me a
Coffee QR code below.

<a href="https://buymeacoffee.com/mink1203">
  <img src="bmc_qr.png" alt="Buy Me a Coffee QR code" width="240">
</a>
