import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createBackendServer } from '../src/server.js';
import { MissingTargetError } from '../src/reasoner.js';

const origin = 'chrome-extension://synthetic-extension';
const request = { userUtterance: 'Help me search', session: { recentActions: [] }, page: { elements: [{ id: 'el_1', role: 'button', label: 'Search', visible: true, inViewport: true, disabled: false }] } };

test('HTTP boundary validates origins, paths, bodies and response timing', async (t) => {
  let calls = 0;
  const app = createBackendServer({ allowedOrigins: origin, reasoner: { reason: async (_request, options) => { calls++; options.onTiming('planning', 12); options.onTiming('selection', 3); return { action: 'wait' }; } } });
  const address = await app.listen(0); t.after(() => app.close());
  const url = `http://127.0.0.1:${address.port}`;
  const post = (body, headers = { origin }) => fetch(url + '/reason', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const health = await fetch(url + '/health');
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ok' });
  let response = await post(request);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { action: 'wait' });
  assert.match(response.headers.get('server-timing'), /planning;dur=12/);
  assert.equal((await post(request, { origin: 'https://unapproved.example' })).status, 403);
  assert.equal((await post(request, {})).status, 403);
  assert.equal((await post({ ...request, rawHtml: '<html>' })).status, 400);
  assert.equal((await post({ ...request, page: { elements: Array(1001).fill(request.page.elements[0]) } })).status, 400);
  assert.equal((await post({ userUtterance: 'a'.repeat(512 * 1024 + 1) })).status, 413);
  assert.equal((await fetch(url + '/speech/transcribe', { method: 'POST', headers: { origin } })).status, 404);
  assert.equal((await fetch(url + '/speech/synthesize', { method: 'POST', headers: { origin } })).status, 404);
  assert.equal((await fetch(url + '/reason', { method: 'OPTIONS', headers: { origin } })).status, 204);
  assert.equal(calls, 1);
});
test('missing targets are distinct from provider failure', async (t) => {
  let missing = true;
  const app = createBackendServer({ allowedOrigins: origin, reasoner: { reason: async () => { if (missing) throw new MissingTargetError(); throw new Error('private request content'); } } });
  const address = await app.listen(0); t.after(() => app.close());
  const post = () => fetch(`http://127.0.0.1:${address.port}/reason`, { method: 'POST', headers: { origin }, body: JSON.stringify(request) });
  let response = await post(); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'TARGET_NOT_FOUND');
  missing = false; response = await post(); assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('private request content'));
});
test('WebSocket upgrades require the exact extension origin and streaming path', async (t) => {
  let calls = 0;
  const app = createBackendServer({ allowedOrigins: origin, reasoner: {}, relay: (client) => { calls++; client.send(JSON.stringify({ type: 'ready' })); client.on('error', () => {}); } });
  const address = await app.listen(0); t.after(() => app.close());
  const base = `ws://127.0.0.1:${address.port}`;
  const allowed = new WebSocket(base + '/speech/stream', { origin });
  const event = await new Promise((resolve, reject) => { allowed.on('message', (data) => resolve(JSON.parse(String(data)))); allowed.on('error', reject); });
  assert.equal(event.type, 'ready'); allowed.close();
  for (const [path, source] of [['/speech/stream', 'https://wrong.example'], ['/other', origin]]) {
    const blocked = new WebSocket(base + path, { origin: source });
    await new Promise((resolve) => { blocked.on('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 403); response.resume(); blocked.terminate(); resolve(); }); blocked.on('error', () => resolve()); });
  }
  assert.equal(calls, 1);
});

test('Jev completion passes decision context and diagnostics through the HTTP boundary', async (t) => {
  const app = createBackendServer({
    allowedOrigins: origin,
    planner: { plan: async () => { throw new Error('Muse must not be called'); } },
    client: { systemOne: async (query) => ({ answers: Object.fromEntries(Object.entries(query.questions).map(([name, question]) => [name,
      question.type === 'noul' ? { noul: name === 'goalComplete' ? .95 : .05 } :
        { choice: name === 'language' ? 'en-IN' : Object.keys(question.criteria)[0] },
    ])) }) },
  });
  const address = await app.listen(0); t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${address.port}/reason`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, trigger: 'page-change', session: { goal: 'Open settings', recentActions: [], decisionContext: { taskStatus: 'active' } }, page: { title: 'Settings', elements: [], evidence: [{ kind: 'heading', text: 'Settings' }] } }),
  });
  assert.equal(response.status, 200);
  const action = await response.json();
  assert.equal(action.action, 'success'); assert.equal(action.decisionContext.taskStatus, 'completed');
  assert.deepEqual(JSON.parse(response.headers.get('x-reasoning-decision')), { museCalls: 0, escalationReason: 'none' });
  assert.match(response.headers.get('server-timing'), /assessment;dur=/);
  assert.match(response.headers.get('access-control-expose-headers'), /x-reasoning-decision/);
});

test('speech status is origin restricted and makes no provider calls', async (t) => {
  const app = createBackendServer({ allowedOrigins: origin, sttProvider: 'meta', speech: { apiKey: 'synthetic-key' }, reasoner: { reason: () => { throw new Error('No model calls'); } } });
  const address = await app.listen(0); t.after(() => app.close());
  const url = `http://127.0.0.1:${address.port}/speech/status`;
  for (const method of ['GET', 'POST']) {
    const options = method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method };
    assert.equal((await fetch(url, options)).status, 403);
    assert.equal((await fetch(url, { ...options, headers: { ...options.headers, origin: 'https://synthetic-unapproved.example' } })).status, 403);
    const response = await fetch(url, { ...options, headers: { ...options.headers, origin } });
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.available, true);
    assert.ok(!JSON.stringify(result).includes('synthetic-key'));
  }
});
