// asr-whisper-api.js — ASR engine backed by a local Whisper API (FastAPI +
// faster-whisper running as its own process, see whisper-api/), reached over
// WebSocket instead of an in-browser WASM engine.
//
// export async function createWhisperApiAsrEngine(config) returns an engine
// exposing the same interface every other engine in this repo implements:
//   async acceptAudio(pcm16k: Float32Array) => { partialText?, finalText? }
//
// Unlike the Vosk WASM engine (asr-vosk.js), transcription happens in a
// separate local process, so acceptAudio() only forwards audio over the
// WebSocket connection (see stt-client.js) — it does not return partial/final
// text directly. The resulting ASR_STATUS / ASR_TEXT / ASR_ERROR messages are
// sent to background.js by stt-client.js as they arrive asynchronously from
// the server, so acceptAudio() always resolves with an empty object. This
// still satisfies the createAsrEngine() abstraction used by offscreen.js,
// which only ever reads partialText/finalText off the (possibly empty) result
// if present.
//
// config:
//   sampleRate — PCM sample rate, always 16000 in this pipeline.
//   lang       — ASR language code ('en' | 'ja'), passed through to the
//                Whisper API's `language` config field.
//   url        — override the local Whisper API WebSocket URL (defaults to
//                ws://127.0.0.1:8787/asr, matching whisper-api/'s default
//                `uvicorn ... --port 8787` and its /asr route).

import { SttClient } from './stt-client.js';

const DEFAULT_WS_URL = 'ws://127.0.0.1:8787/asr';

export async function createWhisperApiAsrEngine(config = {}) {
  const { sampleRate = 16000, lang = 'ja', url = DEFAULT_WS_URL } = config;

  const client = new SttClient({ url, sampleRate, language: lang });

  return {
    async acceptAudio(pcm16k) {
      if (!pcm16k || pcm16k.length === 0) return {};
      client.sendAudio(pcm16k);
      return {};
    },

    destroy() {
      client.destroy();
    },
  };
}
