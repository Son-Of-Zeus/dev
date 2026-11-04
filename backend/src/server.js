import { publicModelFailure } from './reasoning-errors.js';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ContractValidationError, MAX_REASON_BODY_BYTES, validateReasonRequest, validateGuideAction, validateSemanticPlan } from './contracts.js';
import { createReasoner, MissingTargetError } from './reasoner.js';
import { createSpeechProvider, speechProviderStatus } from './speech-provider.js';

export function allowedOrigins(value = process.env.ALLOWED_ORIGINS ?? '') {
  return new Set((Array.isArray(value) ? value : value.split(',')).map((item) => item.trim()).filter(Boolean));
}
export function originAllowed(origin, origins) { return typeof origin === 'string' && origins.has(origin); }
function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(body);
}
export function createBackendRequestHandler(options = {}) {
  const origins = allowedOrigins(options.allowedOrigins);
  const reasoner = options.reasoner ?? createReasoner(options);
  return async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') { json(response, 200, { status: 'ok' }); return; }
    const origin = request.headers.origin;
    if (!originAllowed(origin, origins)) { json(response, 403, { error: 'Origin is not allowed.' }); return; }
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-expose-headers', 'server-timing, x-reasoning-decision');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (['GET', 'POST'].includes(request.method) && request.url === '/speech/status') {
      request.resume();
      json(response, 200, speechProviderStatus({ provider: options.sttProvider, meta: options.speech }));
      return;
    }
    if (!['/reason', '/reason/stream'].includes(request.url)) { json(response, 404, { error: 'Route not found.' }); return; }
    if (request.method !== 'POST') { json(response, 405, { error: 'Use POST.' }); return; }
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    const streaming = request.url === '/reason/stream';
    const emit = (event) => {
      if (response.destroyed || controller.signal.aborted) return;
      if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      response.write('data: ' + JSON.stringify(event) + '\n\n');
    };
    let inputValidated = false;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REASON_BODY_BYTES) { json(response, 413, { error: 'Page is too large. Narrow the page area.' }); return; }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { json(response, 400, { error: 'Invalid JSON.' }); return; }
      const normalized = validateReasonRequest(payload);
      inputValidated = true;
      if (streaming) {
        const started = performance.now();
        const background = [];
        const result = await reasoner.reason(normalized, { signal: controller.signal,
          onBackground: (promise) => background.push(promise),
          onPlan: (update) => emit({ type: 'plan', plan: validateSemanticPlan(update.plan), ...(update.failed ? { failed: true } : {}) }),
          onTiming: (stage, durationMs) => emit({ type: 'diagnostic', metric: { stage, durationMs } }),
          onDecision: (decision) => emit({ type: 'decision', decision }),
        });
        controller.signal.throwIfAborted();
        emit({ type: 'action', action: validateGuideAction(result, normalized.page.elements) });
        emit({ type: 'diagnostic', metric: { stage: 'first-guidance', durationMs: performance.now() - started } });
        await Promise.all(background);
        emit({ type: 'done' });
        response.end();
        return;
      }
      const timings = [];
      let decision;
      const result = await reasoner.reason(normalized, { onDecision: (value) => { decision = value; }, signal: controller.signal, onTiming: (stage, ms) => timings.push(`${stage};dur=${ms.toFixed(1)}`) });
      response.setHeader('server-timing', timings.join(', '));
      if (decision) response.setHeader('x-reasoning-decision', JSON.stringify(decision));
      json(response, 200, validateGuideAction(result, normalized.page.elements));
    } catch (error) {
      if (response.destroyed) return;
      const failure = publicModelFailure(error);
      if (inputValidated && !(error instanceof MissingTargetError)) {
        const report = options.onFailure ?? ((details) => console.warn('[Voice Companion reasoning]', details));
        report(failure);
      }
      if (streaming && response.headersSent) {
        emit({ type: 'error', status: error instanceof MissingTargetError ? 409 : 502, ...(error instanceof MissingTargetError ? { code: 'TARGET_NOT_FOUND' } : failure) });
        response.end(); return;
      }
      if (error instanceof MissingTargetError) json(response, 409, { error: 'Target not found. Rescan once.', code: 'TARGET_NOT_FOUND' });
      else if (error instanceof ContractValidationError && !inputValidated) json(response, 400, { error: error.message });
      else json(response, 502, { error: failure.message, ...failure });
    }
  };
}
export function createBackendServer(options = {}) {
  const speech = options.relay ? { relay: options.relay, close() {} } : createSpeechProvider({ provider: options.sttProvider, meta: options.speech });
  const server = http.createServer(createBackendRequestHandler(options));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const origins = allowedOrigins(options.allowedOrigins);
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/speech/stream' || !originAllowed(request.headers.origin, origins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => speech.relay(client));
  });
  return {
    server,
    listen(port = 8787, host = '127.0.0.1') {
      return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); });
    },
    close() {
      speech.close();
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const app = createBackendServer();
  const start = async () => {
    const address = await app.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1');
    console.log(`Voice Companion backend: http://${address.address}:${address.port} (STT: ${process.env.SERVER_STT_PROVIDER ?? 'none'})`);
  };
  start().catch(async (error) => {
    console.error(error instanceof Error ? error.message : 'Backend startup failed.');
    await app.close(); process.exitCode = 1;
  });
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => { void app.close(); });
}
