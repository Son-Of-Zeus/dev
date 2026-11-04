import test from 'node:test';
import assert from 'node:assert/strict';
import { createBasetenPlanner } from '../src/baseten-adapter.js';
import { createReasoner } from '../src/reasoner.js';
import { validateDecisionContext, validateReasonRequest } from '../src/contracts.js';
import { createBackendServer } from '../src/server.js';
import { readSse } from '../src/streaming.js';

const workflow = { readiness: 'ready', requiredInformation: [], knownInformation: [], missingInformation: [] };
const decision = { action: 'guide', targetDescription: 'Settings button', spokenInstruction: 'Open Settings.', language: 'en-IN', workflow };
const record = (sequence = 1, changes = {}) => ({ sequence, decision, precondition: 'Home is visible.', expectedOutcome: 'Settings is visible.', ...changes });
const element = { id: 'el_1', role: 'button', label: 'Settings', visible: true, inViewport: true, disabled: false };
const request = { userUtterance: 'Change the site language', session: { goal: 'Change the site language', recentActions: [] }, page: { origin: 'https://example.test', title: 'Home', elements: [element] } };
function answers(query, changes = {}) {
  return { answers: Object.fromEntries(Object.entries(query.questions).map(([name, question]) => {
    if (question.type === 'noul') return [name, { noul: changes[name] ?? (['exists', 'savedExists', 'nextExists'].includes(name) ? .95 : .05) }];
    const selected = name === 'language' ? 'en-IN' : Object.keys(question.criteria)[0];
    return [name, { choice: selected, probabilities: { [selected]: .95 } }];
  })) };
}
function sse(content, finish = 'stop') {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\r\n\r\n' +
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] }) + '\r\n\r\n' + 'data: [DONE]\r\n\r\n';
}
function response(text, bytewise = false) {
  const data = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (bytewise) for (const byte of data) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(data);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('stream parser handles split UTF-8, CRLF, escaped newlines and multiple steps', async () => {
  let body;
  const first = record(1, { decision: { ...decision, spokenInstruction: 'सेटिंग्स खोलें।\nफिर रुकें।' } });
  const provider = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async (_url, options) => {
    body = JSON.parse(options.body);
    const ignored = 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'not a step', role: 'assistant' } }] }) + '\r\n\r\n';
    return response(ignored + sse(JSON.stringify(first) + '\n' + JSON.stringify(record(2)) + '\n'), true);
  } });
  const records = [];
  for await (const step of provider.stream(request)) records.push(step);
  assert.equal(body.stream, true);
  assert.ok(!JSON.stringify(body.messages).includes('el_1'));
  assert.equal(records.length, 2);
  assert.equal(records[0].decision.spokenInstruction, first.decision.spokenInstruction);
});

test('invalid first records get one repair, committed streams are never replayed', async () => {
  let calls = 0;
  const provider = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => {
    calls++;
    return response(sse(calls === 1 ? '{broken\n' : JSON.stringify(record()) + '\n'));
  } });
  const repaired = [];
  for await (const step of provider.stream(request)) repaired.push(step);
  assert.equal(calls, 2); assert.equal(repaired.length, 1);
  for (const tail of [JSON.stringify(record(1)) + '\n', '{broken\n', 'unfinished']) {
    let attempts = 0;
    const broken = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => { attempts++; return response(sse(JSON.stringify(record()) + '\n' + tail)); } });
    const seen = [];
    await assert.rejects(async () => { for await (const value of broken.stream(request)) seen.push(value); });
    assert.equal(attempts, 1); assert.equal(seen.length, 1);
  }
});

test('oversized and truncated provider frames are rejected', async () => {
  for (const text of ['data: ' + 'x'.repeat(65_537) + '\n\n', 'data: {}']) {
    await assert.rejects(async () => { for await (const _event of readSse(response(text).body)) { /* read */ } });
  }
});

test('Jev selects the first committed step before Muse finishes its next step', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let selected = false;
  let finished = false;
  const updates = [];
  const background = [];
  const reasoner = createReasoner({ planner: { async *stream() {
    yield record();
    await gate;
    yield record(2);
    finished = true;
  } }, client: { systemOne: async (query) => { if (!query.questions.goalComplete) selected = true; return answers(query); } } });
  const action = await reasoner.reason(request, { onPlan: (update) => updates.push(update), onBackground: (promise) => background.push(promise) });
  assert.equal(action.action, 'guide'); assert.equal(selected, true); assert.equal(finished, false);
  assert.equal(action.decisionContext.plan.steps.length, 1);
  release(); await Promise.all(background);
  assert.equal(updates.at(-1).plan.steps.length, 2);
  assert.equal(updates.at(-1).plan.complete, true);
});

