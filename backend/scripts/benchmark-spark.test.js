import test from 'node:test';
import assert from 'node:assert/strict';
import { events, measure, percentile, run, settings } from './benchmark-spark.js';

const config = settings(['--runs', '2', '--warmups', '1'], {
  MODEL_API_KEY: 'synthetic-meta', BASETEN_API_KEY: 'synthetic-baseten',
});
const frame = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function response({ finish = 'stop', done = true, usage = true } = {}) {
  const text = ': ping\r\n\r\n' + frame({ choices: [{ delta: { role: 'assistant' } }] })
    + frame({ model: 'synthetic-model', choices: [{ delta: { content: 'Hi हिन्दी' } }] })
    + frame({ choices: [{ delta: {}, finish_reason: finish }] })
    + (usage ? frame({ choices: [], usage: { completion_tokens: 20, prompt_tokens: 10 } }) : '')
    + (done ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = new TextEncoder().encode(text);
  // Split every byte to exercise partial CRLF and multi-byte text.
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('measures first visible text and total time; uses provider token limits', async () => {
  for (const provider of config.providers) {
    let time = 0;
    const result = await measure(provider, config, async (url, request) => {
      assert.equal(url, `${provider.baseUrl}/chat/completions`);
      assert.equal(request.headers.authorization, `Bearer ${provider.apiKey}`);
      const body = JSON.parse(request.body);
      assert.equal(body.model, provider.model);
      assert.equal(body.stream, true);
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(body[provider.name === 'Meta' ? 'max_completion_tokens' : 'max_tokens'], 1024);
      return response();
    }, () => { time += 100; return time; });
    assert.equal(result.firstTextMs, 100);
    assert.equal(result.totalMs, 200);
    assert.equal(result.endToEndTokensPerSecond, 100);
    assert.equal(result.returnedModel, 'synthetic-model');
    assert.equal(result.textCharacters, 'Hi हिन्दी'.length);
  }
});

test('does not invent token counts when usage is missing', async () => {
  const result = await measure(config.providers[0], config, async () => response({ usage: false }));
  assert.equal(result.outputTokens, null);
  assert.equal(result.endToEndTokensPerSecond, null);
});

test('rejects HTTP errors, SSE errors, and unfinished streams', async () => {
  for (const [fetcher, message] of [
    [async () => new Response('synthetic secret', { status: 429 }), /HTTP 429/],
    [async () => response({ done: false }), /completion marker/],
    [async () => new Response(frame({ error: { message: 'synthetic secret' } }), { headers: { 'content-type': 'text/event-stream' } }), /stream error/],
  ]) await assert.rejects(measure(config.providers[0], config, fetcher), message);
  await assert.rejects(async () => {
    for await (const event of events(new Response('data: {').body)) void event;
  }, /Truncated SSE/);
});

test('alternates order, excludes warmups, and keeps failures out of percentiles', async () => {
  const order = [];
  const report = await run(config, async (url) => {
    order.push(new URL(url).hostname);
    if (order.length === 3) throw new Error('synthetic secret');
    return response({ finish: 'length' });
  }, () => {});
  assert.deepEqual(order, ['api.meta.ai', 'inference.baseten.co', 'inference.baseten.co', 'api.meta.ai', 'api.meta.ai', 'inference.baseten.co']);
  assert.equal(report.summary[0].successes, '2/2');
  assert.equal(report.summary[1].successes, '1/2');
  assert.equal(report.summary[1].truncated, 1);
  assert.equal(report.results[2].error, 'Request failed.');
  assert.equal(percentile([null, 20, 10], 0.5), 10);
  assert.equal(percentile([], 0.95), null);
});

test('validates settings before requests and permits help without keys', () => {
  assert.deepEqual(settings(['--help'], {}), { help: true });
  assert.throws(() => settings([], {}), /MODEL_API_KEY/);
  assert.throws(() => settings(['--runs', '0'], {}), /--runs/);
  assert.throws(() => settings(['--warmups', '-1'], {}), /--warmups/);
  assert.throws(() => settings(['--reasoning-effort', 'none'], {}), /--reasoning-effort/);
});
