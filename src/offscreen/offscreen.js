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
//     → asrEngine.acceptAudio(pcm16k) → partial/final text → ASR_TEXT message

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
    handleStart(message.streamId, message.tabId).catch(reportError);
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

    await initAsr({ sampleRate: TARGET_SAMPLE_RATE });

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
  asrBusy = false;
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
// ASR interface — Phase 1B wires in a real streaming ASR engine (see
// asr-engine.js) behind the same initAsr()/feedToAsr() functions used by
// Phase 1A, so the audio pipeline above never needed to change.
// ---------------------------------------------------------------------------

// The AudioWorklet calls feedToAsr() continuously (every ~128-sample render
// quantum, i.e. hundreds of times per second) for as long as the tab is
// producing audio. Reporting an ASR_STATUS message on every single call would
// flood the side panel log, so we throttle the RMS *reporting* cadence,
// independent of the (unthrottled) audio processing/buffering itself.
const STATUS_REPORT_INTERVAL_MS = 300;
let lastStatusReportAt = 0;

let asrEngine = null;
let asrBusy = false;
let pcmBuffer = new Float32Array(0);

// Accumulate ~200ms of 16kHz audio before handing a chunk to the ASR engine.
// Feeding it on every ~2.7ms worklet callback (a few dozen samples) would be
// far too small/inefficient for a real recognizer; this still keeps latency low.
const ASR_CHUNK_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.2);

async function initAsr({ sampleRate }) {
  try {
    asrEngine = await createAsrEngine({ sampleRate });
    console.log('[offscreen] ASR engine ready (Vosk WASM)');
  } catch (err) {
    asrEngine = null;
    console.error('[offscreen] ASR engine failed to initialize', err);
    // Don't rethrow: audio capture + RMS status (Phase 1A) should keep working
    // even if the ASR model asset hasn't been set up yet (see README.md).
    reportError(
      new Error(
        `ASR engine unavailable (${err?.message || err}). Capture will continue without transcription — see README.md to set up the Vosk model.`
      )
    );
  }
}

async function feedToAsr(pcm16k) {
  // Phase 1A: RMS heartbeat so "capturing" status keeps confirming the audio
  // pipeline is alive, independent of whether the ASR engine is ready.
  let sumSquares = 0;
  for (let i = 0; i < pcm16k.length; i++) {
    sumSquares += pcm16k[i] * pcm16k[i];
  }
  const rms = pcm16k.length > 0 ? Math.sqrt(sumSquares / pcm16k.length) : 0;

  const now = Date.now();
  if (now - lastStatusReportAt >= STATUS_REPORT_INTERVAL_MS) {
    lastStatusReportAt = now;
    reportStatus('capturing', `Receiving YouTube audio... RMS=${rms.toFixed(4)}`);
  }

  if (!asrEngine) return; // ASR engine not ready/available.

  pcmBuffer = concatFloat32(pcmBuffer, pcm16k);
  if (pcmBuffer.length < ASR_CHUNK_SAMPLES || asrBusy) return;

  const chunk = pcmBuffer;
  pcmBuffer = new Float32Array(0);
  asrBusy = true;

  try {
    const { partialText, finalText } = await asrEngine.acceptAudio(chunk);

    if (partialText) {
      chrome.runtime
        .sendMessage({ type: 'ASR_TEXT', text: partialText, isFinal: false })
        .catch(() => {});
    }

    if (finalText) {
      chrome.runtime
        .sendMessage({ type: 'ASR_TEXT', text: finalText, isFinal: true })
        .catch(() => {});
    }
  } catch (err) {
    reportError(err);
  } finally {
    asrBusy = false;
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
