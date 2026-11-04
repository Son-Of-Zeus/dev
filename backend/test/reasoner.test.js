import test from 'node:test';
import assert from 'node:assert/strict';
import { createBasetenPlanner, DEFAULT_MODEL } from '../src/baseten-adapter.js';
import { createReasoner, MissingTargetError } from '../src/reasoner.js';
import { buildTargetQuestions, readTargetAnswer } from '../src/target-questions.js';
import { validateReasonRequest, validatePlanDecision } from '../src/contracts.js';

export const workflow = { intent: 'search catalog', requiredInformation: [], knownInformation: [], missingInformation: [], readiness: 'ready' };
export const plan = { action: 'guide', targetDescription: 'The catalog search field', spokenInstruction: 'Enter a search term. Say I am done when finished.', language: 'en-IN', workflow };
export const request = { userUtterance: 'Help me search the catalog', session: { recentActions: [] }, page: { title: 'Catalog', elements: [{ id: 'el_1', role: 'textbox', label: 'Search', section: 'Catalog', visible: true, inViewport: true, disabled: false }] } };
function completion(value, finish = 'stop') { return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: typeof value === 'string' ? value : JSON.stringify(value), reasoning_content: 'private reasoning' } }] })); }
function jevAnswer(query, exists = .9, probability = .9) {
  const selected = Object.keys(query.questions.target?.criteria ?? {})[0];
  const answers = Object.fromEntries(Object.entries(query.questions).filter(([, question]) => question.type === 'noul').map(([name]) => [name, { noul: .1 }]));
  return { answers: { ...answers, language: { choice: 'en-IN' }, target: { choice: selected, probabilities: { [selected]: probability } }, exists: { noul: exists } } };
}

test('Baseten sends the exact model and low effort without IDs or secrets in state', async () => {
  let payload;
  const planner = createBasetenPlanner({ apiKey: 'test-key', fetcher: async (url, options) => {
    assert.equal(url, 'https://inference.baseten.co/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer test-key');
    payload = JSON.parse(options.body); return completion(plan);
  } });
  assert.equal((await planner.plan(request)).action, 'guide');
  assert.equal(payload.model, DEFAULT_MODEL);
  assert.equal(payload.reasoning_effort, 'low');
  assert.ok(!payload.messages[1].content.includes('el_1'));
  assert.ok(!payload.response_format);
});
test('Baseten repairs invalid plans once and rejects invalid/truncated second output', async () => {
  let calls = 0;
  const planner = createBasetenPlanner({ apiKey: 'test', fetcher: async () => completion(++calls === 1 ? '{broken' : plan) });
  assert.equal((await planner.plan(request)).action, 'guide'); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(createBasetenPlanner({ apiKey: 'test', fetcher: async () => { calls++; return completion(plan, 'length'); } }).plan(request), /after repair/);
  assert.equal(calls, 2);
});
test('Baseten retries transport and transient failures but not permanent rejections', async () => {
  let calls = 0;
  const waits = [];
  const planner = createBasetenPlanner({ apiKey: 'test', wait: async (ms) => waits.push(ms), fetcher: async () => {
    calls++; if (calls === 1) throw new Error('network'); if (calls === 2) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } }); return completion(plan);
  } });
  await planner.plan(request); assert.equal(calls, 3); assert.deepEqual(waits, [250, 1000]);
  calls = 0;
  await assert.rejects(createBasetenPlanner({ apiKey: 'test', fetcher: async () => { calls++; return new Response('{}', { status: 404 }); } }).plan(request), /404/);
  assert.equal(calls, 1);
});
test('planner contracts reject IDs, missing readiness and malformed clarification', () => {
  assert.throws(() => validatePlanDecision({ ...plan, targetId: 'el_1' }), /unexpected/);
  assert.throws(() => validatePlanDecision({ ...plan, workflow: undefined }));
  assert.throws(() => validatePlanDecision({ ...plan, language: 'fr-FR' }));
  assert.throws(() => validatePlanDecision({ ...plan, action: 'clarify' }));
});
test('Jev alone chooses the registered target using bundled Choice and Noul', async () => {
  let query;
  const timings = [];
  const reasoner = createReasoner({ planner: { plan: async () => plan }, client: { systemOne: async (input) => { query = input; return jevAnswer(input); } } });
  const action = await reasoner.reason(request, { onTiming: (stage) => timings.push(stage) });
  assert.equal(query.model, 'jev-1.14.0');
  assert.equal(query.questions.exists.type, 'noul');
  assert.equal(query.questions.target.type, 'choice');
  assert.deepEqual(timings, ['assessment', 'planning', 'selection']);
  assert.equal(action.targetId, 'el_1'); assert.equal(action.expectedUserAction, 'input');
});
test('Jev missing, uncertain, threshold edges and invalid IDs have distinct outcomes', async () => {
  const query = buildTargetQuestions('Search', request.page.elements);
  const read = (e, p) => readTargetAnswer(jevAnswer(query, e, p).answers, query.ids);
  assert.equal(read(.3, .99).status, 'missing');
  assert.equal(read(.5, .99).status, 'uncertain');
  assert.equal(read(.99, .69).status, 'uncertain');
  assert.equal(read(.7, .7).status, 'selected');
  assert.throws(() => readTargetAnswer({ exists: { noul: .99 }, target: { choice: 'invented', probabilities: { invented: 1 } } }, query.ids), /invalid/);
  for (const [e, p, expected] of [[.1, .99, 'missing'], [.5, .99, 'clarify']]) {
    const reasoner = createReasoner({ planner: { plan: async () => plan }, client: { systemOne: async (input) => jevAnswer(input, e, p) } });
    if (expected === 'missing') await assert.rejects(reasoner.reason(request), MissingTargetError);
    else assert.equal((await reasoner.reason(request)).action, 'clarify');
  }
});
test('Jev failures are errors and targetless plans skip selection', async () => {
  let calls = 0;
  const client = { systemOne: async () => { calls++; throw new Error('Provider failed'); } };
  await assert.rejects(createReasoner({ planner: { plan: async () => plan }, client }).reason(request), (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.provider === 'Jev');
  assert.equal(calls, 1);
  const explain = { ...plan, action: 'explain', targetDescription: undefined };
  const assessmentClient = { systemOne: async (query) => { calls++; assert.ok(query.questions.goalComplete); return jevAnswer(query); } };
  assert.equal((await createReasoner({ planner: { plan: async () => explain }, client: assessmentClient }).reason(request)).action, 'explain');
  assert.equal(calls, 2);
});
test('consequential controls require a consequence after Jev selection', async () => {
  const input = { ...request, page: { elements: [{ ...request.page.elements[0], role: 'button', label: 'Delete project' }] } };
  const client = { systemOne: async (query) => jevAnswer(query) };
  await assert.rejects(createReasoner({ planner: { plan: async () => ({ ...plan, targetDescription: 'Delete project' }) }, client }).reason(input), /consequence/);
});
test('request validation rejects raw DOM fields, over 1000 candidates and duplicate IDs', () => {
  assert.throws(() => validateReasonRequest({ ...request, html: '<html>' }), /unexpected/);
  assert.throws(() => validateReasonRequest({ ...request, page: { elements: Array(1001).fill(request.page.elements[0]) } }), /maximum/);
  assert.equal(validateReasonRequest({ ...request, page: { elements: Array.from({length:1000}, (_, i) => ({ ...request.page.elements[0], id: `el_${i}` })) } }).page.elements.length, 1000);
});
