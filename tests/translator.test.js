import assert from 'node:assert/strict';
import test from 'node:test';
import { translateWithLLM } from '../src/background/translator.js';

const llmConfig = {
  endpoint: 'http://localhost:1234/v1/chat/completions',
  apiKey: 'not-needed',
  model: 'openai/gpt-oss-20b',
};

function jsonResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(parts) {
  const events = parts.map((content) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  );
  return new Response(events.join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('preserves Unicode in the request and JSON translation', async (t) => {
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    assert.equal(endpoint, llmConfig.endpoint);
    const body = JSON.parse(options.body);
    assert.equal(body.model, llmConfig.model);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 2048);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(body.messages[1].content).current_text, 'こんにちは');
    return jsonResponse('Xin chào, bạn khỏe không?');
  });

  assert.equal(
    await translateWithLLM({ currentText: 'こんにちは', llmConfig }),
    'Xin chào, bạn khỏe không?'
  );
});

test('preserves Unicode in SSE translations', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sseResponse(['Xin chào', ', bạn khỏe không?']));
  assert.equal(
    await translateWithLLM({ currentText: 'Hello, how are you?', llmConfig }),
    'Xin chào, bạn khỏe không?'
  );
});

for (const [label, output] of [
  ['ASCII question marks', '?'.repeat(200)],
  ['spaced question marks', '? ? ? ?\n? ? ? ?'],
  ['fullwidth question marks', '？'.repeat(20)],
  ['replacement characters', '�'.repeat(20)],
]) {
  test(`rejects ${label} from a successful JSON response`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(output));
    await assert.rejects(
      translateWithLLM({ currentText: 'Hello', llmConfig }),
      /repeated question marks.*Vulkan or CPU/s
    );
  });
}

test('rejects question mark floods assembled from SSE chunks', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sseResponse(['????', '????', '????']));
  await assert.rejects(
    translateWithLLM({ currentText: 'Hello', llmConfig }),
    /repeated question marks/
  );
});

test('allows legitimate questions and short punctuation', async (t) => {
  const outputs = ['Bạn khỏe không?', 'なぜ？', 'Why????????', '???'];
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(outputs.shift()));
  for (const expected of [...outputs]) {
    assert.equal(await translateWithLLM({ currentText: 'Why?', llmConfig }), expected);
  }
});

test('keeps the existing output budget for non-reasoning models', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_endpoint, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 200);
    return jsonResponse('Xin chào');
  });
  assert.equal(
    await translateWithLLM({ currentText: 'Hello', llmConfig: { ...llmConfig, model: 'gpt-4o-mini' } }),
    'Xin chào'
  );
});

function completionResponse(message, finishReason) {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('reports token exhaustion when GPT-OSS returns only reasoning', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    completionResponse({ content: null, reasoning: 'Reasoning placeholder' }, 'length')
  );
  await assert.rejects(
    translateWithLLM({ currentText: 'Hello', llmConfig }),
    /output token limit.*max_tokens/
  );
});

for (const field of ['reasoning', 'reasoning_content']) {
  test(`does not use ${field} as a translation when final content is missing`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      completionResponse({ content: '', [field]: 'Reasoning placeholder' }, 'stop')
    );
    await assert.rejects(
      translateWithLLM({ currentText: 'Hello', llmConfig }),
      /reasoning without a final translation/
    );
  });
}

test('returns final content when a JSON response also contains reasoning', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    completionResponse({ content: 'Xin chào', reasoning: 'Reasoning placeholder' }, 'stop')
  );
  assert.equal(await translateWithLLM({ currentText: 'Hello', llmConfig }), 'Xin chào');
});

function streamChoices(choices) {
  return new Response(
    choices.map((choice) => `data: ${JSON.stringify({ choices: [choice] })}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
}

test('reports token exhaustion in reasoning-only SSE responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamChoices([
    { delta: { reasoning: 'Reasoning placeholder' } },
    { delta: {}, finish_reason: 'length' },
  ]));
  await assert.rejects(
    translateWithLLM({ currentText: 'Hello', llmConfig }),
    /output token limit.*max_tokens/
  );
});

test('ignores streamed reasoning and returns only final content', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamChoices([
    { delta: { reasoning_content: 'Reasoning placeholder' } },
    { delta: { content: 'Xin ' } },
    { delta: { content: 'chào' } },
    { delta: {}, finish_reason: 'stop' },
  ]));
  assert.equal(await translateWithLLM({ currentText: 'Hello', llmConfig }), 'Xin chào');
});

test('explains unexpected response shapes without treating them as translations', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ output: [] })));
  await assert.rejects(
    translateWithLLM({ currentText: 'Hello', llmConfig }),
    /finish_reason: missing.*\/v1\/chat\/completions/
  );
});

test('surfaces JSON API errors even with a successful HTTP status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { message: 'Model is not loaded' } }))
  );
  await assert.rejects(
    translateWithLLM({ currentText: 'Hello', llmConfig }),
    /Model is not loaded/
  );
});

test('rejects the reported malformed GPT-OSS translation', async (t) => {
  const leaked = '<|start|>commentaryTôi đang làm việc cho bạn.' +
    '<|channel|>analysis to=commentary to=final<|message|>We only translate current_text.' +
    '<|channel|>commentaryDưới đây là bản dịch:<|channel|>analysis';
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(leaked));
  await assert.rejects(
    translateWithLLM({ currentText: 'I am working for you.', llmConfig }),
    /raw model control tokens.*default prompt template/
  );
});

for (const output of [
  '<|im_start|>assistant<|meta_sep|>final<|im_sep|>Xin chào<|fim_suffix|>',
  'Xin chào<|end|>',
  '<think>Reasoning placeholder</think>Xin chào',
  'Xin chào</think>',
]) {
  test(`rejects leaked model formatting: ${output}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(output));
    await assert.rejects(
      translateWithLLM({ currentText: 'Hello', llmConfig }),
      /raw model control tokens/
    );
  });
}

test('detects model control tokens split across SSE chunks', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    sseResponse(['Xin chào<|cha', 'nnel|>analysis'])
  );
  await assert.rejects(
    translateWithLLM({ currentText: 'Hello', llmConfig }),
    /raw model control tokens/
  );
});

test('allows ordinary uses of channel names and angle brackets', async (t) => {
  const translation = 'Kênh commentary đang phân tích (analysis): 2 < 3 và 5 > 4.';
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(translation));
  assert.equal(await translateWithLLM({ currentText: 'Example', llmConfig }), translation);
});