test('saved plans advance with one Jev assessment and no Muse call', async () => {
  const step = { targetDescription: 'Settings button', spokenInstruction: 'Open Settings.', language: 'en-IN', precondition: 'Home is visible.', expectedOutcome: 'Settings is visible.' };
  const next = { ...step, targetDescription: 'Language button', spokenInstruction: 'Open Language.' };
  let count = 0;
  const reasoner = createReasoner({ planner: { plan() { throw new Error('Must reuse the plan.'); } }, client: { systemOne: async (query) => {
    count++; assert.ok(query.questions.nextApplicable); assert.ok(query.questions.nextTarget);
    return answers(query, { stepComplete: .95, nextApplicable: .95 });
  } } });
  const input = { ...request, trigger: 'manual-action', session: { ...request.session, decisionContext: { taskStatus: 'active', step: decision, plan: { id: 'plan-test', steps: [step, next], currentStepIndex: 0, complete: true } } } };
  // The compatibility mirror contains semantic fields only.
  input.session.decisionContext.step = { targetDescription: step.targetDescription, spokenInstruction: step.spokenInstruction, language: step.language };
  const action = await reasoner.reason(input);
  assert.equal(count, 1); assert.equal(action.spokenInstruction, next.spokenInstruction);
  assert.equal(action.decisionContext.plan.currentStepIndex, 1);
});

test('persisted input lock cannot be completed by page activity', async () => {
  const reasoner = createReasoner({ planner: { plan() { throw new Error('No planning while input is pending.'); } }, client: { systemOne: async (query) => answers(query, { goalComplete: .99 }) } });
  const result = await reasoner.reason({ ...request, trigger: 'page-change', session: { ...request.session, decisionContext: { taskStatus: 'active', awaitingInputCompletion: true } } });
  assert.equal(result.action, 'wait'); assert.equal(result.decisionContext.awaitingInputCompletion, true);
});

test('plan contracts reject IDs, malformed bounds and unsafe URL components', () => {
  assert.throws(() => validateReasonRequest({ ...request, page: { ...request.page, origin: 'https://example.test/path?token=secret' } }));
  assert.equal(validateReasonRequest(request).page.origin, 'https://example.test');
  assert.throws(() => validateDecisionContext({ taskStatus: 'active', plan: { id: 'p', currentStepIndex: 0, steps: [{ ...decision, targetId: 'el_1' }] } }));
});

test('HTTP stream delivers first guidance before full plan completion', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let finished = false;
  const app = createBackendServer({ allowedOrigins: ['chrome-extension://synthetic'], planner: { async *stream() {
    yield record(); await gate; yield record(2); finished = true;
  } }, client: { systemOne: async (query) => answers(query) } });
  const address = await app.listen(0);
  t.after(async () => { release(); await app.close(); });
  const reply = await fetch('http://127.0.0.1:' + address.port + '/reason/stream', { method: 'POST', headers: { origin: 'chrome-extension://synthetic', 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(reply.headers.get('content-type'), 'text/event-stream');
  let guided = false;
  for await (const data of readSse(reply.body)) {
    const event = JSON.parse(data);
    if (event.type === 'action') { assert.equal(finished, false); guided = true; release(); }
  }
  assert.equal(guided, true); assert.equal(finished, true);
});

test('a failed tail reports an incomplete plan without failing issued guidance', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const updates = []; const background = [];
  const reasoner = createReasoner({ planner: { async *stream() { yield record(); await gate; throw new Error('Synthetic tail failure'); } }, client: { systemOne: async (query) => answers(query) } });
  const action = await reasoner.reason(request, { onPlan: (update) => updates.push(update), onBackground: (promise) => background.push(promise) });
  assert.equal(action.action, 'guide');
  release(); await Promise.all(background);
  assert.equal(updates.at(-1).failed, true);
  assert.equal(action.decisionContext.plan.steps.length, 1);
});

test('a first-record failure is returned as an error, not an empty plan', async () => {
  const reasoner = createReasoner({ planner: { async *stream() { throw new Error('Synthetic stream failure'); } }, client: { systemOne: async (query) => answers(query) } });
  await assert.rejects(reasoner.reason(request, { onPlan() {}, onBackground() {} }), /Synthetic stream failure/);
});

test('Stop aborts a provider retry delay before another request is sent', async () => {
  const controller = new AbortController();
  let calls = 0;
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => {
    calls++; queueMicrotask(() => controller.abort(new Error('Stopped')));
    return new Response('{}', { status: 503, headers: { 'retry-after': '3' } });
  } });
  await assert.rejects(async () => { for await (const _step of planner.stream(request, controller.signal)) { /* consume */ } }, /Stopped/);
  assert.equal(calls, 1);
});

