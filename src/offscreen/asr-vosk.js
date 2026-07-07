// asr-vosk.js — Vosk WASM ASR engine (PREVIOUS default, now isolated/unused).
//
// This is the in-browser Vosk WASM implementation that used to back
// asr-engine.js's createAsrEngine(). It's kept here, untouched, in case you
// need to roll back to a fully in-browser (no local server required) ASR
// engine — asr-engine.js no longer imports this file by default; the active
// engine is now the local Whisper API client (see asr-whisper-api.js).
//
// To bring this back as the active engine, change asr-engine.js back to:
//   export { createVoskAsrEngine as createAsrEngine } from './asr-vosk.js';
//
// export async function createVoskAsrEngine(config) returns an engine exposing:
//   async acceptAudio(pcm16k: Float32Array) => { partialText?: string, finalText?: string }
//
// Backing implementation: the Vosk WASM engine bundled by the `vosk-browser`
// npm package.
//
// Why this talks to the worker directly instead of using vosk-browser's own
// Model/KaldiRecognizer classes:
// vosk-browser's Model class always spawns its worker via `new Worker(blobUrl)`,
// where blobUrl is a `blob:` URL it builds internally. MV3 extension pages
// reject `blob:` as a worker-src CSP value outright — Chrome refuses to even
// load the extension ("Insecure CSP value 'blob:' in directive 'worker-src'"),
// and there is no CSP override that can allow it. So instead:
//   - vite.config.js extracts that exact same worker source (which
//     vosk-browser embeds as a base64 string in its bundle) at build time and
//     emits it as a real, same-origin file: dist/offscreen/vosk-worker.js.
//   - This file loads that worker directly (`new Worker(chrome.runtime.getURL(...))`,
//     a 'self' URL, fully CSP-compliant) and speaks vosk-browser's own
//     postMessage protocol to it by hand (reverse-engineered from
//     node_modules/vosk-browser/dist/{model,interfaces}.d.ts and vosk.js):
//       -> {action: 'set', key: 'logLevel', value}
//       -> {action: 'load', modelUrl}                       <- {event: 'load', result}
//       -> {action: 'create', recognizerId, sampleRate}
//       -> {action: 'audioChunk', recognizerId, data, sampleRate}
//                                     <- {event: 'partialresult'|'result', recognizerId, result}
//       -> {action: 'remove', recognizerId} / {action: 'terminate'}
//
// IMPORTANT — the acoustic model is a separate asset that must be supplied:
// the WASM engine itself is fully bundled here, but it still needs a trained
// acoustic model (a gzipped tar archive) to actually recognize speech. Model
// files are NOT included in this repo (they're tens of MB of binary data each)
// — see README.md for how to download one per language and place it at
// public/models/<lang>.tar.gz (e.g. models/en.tar.gz, models/ja.tar.gz).

// Each supported language ships as its own model archive under
// public/models/ (e.g. models/en.tar.gz, models/ja.tar.gz) so the side panel
// can switch between them at runtime without rebuilding.
const DEFAULT_LANG = 'en';
const WORKER_PATH = 'offscreen/vosk-worker.js';

function modelPathForLang(lang) {
  return `models/${lang || DEFAULT_LANG}.tar.gz`;
}

// Kaldi/Vosk expects samples scaled to the range of a signed int16
// (-32768..32767), whereas our pipeline's Float32 PCM is normalized -1.0..1.0.
const INT16_SCALE = 0x8000;

// The worker reports results asynchronously via events (no per-call
// request/response correlation id). After submitting a chunk we give it a
// brief window to catch up before reading back whatever partial/final text it
// produced, so acceptAudio() can still return a synchronous-looking
// { partialText?, finalText? } result as required by the interface.
const RESULT_SETTLE_MS = 80;

