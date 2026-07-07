// offscreen.js — hosts the actual tab-audio capture + Web Audio pipeline.
//
// Flow:
//   START_TAB_AUDIO_ASR (from background)
//     → getUserMedia({ tab-capture streamId })
//     → AudioContext + MediaStreamSource
//     → source -> audioContext.destination   (so audio stays audible)
//     → source -> AudioWorkletNode(pcm-worklet-processor)
//     → workletNode.port.onmessage: Float32 PCM chunk
//     → downsample to 16kHz
//     → feedToAsr(pcm16k)
//     → asrEngine.acceptAudio(pcm16k) — forwards audio to the local Whisper
//       API over WebSocket (see asr-whisper-api.js / stt-client.js); the
//       resulting ASR_STATUS/ASR_TEXT/ASR_ERROR messages arrive asynchronously
//       and are sent to background.js directly by stt-client.js, not returned
//       from acceptAudio().

import { createAsrEngine } from './asr-engine.js';

let audioContext = null;
let mediaStream = null;
let mediaStreamSource = null;
let workletNode = null;

const TARGET_SAMPLE_RATE = 16000;

console.log('[offscreen] document loaded, waiting for START_TAB_AUDIO_ASR');

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'START_TAB_AUDIO_ASR') {
    console.log('[offscreen] received START_TAB_AUDIO_ASR', message);
    if (message.lang) currentLang = message.lang;
    handleStart(message.streamId, message.tabId).catch(reportError);
  }

  if (message?.type === 'SET_LANGUAGE') {
    console.log('[offscreen] received SET_LANGUAGE', message.lang);
    switchLanguage(message.lang).catch(reportError);
  }
});

async function handleStart(streamId, tabId) {
  try {
    await stopCapture();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    audioContext = new AudioContext();
    mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);

    // Keep the YouTube tab audio audible to the user.
    mediaStreamSource.connect(audioContext.destination);

    await audioContext.audioWorklet.addModule('pcm-worklet.js');
    workletNode = new AudioWorkletNode(audioContext, 'pcm-worklet-processor');

    workletNode.port.onmessage = (event) => {
      const float32Chunk = event.data;
      const pcm16k = downsampleTo16k(float32Chunk, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      feedToAsr(pcm16k).catch(reportError);
    };

    // source -> workletNode (analysis-only path; not connected to destination,
    // so this does not create an echo/duplicate playback).
    mediaStreamSource.connect(workletNode);

    await initAsr({ sampleRate: TARGET_SAMPLE_RATE, lang: currentLang });

    reportStatus('capturing', 'Audio captured. Listening to YouTube tab audio...');
  } catch (err) {
    await stopCapture();
    reportError(err);
  }
}

async function stopCapture() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (mediaStreamSource) {
    mediaStreamSource.disconnect();
    mediaStreamSource = null;
  }
  if (audioContext) {
    await audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (asrEngine) {
    try {
      asrEngine.destroy();
    } catch (err) {
      console.warn('[offscreen] error destroying ASR engine', err);
    }
    asrEngine = null;
  }
  pcmBuffer = new Float32Array(0);
  asrSwitching = false;
}

// Simple average-based downsampler (Float32 -> Float32 @ targetSampleRate).
function downsampleTo16k(float32Array, inputSampleRate, targetSampleRate) {
  if (targetSampleRate === inputSampleRate) {
    return float32Array;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(float32Array.length / ratio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetInput = 0;

  while (offsetResult < newLength) {
    const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetInput; i < nextOffsetInput && i < float32Array.length; i++) {
      accum += float32Array[i];
      count++;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetInput = nextOffsetInput;
  }

  return result;
}

// ---------------------------------------------------------------------------
// ASR interface — a real ASR engine (see asr-engine.js) sits behind the same
// initAsr()/feedToAsr() functions, so the audio pipeline above never needs to
// change when swapping engines. The active engine talks to a local Whisper
// API over WebSocket (see asr-whisper-api.js); RMS/status heartbeats now come
// from that server (forwarded by stt-client.js) instead of being computed
// here.
// ---------------------------------------------------------------------------

let asrEngine = null;
let asrSwitching = false;
let pcmBuffer = new Float32Array(0);
let currentLang = 'en';

// Accumulate ~200ms of 16kHz audio before handing a chunk to the ASR engine.
// Feeding it on every ~2.7ms worklet callback (a few dozen samples) would be
// far too small/inefficient for a real recognizer; this still keeps latency low.
const ASR_CHUNK_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.2);

async function initAsr({ sampleRate, lang }) {
  if (lang) currentLang = lang;
  try {
    asrEngine = await createAsrEngine({ sampleRate, lang: currentLang });
    console.log('[offscreen] ASR engine ready (local Whisper API)', currentLang);
  } catch (err) {
    asrEngine = null;
    console.error('[offscreen] ASR engine failed to initialize', err);
    // Don't rethrow: audio capture should keep working even if the ASR engine
    // couldn't be created — see whisper-api/README.md to start the local server.
    reportError(
      new Error(
        `ASR engine unavailable (${err?.message || err}). Capture will continue without transcription — make sure the local Whisper API is running (see whisper-api/README.md).`
      )
    );
  }
}

// Switches the ASR engine's language on the fly, without touching the audio
// capture pipeline (AudioContext/worklet keep running). Safe to call whether
// or not capture has started yet — if it hasn't, this just remembers the
// chosen language for when it does.
async function switchLanguage(lang) {
  if (!lang || lang === currentLang) return;
  if (asrSwitching) return;

  currentLang = lang;

  if (!audioContext) return; // Capture not running yet; new lang applies on next start.

  asrSwitching = true;
  reportStatus('starting', `Switching ASR language to "${lang}"...`);

  const previousEngine = asrEngine;
  asrEngine = null; // feedToAsr() safely skips ASR while this is null.
  pcmBuffer = new Float32Array(0);

  try {
    if (previousEngine) previousEngine.destroy();
  } catch (err) {
    console.warn('[offscreen] error destroying previous ASR engine', err);
  }

  try {
    await initAsr({ sampleRate: TARGET_SAMPLE_RATE, lang });
    reportStatus('capturing', `Listening in "${lang}"...`);
  } finally {
    asrSwitching = false;
  }
}

async function feedToAsr(pcm16k) {
  if (!asrEngine) return; // ASR engine not ready/available.

  pcmBuffer = concatFloat32(pcmBuffer, pcm16k);
  if (pcmBuffer.length < ASR_CHUNK_SAMPLES) return;

  const chunk = pcmBuffer;
  pcmBuffer = new Float32Array(0);

  try {
    await asrEngine.acceptAudio(chunk);
  } catch (err) {
    reportError(err);
  }
}

function concatFloat32(a, b) {
  const result = new Float32Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function reportStatus(status, message) {
  chrome.runtime.sendMessage({ type: 'ASR_STATUS', status, message }).catch(() => {});
}

function reportError(err) {
  const message = err?.message || String(err);
  chrome.runtime.sendMessage({ type: 'ASR_ERROR', message }).catch(() => {});
}
