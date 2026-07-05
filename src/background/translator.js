// translator.js — Phase 2A: translates finalized ASR transcript text via an
// OpenAI-compatible chat completions API.
//
// Runs in the background service worker (not offscreen.js) — it has nothing
// to do with audio capture or the ASR engine, it just takes text and returns
// translated text.
//
// The endpoint/API key/model are configurable per-provider from the side
// panel's Settings section (see background.js's llmConfigs/currentLlmProvider
// + the SET_LLM_PROVIDER/SET_LLM_CONFIG messages) and persisted in
// chrome.storage.local. DEFAULT_LLM_CONFIGS below are only the fallback
// values used until the user changes them — both providers expose the same
// POST /v1/chat/completions request/response shape (LM Studio at
// http://localhost:1234 by default), so switching is just a matter of
// picking a provider and filling in its fields.
export const DEFAULT_LLM_CONFIGS = {
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
  },
  lmstudio: {
    endpoint: 'http://localhost:1234/v1/chat/completions',
    apiKey: 'not-needed',
    model: 'qwen3-8b-instruct',
  },
};

const TARGET_LANGUAGE_NAMES = {
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
};

function buildSystemPrompt(targetLang) {
  const targetLanguageName = TARGET_LANGUAGE_NAMES[targetLang] || targetLang;

  return `You are a professional realtime subtitle translator.

Translate the current transcript into ${targetLanguageName}.

The user message is a JSON object with these fields:
- current_text: the ONLY text you must translate and return.
- recent_source: the last few original-language lines before current_text, oldest first.
- recent_translation: your own previous ${targetLanguageName} translations of those same lines, in the same order, for you to stay consistent with.
- glossary: terms that must stay untranslated/unchanged.

Rules:
- Translate current_text only. Never translate, repeat, or re-output recent_source/recent_translation.
- Output only the translated subtitle for current_text — nothing else.
- Keep it short enough for live subtitles.
- Use natural ${targetLanguageName}.
- Preserve technical terms when commonly used by developers.
- Do not explain.
- Do not add information.
- Do not translate names, product names, API names, library names, or code terms.
- Use previous context only to resolve pronouns, omitted subjects, terminology, and tone.`;
}

/**
 * Translates a single finalized ASR transcript chunk via an OpenAI-compatible
 * chat completions API (works with both api.openai.com and a local LM Studio
 * server — see LLM_CONFIG above).
 *
 * @param {object} params
 * @param {string} params.currentText - the finalized source text to translate.
 * @param {string} [params.sourceLang] - source language code/hint (e.g. 'en', 'ja', 'auto').
 * @param {string} [params.targetLang] - target language code (default 'vi').
 * @param {string[]} [params.recentSource] - recent source-language lines, for context.
 * @param {string[]} [params.recentTranslation] - recent translated lines, for context.
 * @param {Record<string,string>} [params.glossary] - terms that should stay untranslated/consistent.
 * @param {{endpoint: string, apiKey: string, model: string}} [params.llmConfig] - which
 *   provider/endpoint/key/model to call (defaults to DEFAULT_LLM_CONFIGS.openai).
 * @returns {Promise<string>} the translated subtitle text.
 */
export async function translateWithLLM({
  currentText,
  sourceLang = 'auto',
  targetLang = 'vi',
  recentSource = [],
  recentTranslation = [],
  glossary = {},
  llmConfig = DEFAULT_LLM_CONFIGS.openai,
}) {
  const { endpoint, apiKey, model } = llmConfig;

  const userMessage = JSON.stringify({
    source_lang: sourceLang,
    target_lang: targetLang,
    glossary,
    recent_source: recentSource,
    recent_translation: recentTranslation,
    current_text: currentText,
  });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey !== 'not-needed') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          { role: 'system', content: buildSystemPrompt(targetLang) },
          { role: 'user', content: userMessage },
        ],
      }),
    });
  } catch (err) {
    // Network-level failure (offline, CORS/host_permissions missing, LM Studio
    // server not running, DNS failure, etc).
    throw new Error(`LLM API request failed (${endpoint}): ${err?.message || err}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || JSON.stringify(errBody);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`LLM API error ${response.status} ${response.statusText}: ${detail || '(no details)'}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`LLM API returned invalid JSON: ${err?.message || err}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM API response did not contain choices[0].message.content');
  }

  return content.trim();
}
