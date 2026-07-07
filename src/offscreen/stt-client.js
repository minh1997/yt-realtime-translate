// stt-client.js — WebSocket client for the local Whisper API (whisper-api/).
//
// Responsibilities:
//   - Connect to ws://127.0.0.1:8787/asr (configurable via constructor option).
//   - Send a JSON config message once the socket opens.
//   - Convert incoming Float32 PCM (16kHz, range [-1, 1]) to Int16 PCM and
//     send it as binary WebSocket frames.
//   - Parse JSON messages sent back by the server (ASR_STATUS / ASR_TEXT /
//     ASR_ERROR) and forward them to background.js via
//     chrome.runtime.sendMessage(), normalized into the message shape the
//     rest of the extension already expects:
//       server {type:'ASR_STATUS', text}          -> {type:'ASR_STATUS', status, message}
//       server {type:'ASR_TEXT', text, isFinal}    -> forwarded as-is (already matches)
//       server {type:'ASR_ERROR', text}            -> {type:'ASR_ERROR', message}
//   - Automatically reconnect (fixed delay) if the connection drops or never
//     opens, re-sending the config message once reconnected.
//
// This file has no dependency on the createAsrEngine() interface; it's a
// small, focused transport used by asr-whisper-api.js.

const DEFAULT_URL = 'ws://127.0.0.1:8787/asr';
const RECONNECT_DELAY_MS = 1500;

function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

export class SttClient {
  constructor({ url = DEFAULT_URL, sampleRate = 16000, language = 'ja' } = {}) {
    this.url = url;
    this.sampleRate = sampleRate;
    this.language = language;

    this.socket = null;
    this.destroyed = false;
    this.reconnectTimer = null;
    this.hasConnectedOnce = false;

    this._connect();
  }

  _connect() {
    if (this.destroyed) return;

    reportStatus('starting', `Connecting to local Whisper API (${this.url})...`);

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect(err);
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.hasConnectedOnce = true;
      reportStatus('capturing', 'Connected to local Whisper API.');
      try {
        socket.send(
          JSON.stringify({
            type: 'config',
            sampleRate: this.sampleRate,
            encoding: 'pcm_s16le',
            channels: 1,
            language: this.language,
            task: 'transcribe',
          })
        );
      } catch (err) {
        reportError(err);
      }
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        console.warn('[stt-client] failed to parse server message', event.data);
        return;
      }
      this._forwardServerMessage(message);
    };

    socket.onerror = () => {
      // onclose fires right after and handles reporting/reconnecting, so we
      // avoid double-reporting the same failure here.
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.destroyed) return;
      reportStatus('error', 'Disconnected from local Whisper API. Reconnecting...');
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect(err) {
    if (err) reportError(err);
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, RECONNECT_DELAY_MS);
  }

  _forwardServerMessage(message) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'ASR_STATUS') {
      reportStatus('capturing', message.text || '');
      return;
    }
    if (message.type === 'ASR_TEXT') {
      chrome.runtime
        .sendMessage({
          type: 'ASR_TEXT',
          text: message.text || '',
          isFinal: !!message.isFinal,
          engine: message.engine,
        })
        .catch(() => {});
      return;
    }
    if (message.type === 'ASR_ERROR') {
      reportError(new Error(message.text || 'Unknown Whisper API error'));
    }
  }

  // Sends a chunk of Float32 PCM (16kHz, [-1,1]) as an Int16 binary frame.
  // No-ops if the socket isn't currently open (e.g. mid-reconnect) — audio is
  // simply dropped rather than buffered, since Whisper transcribes recent
  // rolling context server-side anyway (see whisper-api/app/audio_buffer.py).
  sendAudio(pcm16k) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const int16 = float32ToInt16(pcm16k);
    try {
      this.socket.send(int16.buffer);
    } catch (err) {
      reportError(err);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }
}

function reportStatus(status, message) {
  chrome.runtime.sendMessage({ type: 'ASR_STATUS', status, message }).catch(() => {});
}

function reportError(err) {
  const message = err?.message || String(err);
  chrome.runtime.sendMessage({ type: 'ASR_ERROR', message }).catch(() => {});
}
