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

function makeId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const TARGET_LANG_LABELS = {
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
};

function logText(entry) {
  switch (entry.type) {
    case 'ASR_TEXT':
      return entry.text;
    case 'TRANSLATED_TEXT':
      return `${entry.sourceText} → ${entry.translatedText}`;
    case 'TRANSLATION_STATUS':
      return entry.status;
    case 'TRANSLATION_ERROR':
      return entry.text;
    default:
      return entry.message;
  }
}

export default function App() {
  const [status, setStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState(
    'Open a YouTube livestream tab, then click the extension icon.'
  );
  // Latest partial (not-yet-final) ASR text — display only, never translated.
  const [currentText, setCurrentText] = useState('');
  // Finalized ASR lines + their (possibly still-pending) Vietnamese translation.
  // Each item: { id, source, translation: string | null, createdAt }
  const [transcripts, setTranscripts] = useState([]);
  const [translationStatus, setTranslationStatus] = useState('');
  const [translationError, setTranslationError] = useState('');
  const [logs, setLogs] = useState([]);
  const [paused, setPaused] = useState(false);
  const [settings, setSettings] = useState({
    sourceLang: 'en',
    targetLang: 'vi',
    asrEngine: 'vosk',
    llmProvider: 'openai',
  });

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const portRef = useRef(null);
  const transcriptListRef = useRef(null);

  const appendLog = useCallback((entry) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }, []);

  // Finds the most recent transcript item whose source matches and that
  // hasn't been translated yet, and fills in its translation. If none exists
  // (e.g. the matching final ASR_TEXT never made it into state), appends a
  // new item with both source and translation already set.
  const applyTranslation = useCallback((sourceText, translatedText) => {
    setTranscripts((prev) => {
      let targetIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].source === sourceText && prev[i].translation === null) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) {
        return [
          ...prev,
          { id: makeId(), source: sourceText, translation: translatedText, createdAt: Date.now() },
        ];
      }
      const next = [...prev];
      next[targetIdx] = { ...next[targetIdx], translation: translatedText };
      return next;
    });
  }, []);

  const handleMessage = useCallback(
    (message) => {
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'HISTORY') {
        const hist = Array.isArray(message.history) ? message.history : [];
        setLogs(hist.slice(-MAX_LOGS));

        if (message.lang) {
          setSettings((s) => ({ ...s, sourceLang: message.lang }));
        }
        if (message.targetLang) {
          setSettings((s) => ({ ...s, targetLang: message.targetLang }));
        }

        const lastStatus = [...hist].reverse().find((m) => m.type === 'ASR_STATUS');
        const lastError = [...hist].reverse().find((m) => m.type === 'ASR_ERROR');

        if (lastError && (!lastStatus || lastError.receivedAt > lastStatus.receivedAt)) {
          setStatus('error');
          setStatusMessage(lastError.message);
        } else if (lastStatus) {
          setStatus(lastStatus.status || 'capturing');
          setStatusMessage(lastStatus.message || '');
        }

        // Replay finalized ASR lines + translations + the latest partial
        // text/translation status/error in chronological order, so a
        // reopened side panel shows the same transcript it had before.
        const rebuiltTranscripts = [];
        let rebuiltCurrentText = '';
        let rebuiltTranslationStatus = '';
        let rebuiltTranslationError = '';

        for (const entry of hist) {
          if (entry.type === 'ASR_TEXT') {
            if (entry.isFinal) {
              const text = (entry.text || '').trim();
              if (text) {
                rebuiltTranscripts.push({
                  id: makeId(),
                  source: text,
                  translation: null,
                  createdAt: entry.receivedAt || Date.now(),
                });
              }
              rebuiltCurrentText = '';
            } else {
              rebuiltCurrentText = entry.text || '';
            }
          } else if (entry.type === 'TRANSLATION_STATUS') {
            rebuiltTranslationStatus = entry.status || '';
          } else if (entry.type === 'TRANSLATED_TEXT') {
            rebuiltTranslationStatus = '';
            let targetIdx = -1;
            for (let i = rebuiltTranscripts.length - 1; i >= 0; i--) {
              if (
                rebuiltTranscripts[i].source === entry.sourceText &&
                rebuiltTranscripts[i].translation === null
              ) {
                targetIdx = i;
                break;
              }
            }
            if (targetIdx === -1) {
              rebuiltTranscripts.push({
                id: makeId(),
                source: entry.sourceText,
                translation: entry.translatedText,
                createdAt: entry.receivedAt || Date.now(),
              });
            } else {
              rebuiltTranscripts[targetIdx] = {
                ...rebuiltTranscripts[targetIdx],
                translation: entry.translatedText,
              };
            }
          } else if (entry.type === 'TRANSLATION_ERROR') {
            rebuiltTranslationError = entry.text || '';
          }
        }

        setTranscripts(rebuiltTranscripts);
        setCurrentText(rebuiltCurrentText);
        setTranslationStatus(rebuiltTranslationStatus);
        setTranslationError(rebuiltTranslationError);
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
        appendLog(message);
        if (message.isFinal) {
          const text = (message.text || '').trim();
          setCurrentText('');
          if (text) {
            setTranscripts((prev) => [
              ...prev,
              { id: makeId(), source: text, translation: null, createdAt: Date.now() },
            ]);
          }
        } else {
          setCurrentText(message.text || '');
        }
        return;
      }

      if (message.type === 'TRANSLATION_STATUS') {
        setTranslationStatus(message.status || '');
        appendLog(message);
        return;
      }

      if (message.type === 'TRANSLATED_TEXT') {
        setTranslationStatus('');
        applyTranslation(message.sourceText, message.translatedText);
        appendLog(message);
        return;
      }

      if (message.type === 'TRANSLATION_ERROR') {
        setTranslationStatus('');
        setTranslationError(message.text || 'Unknown translation error');
        appendLog(message);
      }
    },
    [appendLog, applyTranslation]
  );

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    portRef.current = port;

    port.onMessage.addListener(handleMessage);
    port.postMessage({ type: 'GET_HISTORY' });

    return () => {
      port.onMessage.removeListener(handleMessage);
      port.disconnect();
      portRef.current = null;
    };
  }, [handleMessage]);

  useEffect(() => {
    const el = transcriptListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcripts]);

  const handleClear = () => {
    setTranscripts([]);
    setCurrentText('');
    setTranslationStatus('');
    setTranslationError('');
    setLogs([]);
    portRef.current?.postMessage({ type: 'CLEAR_HISTORY' });
  };

  const handleTogglePause = () => setPaused((prev) => !prev);

  const handleSourceLangChange = (e) => {
    const lang = e.target.value;
    setSettings((s) => ({ ...s, sourceLang: lang }));
    chrome.runtime.sendMessage({ type: 'SET_LANGUAGE', lang }).catch(() => {});
  };

  const handleTargetLangChange = (e) => {
    const lang = e.target.value;
    setSettings((s) => ({ ...s, targetLang: lang }));
    chrome.runtime.sendMessage({ type: 'SET_TARGET_LANGUAGE', lang }).catch(() => {});
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>YouTube Realtime ASR + LLM Translation</h1>
      </header>

      <section className={`status-area status-${status}`}>
        <span className="status-dot" />
        <span className="status-label">{STATUS_LABELS[status] || status}</span>
        <span className="status-message">{statusMessage}</span>
      </section>

      {(translationStatus || translationError) && (
        <section
          className={`translation-status-area${translationError ? ' translation-status-error' : ''}`}
        >
          {translationError ? (
            <span className="translation-error-text">Translation error: {translationError}</span>
          ) : (
            <span className="translation-status-text">{translationStatus}</span>
          )}
        </section>
      )}

      <section className="live-text-area">
        <h2>Current ASR</h2>
        <p className="live-text">{currentText || '…'}</p>
      </section>

      <section className="transcript-area">
        <h2>Translated Transcript</h2>
        <div className="transcript-list" ref={transcriptListRef}>
          {transcripts.length === 0 && <p className="empty">No finalized text yet.</p>}
          {transcripts.map((item) => (
            <div key={item.id} className="transcript-item">
              <p className="transcript-source">
                <span className="transcript-label">Source</span>
                {item.source}
              </p>
              <p className="transcript-translation">
                <span className="transcript-label">
                  {TARGET_LANG_LABELS[settings.targetLang] || settings.targetLang}
                </span>
                {item.translation === null ? (
                  <em className="translating">Translating…</em>
                ) : (
                  item.translation
                )}
              </p>
            </div>
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
              <span className="log-text">{logText(entry)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-area">
        <h2>Settings</h2>
        <label>
          Source language
          <select value={settings.sourceLang} onChange={handleSourceLangChange}>
            <option value="en">English</option>
            <option value="ja">Japanese</option>
          </select>
        </label>
        <label>
          Target language
          <select value={settings.targetLang} onChange={handleTargetLangChange}>
            <option value="vi">Vietnamese</option>
            <option value="en">English</option>
            <option value="ja">Japanese</option>
          </select>
        </label>
        <label>
          LLM provider
          <select
            value={settings.llmProvider}
            onChange={(e) => setSettings((s) => ({ ...s, llmProvider: e.target.value }))}
          >
            <option value="openai">OpenAI-compatible API</option>
            <option value="lmstudio">LM Studio local (later)</option>
          </select>
        </label>
        <p className="settings-note">
          Source/target language changes switch the live Vosk model and LLM
          translation target without restarting audio capture. LLM provider
          here is a placeholder — the active endpoint/model is configured in
          src/background/translator.js.
        </p>
      </section>
    </div>
  );
}

