// asr-engine.js — active ASR engine selection.
//
// The extension's ASR layer now talks to a local Whisper API (FastAPI +
// faster-whisper, run as its own process — see whisper-api/) over WebSocket,
// instead of running Vosk WASM in-browser. See asr-whisper-api.js and
// stt-client.js for the client side, and whisper-api/app/main.py for the
// server side.
//
// The previous Vosk WASM implementation is preserved, untouched and unused,
// in asr-vosk.js in case you need to roll back to a fully in-browser engine
// (no local server process required). To roll back, change the export below
// to:
//   export { createVoskAsrEngine as createAsrEngine } from './asr-vosk.js';
//
// Every engine module in this directory implements the same interface:
//   async function createAsrEngine(config) => {
//     async acceptAudio(pcm16k: Float32Array) => { partialText?, finalText? },
//     destroy(),
//   }
// so offscreen.js never needs to change when swapping the engine.
export { createWhisperApiAsrEngine as createAsrEngine } from './asr-whisper-api.js';