for (const selectionFails of [false, true]) test(selectionFails ? 'a selection error closes and aborts the remaining Muse tail' : 'closing the client stream aborts the remaining Muse tail', async (t) => {
  let stopped;
  const aborted = new Promise((resolve) => { stopped = resolve; });
  const app = createBackendServer({ allowedOrigins: ['chrome-extension://synthetic'], planner: { async *stream(_request, signal) {
    yield record();
    await new Promise((resolve) => signal.addEventListener('abort', () => { stopped(); resolve(); }, { once: true }));
    signal.throwIfAborted();
  } }, client: { systemOne: async (query) => {
    if (selectionFails && !query.questions.goalComplete) throw new Error('Synthetic selection failure');
    return answers(query);
  } } });
  const address = await app.listen(0);
  t.after(() => app.close());
  const reply = await fetch('http://127.0.0.1:' + address.port + '/reason/stream', { method: 'POST', headers: { origin: 'chrome-extension://synthetic', 'content-type': 'application/json' }, body: JSON.stringify(request) });
  let received = false;
  for await (const data of readSse(reply.body)) {
    const event = JSON.parse(data);
    if (event.type === (selectionFails ? 'error' : 'action')) { received = true; break; }
  }
  assert.equal(received, true);
  let timer;
  try { await Promise.race([aborted, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Muse tail was not cancelled.')), 1000); })]); }
  finally { clearTimeout(timer); }
});

test('accepts a complete last step without a final newline after normal provider completion', async () => {
  let calls = 0;
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => {
    calls++; return response(sse(JSON.stringify(record())));
  } });
  const records = [];
  for await (const value of planner.stream(request)) records.push(value);
  assert.equal(records.length, 1);
  assert.equal(calls, 1);
});

test('accepts a complete final queued step without a newline', async () => {
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => response(sse(JSON.stringify(record()) + '\n' + JSON.stringify(record(2)))) });
  const records = [];
  for await (const value of planner.stream(request)) records.push(value);
  assert.equal(records.length, 2);
});

test('a terminal explanation does not require unused action-only evidence fields', async () => {
  const explanation = { action: 'explain', targetDescription: null, spokenInstruction: 'Open the Metrics tab to view backend request counts.', language: 'en-IN', workflow: { ...workflow, readiness: 'not_applicable' } };
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => response(sse(JSON.stringify({ sequence: 1, decision: explanation }))) });
  const records = [];
  for await (const value of planner.stream(request)) records.push(value);
  assert.equal(records[0].decision.action, 'explain');
  assert.equal(records[0].decision.spokenInstruction, explanation.spokenInstruction);
});

test('accepts a pretty-printed complete record without changing its decision', async () => {
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => response(sse(JSON.stringify(record(), null, 2) + '\n')) });
  const records = [];
  for await (const value of planner.stream(request)) records.push(value);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision.targetDescription, decision.targetDescription);
});

test('metrics explanation passes through streaming reasoning without target selection', async () => {
  const explanation = { action: 'explain', targetDescription: null, spokenInstruction: 'Open Metrics to view backend request counts.', language: 'en-IN', workflow: { ...workflow, readiness: 'not_applicable' } };
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => response(sse(JSON.stringify({ sequence: 1, decision: explanation }, null, 2)), true) });
  let assessments = 0;
  const reasoner = createReasoner({ planner, client: { systemOne: async (query) => {
    assessments++;
    assert.ok(query.questions.goalComplete);
    return answers(query, { explanation: .95 });
  } } });
  const background = [];
  const action = await reasoner.reason({ ...request, userUtterance: 'How do I see the metrics for my voice companion backend?' }, { onPlan() { assert.fail('An explanation must not create an action queue.'); }, onBackground: (promise) => background.push(promise) });
  await Promise.all(background);
  assert.equal(action.action, 'explain');
  assert.equal(action.spokenInstruction, explanation.spokenInstruction);
  assert.equal(assessments, 1);
  assert.equal(action.targetId, undefined);
  assert.equal(action.decisionContext.plan, undefined);
});

