import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

// No SDK or backend server is required. Importing this file makes no requests.
export function settings(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args, options: {
    runs: { type: 'string', default: '5' },
    warmups: { type: 'string', default: '1' },
    'max-tokens': { type: 'string', default: '1024' },
    'timeout-ms': { type: 'string', default: '60000' },
    'reasoning-effort': { type: 'string', default: 'low' },
    prompt: { type: 'string', default: 'Explain how a browser loads a web page in about 150 words.' },
    output: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  for (const name of ['runs', 'warmups', 'max-tokens', 'timeout-ms']) {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < (name === 'warmups' ? 0 : 1)) {
      throw new Error(`--${name} must be an integer >= ${name === 'warmups' ? 0 : 1}.`);
    }
    values[name] = value;
  }
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(values['reasoning-effort'])) {
    throw new Error('--reasoning-effort must be minimal, low, medium, high, or xhigh.');
  }
  const providers = [
    { name: 'Meta', baseUrl: env.META_API_BASE_URL || 'https://api.meta.ai/v1',
      model: env.META_MODEL || 'muse-spark-1.3', apiKey: env.META_API_KEY || env.MODEL_API_KEY },
    { name: 'Baseten', baseUrl: env.BASETEN_API_BASE_URL || 'https://inference.baseten.co/v1',
      model: env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026', apiKey: env.BASETEN_API_KEY },
  ];
  for (const provider of providers) {
    if (!provider.apiKey) throw new Error(`Set ${provider.name === 'Meta' ? 'MODEL_API_KEY (or META_API_KEY)' : 'BASETEN_API_KEY'} before running.`);
    const url = new URL(provider.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`${provider.name} API base URL must be HTTPS with no credentials, query, or fragment.`);
    }
  }
  return { ...values, providers };
}

// Parse SSE frames, including split UTF-8 bytes and CRLF boundaries.
export async function* events(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  if ((buffer + decoder.decode()).trim()) throw new Error('Truncated SSE frame.');
}

export async function measure(provider, config, fetcher = fetch, now = () => performance.now()) {
  const started = now();
  const response = await fetcher(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config['timeout-ms']),
    headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      model: provider.model, messages: [{ role: 'user', content: config.prompt }],
      stream: true, reasoning_effort: config['reasoning-effort'],
      ...(provider.name === 'Meta'
        ? { max_completion_tokens: config['max-tokens'] }
        : { max_tokens: config['max-tokens'], stream_options: { include_usage: true } }),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('Expected a streaming SSE response.');
  }
  let firstTextMs = null;
  let textCharacters = 0;
  let usage = null;
  let finishReason = null;
  let returnedModel = null;
  let done = false;
  for await (const data of events(response.body)) {
    if (data.trim() === '[DONE]') { done = true; break; }
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('Invalid stream JSON.'); }
    if (event.error) throw new Error('Provider returned a stream error.');
    returnedModel = event.model ?? returnedModel;
    const choice = event.choices?.[0];
    const content = choice?.delta?.content;
    if (typeof content === 'string' && content.length) {
      firstTextMs ??= now() - started;
      textCharacters += content.length;
    }
    finishReason = choice?.finish_reason ?? finishReason;
    usage = event.usage ?? usage;
  }
  const totalMs = now() - started;
  if (!done || !finishReason) throw new Error('Stream ended without a completion marker.');
  if (firstTextMs === null) throw new Error('No visible text returned; check the token limit.');
  const outputTokens = Number.isInteger(usage?.completion_tokens) ? usage.completion_tokens : null;
  return { firstTextMs, totalMs, textCharacters, outputTokens,
    // Includes reasoning, queue, network, and generation time; this is not decode speed.
    endToEndTokensPerSecond: outputTokens === null ? null : outputTokens / (totalMs / 1000),
    promptTokens: usage?.prompt_tokens ?? null,
    cachedPromptTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    returnedModel, finishReason };
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

export async function run(config, fetcher = fetch, log = console.log) {
  const results = [];
  log(`Streaming benchmark: ${config.runs} measured + ${config.warmups} warmup requests per provider.`);
  log('Model IDs may refer to different releases. Compare model capability separately.');
  for (const provider of config.providers) log(`${provider.name}: ${provider.model}`);
  // Sequential requests avoid contention. Alternate which provider runs first.
  for (let round = 0; round < config.warmups + config.runs; round += 1) {
    const warmup = round < config.warmups;
    const providers = round % 2 ? [...config.providers].reverse() : config.providers;
    for (const provider of providers) {
      const row = { provider: provider.name, model: provider.model, warmup, round: round + 1 };
      try {
        Object.assign(row, await measure(provider, config, fetcher));
        log(`${provider.name} ${warmup ? 'warmup' : 'run'}: first text ${row.firstTextMs.toFixed(0)} ms, total ${row.totalMs.toFixed(0)} ms (${row.finishReason})`);
      } catch (error) {
        // Never print provider error bodies, URLs, keys, or arbitrary network error text.
        row.error = /^(HTTP \d{3}|Expected a streaming SSE response\.|Invalid stream JSON\.|Provider returned a stream error\.|Stream ended without a completion marker\.|Truncated SSE frame\.|No visible text returned; check the token limit\.)$/.test(error.message)
          ? error.message : error.name === 'TimeoutError' ? 'Request timed out.' : 'Request failed.';
        log(`${provider.name} ${warmup ? 'warmup' : 'run'} failed: ${row.error}`);
      }
      results.push(row);
    }
  }
  const summary = config.providers.map((provider) => {
    const measured = results.filter((row) => row.provider === provider.name && !row.warmup);
    const ok = measured.filter((row) => !row.error);
    const metric = (key, p) => percentile(ok.map((row) => row[key]), p)?.toFixed(1) ?? 'n/a';
    return { provider: provider.name, model: provider.model, successes: `${ok.length}/${measured.length}`,
      'first text p50 ms': metric('firstTextMs', 0.5), 'first text p95 ms': metric('firstTextMs', 0.95),
      'total p50 ms': metric('totalMs', 0.5), 'total p95 ms': metric('totalMs', 0.95),
      'end-to-end tok/s p50': metric('endToEndTokensPerSecond', 0.5),
      truncated: ok.filter((row) => row.finishReason === 'length').length };
  });
  return { results, summary };
}

async function main() {
  const config = settings();
  if (config.help) {
    console.log('Run from the repo root: node --env-file=backend/.env backend/scripts/benchmark-spark.js');
    console.log('Options: --runs 5 --warmups 1 --max-tokens 1024 --timeout-ms 60000 --reasoning-effort low --prompt "..." --output /tmp/spark-results.json');
    console.log('Keys: MODEL_API_KEY (or META_API_KEY), BASETEN_API_KEY. Models: META_MODEL, BASETEN_MODEL.');
    return;
  }
  const report = await run(config);
  console.table(report.summary);
  if (config.output) {
    // Credentials and prompt/output text are excluded from the saved report.
    const { providers, prompt, ...parameters } = config;
    delete parameters.output;
    await writeFile(config.output, JSON.stringify({ timestamp: new Date().toISOString(), parameters, ...report }, null, 2) + '\n', { mode: 0o600 });
  }
  if (report.results.some((row) => !row.warmup && row.error)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Benchmark failed. Check keys, options, HTTPS base URLs, and output path. Use --help for usage.');
    process.exitCode = 1;
  });
}
