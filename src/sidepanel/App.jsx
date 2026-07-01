import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_LOGS = 100;

const STATUS_LABELS = {
  idle: 'Idle',
  starting: 'Starting…',
  capturing: 'Capturing',
  error: 'Error',
};

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

export default function App() {
  const [status, setStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState(
    'Open a YouTube livestream tab, then click the extension icon.'
  );
  const [liveText, setLiveText] = useState('');
  const [transcript, setTranscript] = useState([]);
  const [logs, setLogs] = useState([]);
  const [paused, setPaused] = useState(false);
  const [settings, setSettings] = useState({
    sourceLang: 'auto',
    targetLang: 'none',
    asrEngine: 'sherpa-onnx',
  });

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const appendLog = useCallback((entry) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }, []);

  const handleMessage = useCallback(
    (message) => {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'HISTORY') {
        const hist = Array.isArray(message.history) ? message.history : [];
        setLogs(hist.slice(-MAX_LOGS));

        const lastStatus = [...hist].reverse().find((m) => m.type === 'ASR_STATUS');
        const lastError = [...hist].reverse().find((m) => m.type === 'ASR_ERROR');

        if (lastError && (!lastStatus || lastError.receivedAt > lastStatus.receivedAt)) {
          setStatus('error');
          setStatusMessage(lastError.message);
        } else if (lastStatus) {
          setStatus(lastStatus.status || 'capturing');
          setStatusMessage(lastStatus.message || '');
        }

        const finalTexts = hist.filter((m) => m.type === 'ASR_TEXT' && m.isFinal);
        setTranscript(finalTexts.map((m) => m.text));

        const lastPartial = [...hist].reverse().find((m) => m.type === 'ASR_TEXT' && !m.isFinal);
        if (lastPartial) setLiveText(lastPartial.text || '');
        return;
      }

      if (pausedRef.current) return;

      if (message.type === 'ASR_STATUS') {
        setStatus(message.status || 'capturing');
        setStatusMessage(message.message || '');
        appendLog(message);
        return;
      }

      if (message.type === 'ASR_ERROR') {
        setStatus('error');
        setStatusMessage(message.message || 'Unknown error');
        appendLog(message);
        return;
      }

      if (message.type === 'ASR_TEXT') {
        if (message.isFinal) {
          setTranscript((prev) => [...prev, message.text]);
          setLiveText('');
        } else {
          setLiveText(message.text || '');
        }
        appendLog(message);
      }
    },
    [appendLog]
  );

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'sidepanel' });

    port.onMessage.addListener(handleMessage);
    port.postMessage({ type: 'GET_HISTORY' });

    return () => {
      port.onMessage.removeListener(handleMessage);
      port.disconnect();
    };
  }, [handleMessage]);

  const handleClear = () => {
    setTranscript([]);
    setLiveText('');
    setLogs([]);
  };

  const handleTogglePause = () => setPaused((prev) => !prev);

  return (
    <div className="app">
      <header className="app-header">
        <h1>YouTube Realtime ASR</h1>
      </header>

      <section className={`status-area status-${status}`}>
        <span className="status-dot" />
        <span className="status-label">{STATUS_LABELS[status] || status}</span>
        <span className="status-message">{statusMessage}</span>
      </section>

      <section className="live-text-area">
        <h2>Live</h2>
        <p className="live-text">{liveText || '…'}</p>
      </section>

      <section className="transcript-area">
        <h2>Transcript</h2>
        <div className="transcript-list">
          {transcript.length === 0 && <p className="empty">No finalized text yet.</p>}
          {transcript.map((text, idx) => (
            <p key={idx} className="transcript-item">
              {text}
            </p>
          ))}
        </div>
      </section>

      <section className="controls">
        <button type="button" onClick={handleClear}>
          Clear
        </button>
        <button type="button" onClick={handleTogglePause}>
          {paused ? 'Resume display' : 'Pause display'}
        </button>
      </section>

      <section className="log-area">
        <h2>Log</h2>
        <div className="log-list">
          {logs.length === 0 && <p className="empty">No messages yet.</p>}
          {logs.map((entry, idx) => (
            <div key={idx} className={`log-item log-${entry.type}`}>
              <span className="log-time">{formatTime(entry.receivedAt)}</span>
              <span className="log-type">{entry.type}</span>
              <span className="log-text">
                {entry.type === 'ASR_TEXT' ? entry.text : entry.message}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-area">
        <h2>Settings</h2>
        <label>
          Source language
          <select
            value={settings.sourceLang}
            onChange={(e) => setSettings((s) => ({ ...s, sourceLang: e.target.value }))}
          >
            <option value="auto">Auto detect</option>
            <option value="en">English</option>
            <option value="ko">Korean</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
          </select>
        </label>
        <label>
          Target language
          <select
            value={settings.targetLang}
            onChange={(e) => setSettings((s) => ({ ...s, targetLang: e.target.value }))}
          >
            <option value="none">None (transcription only)</option>
            <option value="en">English</option>
            <option value="ko">Korean</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
          </select>
        </label>
        <label>
          ASR engine
          <select
            value={settings.asrEngine}
            onChange={(e) => setSettings((s) => ({ ...s, asrEngine: e.target.value }))}
          >
            <option value="sherpa-onnx">sherpa-onnx WASM</option>
            <option value="vosk">Vosk WASM</option>
            <option value="whisper-webgpu">Whisper WebGPU (later)</option>
          </select>
        </label>
        <p className="settings-note">
          Settings are placeholders for Phase 1B — no ASR engine is running yet.
        </p>
      </section>
    </div>
  );
}
