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
//   - Never send audio frames before the config message has actually been
//     sent (configSent guard below), and never drop a frame while the
//     socket is open — if the OS socket send buffer backs up
//     (bufferedAmount growing), report an ASR_STATUS warning to the side
//     panel rather than silently degrading.
//
// This file has no dependency on the createAsrEngine() interface; it's a
// small, focused transport used by asr-whisper-api.js.

const DEFAULT_URL = 'ws://127.0.0.1:8787/asr';
const RECONNECT_DELAY_MS = 1500;
// If the socket's outgoing buffer grows past this, the network/server is
// falling behind the mic; warn (throttled) rather than silently drop audio.
const BUFFERED_AMOUNT_WARNING_BYTES = 256 * 1024;
const BUFFERED_AMOUNT_WARNING_INTERVAL_MS = 3000;

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
    this.configSent = false;
    this._lastBufferedWarningAt = 0;

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
    this.configSent = false;

    socket.onopen = () => {
      this.hasConnectedOnce = true;
      console.log('[stt-client] WebSocket connected', this.url);
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
        // Only allow sendAudio() to actually send frames once the config
        // message has gone out first, per the WebSocket /asr protocol.
        this.configSent = true;
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
      this.configSent = false;
      console.log('[stt-client] WebSocket disconnected', this.url);
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
  // No-ops if the socket isn't currently open (e.g. mid-reconnect) or before
  // the config message has been sent — audio is simply dropped in those
  // cases (there's no connected server session to receive it yet), but never
  // dropped while the socket is open and config-acknowledged. If the OS send
  // buffer is backing up (bufferedAmount growing — the network/server can't
  // keep up), a throttled ASR_STATUS warning is reported instead of silently
  // degrading.
  sendAudio(pcm16k) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.configSent) return;

    if (this.socket.bufferedAmount > BUFFERED_AMOUNT_WARNING_BYTES) {
      const now = Date.now();
      if (now - this._lastBufferedWarningAt > BUFFERED_AMOUNT_WARNING_INTERVAL_MS) {
        this._lastBufferedWarningAt = now;
        console.warn('[stt-client] WebSocket bufferedAmount high', this.socket.bufferedAmount);
        reportStatus(
          'capturing',
          'Warning: audio is being sent faster than the local Whisper API can receive it.'
        );
      }
    }

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
