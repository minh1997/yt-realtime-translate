// translator.js — Phase 2A: translates finalized ASR transcript text into
// Vietnamese via an OpenAI-compatible chat completions API.
//
// Runs in the background service worker (not offscreen.js) — it has nothing
// to do with audio capture or the ASR engine, it just takes text and returns
// translated text.
//
// Supports both a remote OpenAI-compatible endpoint and a local LM Studio
// server: both expose the same POST /v1/chat/completions request/response
// shape, so switching providers is just a matter of editing LLM_CONFIG below.

// --- Remote OpenAI-compatible API (default) ---
const LLM_CONFIG = {
  endpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'YOUR_OPENAI_API_KEY', // <-- replace with your own key (or set to 'not-needed' for LM Studio)
  model: 'gpt-4o-mini',
};

// --- Local LM Studio API ---
// LM Studio (https://lmstudio.ai) exposes an OpenAI-compatible server at
// http://localhost:1234 by default. To use it instead of the remote API,
// comment out the LLM_CONFIG above and uncomment this one (and add
// "http://localhost:1234/*" to host_permissions in manifest.json — already
// included by default, see manifest.json).
// const LLM_CONFIG = {
//   endpoint: 'http://localhost:1234/v1/chat/completions',
//   apiKey: 'not-needed',
//   model: 'qwen3-8b-instruct',
// };

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
 * @returns {Promise<string>} the translated subtitle text.
 */
export async function translateWithLLM({
  currentText,
  sourceLang = 'auto',
  targetLang = 'vi',
  recentSource = [],
  recentTranslation = [],
  glossary = {},
}) {
  const userMessage = JSON.stringify({
    source_lang: sourceLang,
    target_lang: targetLang,
    glossary,
    recent_source: recentSource,
    recent_translation: recentTranslation,
    current_text: currentText,
  });

  const headers = { 'Content-Type': 'application/json' };
  if (LLM_CONFIG.apiKey && LLM_CONFIG.apiKey !== 'not-needed') {
    headers.Authorization = `Bearer ${LLM_CONFIG.apiKey}`;
  }

  let response;
  try {
    response = await fetch(LLM_CONFIG.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: LLM_CONFIG.model,
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
    throw new Error(`LLM API request failed (${LLM_CONFIG.endpoint}): ${err?.message || err}`);
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