test('guide evidence remains required and repair reports only a structural reason', async () => {
  let calls = 0;
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async (_url, options) => {
    calls++;
    if (calls === 2) {
      const message = JSON.parse(options.body).messages.at(-1).content;
      assert.match(message, /step_evidence/);
      assert.ok(!message.includes('Settings button'));
    }
    return response(sse(JSON.stringify({ sequence: 1, decision })));
  } });
  await assert.rejects(async () => { for await (const _step of planner.stream(request)) { assert.fail('Invalid guide was committed.'); } }, (error) => error.code === 'PLANNER_INVALID_RESPONSE' && error.cause.reason === 'step_evidence');
  assert.equal(calls, 2);
});

test('a terminal reply rejects further records without replay', async () => {
  const explanation = { action: 'explain', targetDescription: null, spokenInstruction: 'Metrics shows request counts.', language: 'en-IN', workflow: { ...workflow, readiness: 'not_applicable' } };
  let calls = 0;
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => {
    calls++;
    return response(sse(JSON.stringify({ sequence: 1, decision: explanation }) + '\n' + JSON.stringify(record(2))));
  } });
  const seen = [];
  await assert.rejects(async () => { for await (const value of planner.stream(request)) seen.push(value); }, (error) => error.cause.reason === 'step_sequence');
  assert.equal(seen.length, 1);
  assert.equal(calls, 1);
});

test('opt-in Muse diagnostics capture the rejected record and its exact field', async () => {
  for (const enabled of [false, true]) {
    const reports = [];
    const failing = record(1, { precondition: 'function run() {}' });
    const planner = createBasetenPlanner({ apiKey: 'synthetic', debugResponses: enabled, onRejectedPlan: (value) => reports.push(value), fetcher: async () => response(sse(JSON.stringify(failing))) });
    await assert.rejects(async () => { for await (const _step of planner.stream(request)) assert.fail('Invalid guide committed.'); });
    assert.equal(reports.length, enabled ? 2 : 0);
    if (enabled) {
      assert.equal(reports[0].failure.field, 'precondition');
      assert.equal(reports[0].failure.rule, 'executable_content');
      assert.equal(reports[0].response.precondition.text, failing.precondition);
      assert.equal(reports[1].attempt, 2);
    }
  }
});

test('the captured metrics response passes validation and still uses Jev selection', async () => {
  const captured = record(1, {
    decision: { ...decision, targetDescription: 'Metrics tab in the function header navigation next to Function Calls', spokenInstruction: 'Tap the Metrics tab to see the backend metrics.' },
    precondition: 'The voice-companion backend function page is open with Function Calls selected.',
    expectedOutcome: 'The Metrics view will open showing charts for invocations, latency and errors.',
  });
  const input = { ...request, userUtterance: 'How do I see the metrics for my voice companion backend?', page: { ...request.page, elements: [{ ...element, id: 'synthetic_metrics', role: 'tab', label: 'Metrics' }] } };
  let selections = 0;
  const planner = createBasetenPlanner({ apiKey: 'synthetic', fetcher: async () => response(sse(JSON.stringify(captured))) });
  const reasoner = createReasoner({ planner, client: { systemOne: async (query) => {
    if (!query.questions.goalComplete) { selections++; assert.equal(query.state.targetDescription, captured.decision.targetDescription); }
    return answers(query);
  } } });
  const background = [];
  const action = await reasoner.reason(input, { onPlan() {}, onBackground: (promise) => background.push(promise) });
  await Promise.all(background);
  assert.equal(selections, 1);
  assert.equal(action.action, 'guide');
  assert.equal(action.targetId, 'synthetic_metrics');
  assert.equal(action.decisionContext.plan.steps[0].precondition, captured.precondition);
});

test('semantic instructions permit ordinary prose but reject executable syntax', () => {
  for (const text of ['Metrics tab in the function header', 'The backend function page is open.', 'Let me see the metrics.', 'Function Calls is selected.']) {
    assert.equal(validateDecisionContext({ taskStatus: 'active', step: { targetDescription: text, spokenInstruction: text, language: 'en-IN' } }).step.spokenInstruction, text);
  }
  for (const text of ['function run() {}', 'function () {}', 'function* run() {}', 'const x = 1;', 'let x;', 'var x, y;', 'const {x} = data;', 'let [x] = data;', '() => run()', 'javascript:run()', '<script>run()</script>', '```js']) {
    assert.throws(() => validateDecisionContext({ taskStatus: 'active', step: { targetDescription: text, spokenInstruction: text, language: 'en-IN' } }));
  }
});
