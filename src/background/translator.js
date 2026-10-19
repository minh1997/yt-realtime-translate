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
        // Translation needs one completed subtitle, not incremental tokens.
        // Be explicit because some OpenAI-compatible routers default to SSE
        // when this field is omitted.
        stream: false,
        temperature: 0.2,
        // GPT-OSS uses output tokens for reasoning as well as the final
        // translation. A 200-token cap can end generation before content exists.
        max_tokens: /gpt[-_]oss/i.test(model) ? 2048 : 200,
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

  const responseBody = await response.text().catch(() => '');

  if (!response.ok) {
    let detail = responseBody;
    try {
      const errBody = JSON.parse(responseBody);
      detail = errBody?.error?.message || JSON.stringify(errBody);
    } catch {}
    throw new Error(`LLM API error ${response.status} ${response.statusText}: ${detail || '(no details)'}`);
  }

  const translatedText = parseAssistantContent(responseBody, response.headers.get('content-type') || '');
  return validateTranslation(translatedText);
}

function validateTranslation(text) {
  // A chat server should decode the model's message/channel format before
  // returning message.content. Removing only the delimiters would leave
  // reasoning and instructions mixed into the subtitle, so reject the response.
  if (/<\|(?:start|end|channel|message|im_start|im_end|im_sep|meta_sep|meta_start|fim_suffix|ghissue|ghreview|constrain|call)\|>|<\/?think>/u.test(text)) {
    throw new Error(
      'LLM API returned raw model control tokens instead of a clean translation. ' +
        'In LM Studio, update the app and inference runtime, restore the model default prompt template, ' +
        'then unload/reload GPT-OSS. Reload the extension and clear its history before trying again.'
    );
  }

  // Some local inference runtimes return a successful HTTP response whose
  // content is only question marks. Reject it before background.js saves it
  // as translation context, which would feed the broken output into later calls.
  const compact = text.replace(/\s/gu, '');
  if (compact.length >= 8 && /^[?\uFF1F\uFFFD]+$/u.test(compact)) {
    throw new Error(
      'LLM API returned repeated question marks instead of a translation. ' +
        'Check the model output directly in your LLM server. For GPT-OSS in LM Studio, ' +
        'unload/reload the model and try the Vulkan or CPU inference runtime instead of CUDA.'
    );
  }
  return text;
}

function parseAssistantContent(responseBody, contentType) {
  const body = responseBody.trim();
  const isEventStream = contentType.toLowerCase().includes('text/event-stream') || body.startsWith('data:');

  if (isEventStream) {
    return parseSseAssistantContent(body);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new Error(`LLM API returned invalid JSON: ${err?.message || err}`);
  }

  if (data?.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  const choice = data?.choices?.[0];
  const message = choice?.message;
  return requireFinalTranslation(
    contentToText(message?.content),
    choice?.finish_reason,
    Boolean(message?.reasoning || message?.reasoning_content)
  );
}

function parseSseAssistantContent(responseBody) {
  let content = '';
  let sawDataEvent = false;
  let finishReason;
  let hasReasoning = false;

  for (const rawLine of responseBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;

    sawDataEvent = true;
    const eventBody = line.slice('data:'.length).trim();
    if (!eventBody || eventBody === '[DONE]') continue;

    let event;
    try {
      event = JSON.parse(eventBody);
    } catch (err) {
      throw new Error(`LLM API returned invalid SSE data: ${err?.message || err}`);
    }

    if (event?.error) {
      throw new Error(event.error.message || JSON.stringify(event.error));
    }

    const choice = event?.choices?.[0];
    const message = choice?.delta ?? choice?.message;
    content += contentToText(message?.content);
    hasReasoning ||= Boolean(message?.reasoning || message?.reasoning_content);
    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
  }

  if (!sawDataEvent) {
    throw new Error('LLM API returned an empty event stream');
  }

  return requireFinalTranslation(content, finishReason, hasReasoning);
}

function requireFinalTranslation(content, finishReason, hasReasoning) {
  if (content.trim()) return content.trim();

  if (finishReason === 'length') {
    throw new Error(
      'LLM API reached the output token limit before producing a final translation ' +
        '(finish_reason: length). Increase max_tokens or lower the model reasoning effort in LM Studio.'
    );
  }
  if (hasReasoning) {
    // Reasoning is not a translated subtitle and must not become context for
    // later translations. Only the final assistant content is displayed.
    throw new Error(
      'LLM API returned reasoning without a final translation. ' +
        'Increase max_tokens or lower the model reasoning effort in LM Studio.'
    );
  }
  throw new Error(
    'LLM API response did not contain choices[0].message.content ' +
      `(finish_reason: ${finishReason ?? 'missing'}). ` +
      'Check the LM Studio server response and use the /v1/chat/completions endpoint.'
  );
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      return typeof part?.text === 'string' ? part.text : '';
    })
    .join('');
}
