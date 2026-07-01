# YouTube Realtime ASR (Side Panel) — MVP

A local-only Chrome Extension (Manifest V3) that captures audio from the active
**YouTube tab** and prepares it for realtime ASR (speech-to-text), displayed live
in a React-based Chrome **Side Panel**.

- No backend server.
- No Web Speech API.
- No microphone permission — audio is captured directly from the browser tab.
- No overlay/subtitles injected into the YouTube page — all UI lives in the Side Panel.

> **Phase 1A** (current): verifies the full audio pipeline by computing and
> displaying RMS (volume) values in the side panel.
> **Phase 1B** (future): plug a real streaming ASR engine into the already-wired
> `initAsr()` / `feedToAsr()` interface — no pipeline changes needed.

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
  → background service worker (broadcasts ASR_STATUS / ASR_TEXT / ASR_ERROR)
  → React Side Panel (chrome.runtime.connect port)
```

## Project structure

```
youtube-asr-sidepanel/
├─ package.json
├─ vite.config.js
├─ public/
│  └─ manifest.json
├─ src/
│  ├─ background/
│  │  └─ background.js       # service worker: side panel + tabCapture + offscreen + message routing
│  ├─ offscreen/
│  │  ├─ offscreen.html
│  │  ├─ offscreen.js        # getUserMedia(tab), AudioContext, AudioWorklet wiring, ASR interface
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
- `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` is set on
  install, which means Chrome opens the side panel automatically on icon click and
  `chrome.action.onClicked` will *not* fire (documented Chrome behavior). The real
  capture trigger is the side panel connecting to the background via
  `chrome.runtime.connect({ name: 'sidepanel' })` — see `autoStartForActiveTab()`
  in `background.js`.
- The background service worker keeps the last 100 ASR/status messages in memory
  so reopening the side panel replays recent history via a `HISTORY` message.

## Plugging in a real ASR engine (Phase 1B)

All ASR logic is isolated in `src/offscreen/offscreen.js`. Replace the bodies of
these two functions — the audio capture/downsampling pipeline above them does
not need to change:

```js
async function initAsr({ sampleRate }) {
  // Initialize your ASR engine here (e.g. load a WASM/ONNX model).
}

async function feedToAsr(pcm16k) {
  // Feed the Float32Array PCM (16kHz) into your streaming ASR engine.
  // Emit partial/final results:
  chrome.runtime.sendMessage({
    type: 'ASR_TEXT',
    text: 'recognized text here',
    isFinal: false, // true once the segment is finalized
  });
}
```

Preferred ASR engines to evaluate next:

1. [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WASM
2. [Vosk](https://alphacephei.com/vosk/) WASM
3. Whisper WebGPU (chunk-based)

LLM-based translation is intentionally out of scope for this phase.

## Permissions used

| Permission | Why |
|---|---|
| `activeTab` | Identify the current tab when the action is clicked |
| `tabCapture` | Capture audio from the YouTube tab |
| `offscreen` | Run the Web Audio / getUserMedia pipeline outside the service worker |
| `sidePanel` | Render the React UI in Chrome's side panel |
| `storage` | Reserved for future settings persistence |
| `host_permissions: *://*.youtube.com/*` | Restrict tab-audio capture/behavior to YouTube |