export async function createVoskAsrEngine(config = {}) {
  const { sampleRate = 16000, lang = DEFAULT_LANG, modelPath = modelPathForLang(lang) } = config;

  const workerUrl = chrome.runtime.getURL(WORKER_PATH);
  console.log('[asr-vosk] creating worker', workerUrl);
  const worker = new Worker(workerUrl);
  const recognizerId = crypto.randomUUID();

  worker.onerror = (event) => {
    console.error('[asr-vosk] worker onerror', event.message, event.filename, event.lineno, event);
  };
  worker.onmessageerror = (event) => {
    console.error('[asr-vosk] worker onmessageerror', event);
  };

  let latestPartialText = '';
  let lastReportedPartialText = '';
  const pendingFinalTexts = [];

  worker.addEventListener('message', (event) => {
    const message = event.data;
    console.log('[asr-vosk] worker message', message);
    if (!message) return;

    if (message.event === 'error') {
      console.error('[asr-vosk] worker reported error', message.error);
      return;
    }

    if (message.recognizerId !== recognizerId) return;

    if (message.event === 'partialresult') {
      latestPartialText = message.result?.partial ?? '';
    } else if (message.event === 'result') {
      const text = message.result?.text ?? '';
      if (text) {
        pendingFinalTexts.push(text);
      }
    }
  });

  const modelUrl = chrome.runtime.getURL(modelPath);
  console.log('[asr-vosk] loading model', modelUrl);
  await loadModel(worker, modelUrl);
  console.log('[asr-vosk] model loaded');

  worker.postMessage({
    action: 'create',
    recognizerId,
    sampleRate,
  });
  worker.postMessage({
    action: 'set',
    recognizerId,
    key: 'words',
    value: false,
  });

  return {
    async acceptAudio(pcm16k) {
      const data = new Float32Array(pcm16k.length);
      for (let i = 0; i < pcm16k.length; i++) {
        data[i] = pcm16k[i] * INT16_SCALE;
      }

      worker.postMessage(
        {
          action: 'audioChunk',
          recognizerId,
          data,
          sampleRate,
        },
        { transfer: [data.buffer] }
      );

      await wait(RESULT_SETTLE_MS);

      const output = {};

      if (pendingFinalTexts.length > 0) {
        output.finalText = pendingFinalTexts.shift();
        // A finalized result also resets Vosk's internal partial buffer.
        latestPartialText = '';
        lastReportedPartialText = '';
      } else if (latestPartialText && latestPartialText !== lastReportedPartialText) {
        output.partialText = latestPartialText;
        lastReportedPartialText = latestPartialText;
      }

      return output;
    },

    destroy() {
      worker.postMessage({ action: 'remove', recognizerId });
      worker.postMessage({ action: 'terminate' });
      worker.terminate();
    },
  };
}

const MODEL_LOAD_TIMEOUT_MS = 30000;

function loadModel(worker, modelUrl) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      worker.removeEventListener('message', onMessage);
      reject(
        new Error(
          `Timed out waiting for the ASR model to load from ${modelUrl} (no response after ${MODEL_LOAD_TIMEOUT_MS}ms). Check that the model archive exists under public/models/ and is a valid vosk-browser model archive.`
        )
      );
    }, MODEL_LOAD_TIMEOUT_MS);

    const onMessage = (event) => {
      const message = event.data;
      if (message?.event === 'error') {
        clearTimeout(timeoutId);
        worker.removeEventListener('message', onMessage);
        reject(new Error(message.error || `ASR worker error while loading model from ${modelUrl}`));
        return;
      }
      if (message?.event !== 'load') return;
      clearTimeout(timeoutId);
      worker.removeEventListener('message', onMessage);
      if (message.result) {
        resolve();
      } else {
        reject(new Error(`Failed to load ASR model from ${modelUrl}`));
      }
    };
    worker.addEventListener('message', onMessage);

    worker.postMessage({ action: 'set', key: 'logLevel', value: 0 });
    worker.postMessage({ action: 'load', modelUrl });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
