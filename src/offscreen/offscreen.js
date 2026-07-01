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
// ASR interface — Phase 1A implements RMS-only verification. Phase 1B should
// replace the body of these two functions with a real streaming ASR engine
// (sherpa-onnx WASM / Vosk WASM / Whisper WebGPU), without touching the audio
// pipeline above.
// ---------------------------------------------------------------------------

async function initAsr({ sampleRate }) {
  // Placeholder for realtime ASR initialization.
  // Phase 1B: load and warm up the ASR model/engine here, e.g.
  //   await sherpaOnnx.init({ sampleRate })
  console.log('[offscreen] initAsr (placeholder) sampleRate =', sampleRate);
}

// The AudioWorklet calls feedToAsr() continuously (every ~128-sample render
// quantum, i.e. hundreds of times per second) for as long as the tab is
// producing audio — that's correct/expected for a real streaming ASR engine in
// Phase 1B. But reporting an ASR_STATUS message on every single call would
// flood the side panel log and blow through the 100-message history in a
// fraction of a second. So for Phase 1A we throttle only the RMS *reporting*
// cadence, independent of the (unthrottled) audio processing itself.
const STATUS_REPORT_INTERVAL_MS = 300;
let lastStatusReportAt = 0;

async function feedToAsr(pcm16k) {
  // Phase 1A:
  // Calculate RMS and report it as ASR_STATUS so we can visually confirm the
  // full capture pipeline (tab -> offscreen -> worklet -> downsample) works.
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

  // Phase 1B (later): feed pcm16k (Float32Array @ 16kHz) into a streaming ASR
  // engine and emit partial/final results, e.g.:
  //
  //   chrome.runtime.sendMessage({
  //     type: 'ASR_TEXT',
  //     text: 'recognized text here',
  //     isFinal: false,
  //   });
}

function reportStatus(status, message) {
  chrome.runtime.sendMessage({ type: 'ASR_STATUS', status, message }).catch(() => {});
}

function reportError(err) {
  const message = err?.message || String(err);
  chrome.runtime.sendMessage({ type: 'ASR_ERROR', message }).catch(() => {});
}
