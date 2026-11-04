import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasoner } from '../src/reasoner.js';
import { buildAssessmentQuestions, readAssessment } from '../src/assessment-questions.js';
import { PLANNER_PROMPT } from '../src/baseten-adapter.js';
import { validateDecisionContext, validateReasonRequest } from '../src/contracts.js';

const button = { id: 'el_1', role: 'button', label: 'Settings', visible: true, inViewport: true, disabled: false };
const workflow = { requiredInformation: [], knownInformation: [], missingInformation: [], readiness: 'ready' };
const step = { targetDescription: 'Settings button', spokenInstruction: 'Open settings.', language: 'en-IN' };
const request = { userUtterance: 'Open settings', trigger: 'user', session: { goal: 'Open settings', recentActions: [] }, page: { title: 'Home', elements: [button] } };
const plan = { action: 'guide', ...step, workflow };
function answer(query, changes = {}) {
  const answers = {};
  for (const [name, question] of Object.entries(query.questions)) {
    if (question.type === 'noul') answers[name] = { noul: name === 'exists' || name === 'savedExists' ? .95 : .05 };
    if (question.type === 'choice') {
      const selected = name === 'language' ? 'en-IN' : Object.keys(question.criteria)[0];
      answers[name] = { choice: selected, probabilities: { [selected]: .95 } };
    }
  }
  for (const [name, value] of Object.entries(changes)) answers[name] = typeof value === 'number' ? { noul: value } : value;
  return { answers };
}
function harness(changes = {}, musePlan = plan) {
  const calls = { muse: 0, jev: 0, decisions: [], queries: [] };
  const reasoner = createReasoner({
    planner: { plan: async (input) => { calls.muse++; calls.planningRequest = input; return musePlan; } },
    client: { systemOne: async (query) => { calls.jev++; calls.queries.push(query); return answer(query, query.questions.goalComplete ? changes : {}); } },
  });
  return { calls, reason: (input = request) => reasoner.reason(input, { onDecision: (decision) => calls.decisions.push(decision) }) };
}

test('short speech prompt removes routine narration while retaining consequence and input instructions', () => {
  assert.match(PLANNER_PROMPT, /under 15 words/);
  assert.match(PLANNER_PROMPT, /under 40 words/);
  assert.match(PLANNER_PROMPT, /do not repeat it/);
  assert.match(PLANNER_PROMPT, /say "done"/);
  assert.match(PLANNER_PROMPT, /Never report success yourself/);
});
test('one bundled Jev call guides a clear request without Muse', async () => {
  const h = harness({ direct: .95 });
  const action = await h.reason();
  assert.equal(h.calls.muse, 0); assert.equal(h.calls.jev, 1);
  assert.equal(action.targetId, button.id); assert.equal(action.spokenInstruction, 'Click Settings.');
  assert.equal(action.decisionContext.taskStatus, 'active');
  assert.ok(!JSON.stringify(action.decisionContext).includes(button.id));
  assert.deepEqual(h.calls.decisions, [{ museCalls: 0, escalationReason: 'none' }]);
  assert.equal(h.calls.queries[0].questions.exists.type, 'noul');
  assert.equal(h.calls.queries[0].questions.target.type, 'choice');
});
test('routine input and selection use brief English and Hindi templates', async () => {
  for (const language of ['en-IN', 'hi-IN']) {
    for (const role of ['textbox', 'combobox']) {
      const h = harness({ direct: .95, language: { choice: language } });
      const result = await h.reason({ ...request, page: { elements: [{ ...button, role, label: 'Search' }] } });
      assert.equal(h.calls.muse, 0);
      assert.equal(result.expectedUserAction, role === 'textbox' ? 'input' : 'select');
      if (role === 'textbox') assert.match(result.spokenInstruction, language === 'hi-IN' ? /हो गया/ : /done/);
    }
  }
});
test('page proof completes once without Muse, at the completion threshold', async () => {
  const h = harness({ goalComplete: .9, blockingError: .3 });
  const result = await h.reason({ ...request, trigger: 'page-change', page: { ...request.page, evidence: [{ kind: 'heading', text: 'Settings' }] } });
  assert.equal(h.calls.muse, 0); assert.equal(result.action, 'success');
  assert.equal(result.spokenInstruction, 'Task complete.'); assert.equal(result.decisionContext.taskStatus, 'completed');
});
test('unproven, unrelated, intermediate and contradictory outcomes never complete', async () => {
  for (const [completion, error, page] of [
    [.89, .05, request.page], [.05, .05, { ...request.page, status: 'Newsletter subscribed' }],
    [.99, .31, { ...request.page, status: 'Failed' }], [.99, .05, { elements: [] }],
  ]) {
    const h = harness({ goalComplete: completion, blockingError: error }, { action: 'wait', language: 'en-IN', workflow });
    const result = await h.reason({ ...request, trigger: 'manual-action', session: { ...request.session, recentActions: [{ type: 'click', label: 'Submit' }] }, page });
    assert.notEqual(result.action, 'success');
  }
});
test('an input remains pending for English and Hindi unfinished utterances', async () => {
  for (const utterance of ['Not done', 'अभी नहीं, पूरा नहीं हो गया']) {
    const h = harness({ goalComplete: .99, inputComplete: .1 });
    const result = await h.reason({ ...request, userUtterance: utterance, session: { ...request.session, pendingAction: { type: 'input', targetLabel: 'Name' } } });
    assert.equal(result.action, 'wait'); assert.equal(h.calls.muse, 0);
  }
});
test('explicit input completion unlocks planning without completing the whole task', async () => {
  for (const utterance of ['Done', 'भर दिया, हो गया']) {
    const h = harness({ inputComplete: .95, goalComplete: .99 });
    const result = await h.reason({ ...request, userUtterance: utterance, session: { ...request.session, pendingAction: { type: 'input', targetLabel: 'Name' } } });
    assert.equal(result.action, 'guide'); assert.equal(result.decisionContext.inputComplete, true);
    assert.equal(h.calls.planningRequest.session.pendingAction, undefined); assert.equal(h.calls.muse, 1);
  }
});
test('pending input questions can use Muse without confirming entry', async () => {
  const h = harness({ explanation: .95 }, { action: 'explain', spokenInstruction: 'Use your full name.', language: 'en-IN', workflow });
  const result = await h.reason({ ...request, userUtterance: 'What does this mean?', session: { ...request.session, pendingAction: { type: 'input', targetLabel: 'Name' } } });
  assert.equal(result.action, 'explain'); assert.equal(result.decisionContext.inputComplete, undefined);
  assert.equal(h.calls.decisions[0].escalationReason, 'explanation');
});
test('pending manual steps and unchanged loading state do not call Muse', async () => {
  for (const pendingAction of [undefined, { type: 'click', targetLabel: 'Settings' }]) {
    const h = harness();
    const result = await h.reason({ ...request, trigger: 'page-change', session: { ...request.session, pendingAction } });
    assert.equal(result.action, 'wait'); assert.equal(h.calls.muse, 0);
  }
});
test('Jev reuses an unfinished semantic step and still selects a live registry target', async () => {
  const h = harness({ reuseStep: .95 });
  const result = await h.reason({ ...request, trigger: 'resume', session: { ...request.session, decisionContext: { taskStatus: 'active', step } } });
  assert.equal(result.action, 'guide'); assert.equal(result.spokenInstruction, step.spokenInstruction);
  assert.equal(h.calls.muse, 0); assert.equal(h.calls.jev, 1);
});
test('new steps and explanations each call Muse once with a diagnostic reason', async () => {
  for (const [changes, trigger, reason] of [[{}, 'user', 'new-step'], [{ nextStepVisible: .95 }, 'page-change', 'new-step'], [{ explanation: .95 }, 'user', 'explanation']]) {
    const h = harness(changes);
    await h.reason({ ...request, trigger });
    assert.equal(h.calls.muse, 1); assert.equal(h.calls.decisions[0].escalationReason, reason);
  }
});
test('new consequences need Muse, saved consequences can be reused', async () => {
  const submitStep = { ...step, targetDescription: 'Submit button', consequence: 'This sends the request.' };
  const input = { ...request, page: { ...request.page, elements: [{ ...button, label: 'Submit' }] } };
  const h = harness({ direct: .95 }, { ...plan, ...submitStep });
  assert.equal((await h.reason(input)).consequence, submitStep.consequence);
  assert.equal(h.calls.muse, 1); assert.equal(h.calls.decisions[0].escalationReason, 'consequence');
  const reuse = harness({ reuseStep: .95 });
  assert.equal((await reuse.reason({ ...input, trigger: 'resume', session: { ...input.session, decisionContext: { taskStatus: 'active', step: submitStep } } })).consequence, submitStep.consequence);
  assert.equal(reuse.calls.muse, 0);
});
test('uncertain direct target asks a short question without Muse', async () => {
  const query = buildAssessmentQuestions(request, request.page.elements);
  const selected = Object.keys(query.questions.target.criteria)[0];
  const h = harness({ direct: .95, target: { choice: selected, probabilities: { [selected]: .69 } } });
  assert.equal((await h.reason()).action, 'clarify'); assert.equal(h.calls.muse, 0);
});
test('Muse success cannot bypass Jev or ask the user to decide completion', async () => {
  const h = harness({}, { action: 'success', spokenInstruction: 'Done.', language: 'en-IN', workflow });
  const action = await h.reason();
  assert.equal(action.action, 'wait');
  assert.equal(action.decisionContext.awaitingConfirmation, undefined);
});
test('uncertain completion waits for evidence and Jev alone confirms the result', async () => {
  const changes = { goalComplete: .6 };
  const h = harness(changes);
  const first = await h.reason({ ...request, trigger: 'page-change' });
  assert.equal(first.action, 'wait'); assert.equal(h.calls.muse, 0);
  assert.equal(first.decisionContext.awaitingConfirmation, undefined);
  const query = h.calls.queries[0];
  assert.equal(query.questions.endpoint, undefined);
  assert.equal(query.questions.confirmed, undefined);
  changes.goalComplete = .95;
  const next = { ...request, trigger: 'page-change', session: { ...request.session, decisionContext: first.decisionContext }, page: { ...request.page, evidence: [{ kind: 'status', text: 'Selected tab: Settings' }] } };
  assert.equal((await h.reason(next)).action, 'success');
  assert.equal(h.calls.muse, 0);
});
test('a distinct goal replaces pending input and old semantic context', async () => {
  const h = harness({ newTask: .95, direct: .95 });
  const result = await h.reason({ ...request, userUtterance: 'Open settings', session: { goal: 'Enter a name', recentActions: [], pendingAction: { type: 'input', targetLabel: 'Name' }, decisionContext: { taskStatus: 'active', step: { ...step, targetDescription: 'Name field' } } } });
  assert.equal(result.action, 'guide'); assert.equal(result.decisionContext.goal, 'Open settings'); assert.equal(h.calls.muse, 0);
});
test('invalid or failed Jev calls surface errors without a Muse fallback', async () => {
  const query = buildAssessmentQuestions(request, request.page.elements);
  for (const value of [undefined, NaN, -1, 1.1]) {
    const answers = answer(query).answers;
    answers.goalComplete = { noul: value };
    assert.throws(() => readAssessment(answers, false), /invalid/);
  }
  let calls = 0;
  const h = createReasoner({ planner: { plan: async () => { calls++; return plan; } }, client: { systemOne: async () => { throw new Error('Provider failed'); } } });
  await assert.rejects(h.reason(request), (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.provider === 'Jev'); assert.equal(calls, 0);
});
test('contracts reject IDs, raw fields and invalid evidence in decision memory', () => {
  assert.throws(() => validateDecisionContext({ taskStatus: 'active', step: { ...step, targetId: 'el_1' } }), /unexpected/);
  assert.throws(() => validateDecisionContext({ taskStatus: 'complete' }), /status/);
  assert.throws(() => validateReasonRequest({ ...request, trigger: 'typing' }), /trigger/);
  assert.throws(() => validateReasonRequest({ ...request, page: { ...request.page, evidence: [{ kind: 'text', text: 'A', html: '<p>' }] } }), /unexpected/);
  assert.throws(() => validateReasonRequest({ ...request, page: { ...request.page, evidence: Array(13).fill({ kind: 'text', text: 'A' }) } }), /evidence/);
});

test('an explanation cannot cause Muse to advance an unfinished input', async () => {
  const h = harness({ explanation: .95 });
  const result = await h.reason({ ...request, userUtterance: 'How do I fill this?', session: { ...request.session, pendingAction: { type: 'input', targetLabel: 'Name' } } });
  assert.equal(result.action, 'wait');
  assert.equal(result.decisionContext.inputComplete, undefined);
});

test('automatic checks never replay the previous direct speech command', async () => {
  const h = harness({ direct: .99 });
  const result = await h.reason({ ...request, trigger: 'page-change' });
  assert.equal(result.action, 'wait'); assert.equal(h.calls.muse, 0);
});

test('completed text entry cannot reuse the old input instruction', async () => {
  const h = harness({ inputComplete: .95, reuseStep: .95 });
  const result = await h.reason({ ...request, userUtterance: 'Done', session: { ...request.session, pendingAction: { type: 'input', targetLabel: 'Name' }, decisionContext: { taskStatus: 'active', step: { ...step, targetDescription: 'Name field', spokenInstruction: 'Enter your name.' } } } });
  assert.equal(h.calls.muse, 1); assert.equal(result.spokenInstruction, plan.spokenInstruction);
});

test('legacy confirmation memory is discarded and cannot bypass page proof', async () => {
  const context = { taskStatus: 'active', awaitingConfirmation: true };
  assert.equal(validateDecisionContext(context).awaitingConfirmation, undefined);
  assert.throws(() => validateDecisionContext({ ...context, awaitingConfirmation: 'yes' }));
  const h = harness({ goalComplete: .05, confirmed: .99 }, { action: 'wait', language: 'en-IN', workflow });
  const result = await h.reason({ ...request, userUtterance: 'Yes, the task is complete', session: { ...request.session, decisionContext: context } });
  assert.equal(result.action, 'wait');
  assert.equal(result.decisionContext.awaitingConfirmation, undefined);
});

test('an unfinished task can get a new plan without a completion question', async () => {
  const h = harness({ goalComplete: .6 });
  const result = await h.reason({ ...request, userUtterance: 'It is still unfinished', session: { ...request.session, decisionContext: { taskStatus: 'active', awaitingConfirmation: true } } });
  assert.equal(result.action, 'guide'); assert.equal(h.calls.muse, 1);
  assert.equal(result.decisionContext.awaitingConfirmation, undefined);
});

test('Jev assesses completion with the existing ordered action history in the same request', async () => {
  const recentActions = [{ type: 'click', label: 'Functions' }, { type: 'click', label: 'backend' }, { type: 'click', label: 'Metrics' }];
  const h = harness({ goalComplete: .95 });
  const result = await h.reason({ ...request, trigger: 'manual-action', session: { goal: 'View backend metrics', recentActions }, page: { ...request.page, status: 'Selected tab: Metrics' } });
  assert.equal(result.action, 'success');
  assert.equal(h.calls.jev, 1);
  assert.equal(h.calls.muse, 0);
  const query = h.calls.queries[0];
  assert.deepEqual(query.state.session.recentActions, recentActions);
  assert.equal(query.state.session.goal, 'View backend metrics');
  assert.match(JSON.stringify(query.questions.goalComplete), /session.recentActions/);
  assert.match(JSON.stringify(query.questions.requestComplete), /session.recentActions/);
  assert.match(query.state.evidencePolicy, /chronological history/);
});

test('a performed submission remains history and cannot override a failed result', async () => {
  const h = harness({ goalComplete: .99, blockingError: .95 });
  const result = await h.reason({ ...request, trigger: 'manual-action', session: { goal: 'Submit request', recentActions: [{ type: 'click', label: 'Submit' }] }, page: { ...request.page, status: 'Submission failed' } });
  assert.notEqual(result.action, 'success');
  assert.deepEqual(h.calls.queries[0].state.session.recentActions, [{ type: 'click', label: 'Submit' }]);
});

test('the Jev state omits duplicate plan memory and unused workflow fields', () => {
  const planned = { ...step, precondition: 'Home is visible', expectedOutcome: 'Settings is visible' };
  const input = { ...request, session: { ...request.session, workflow, decisionContext: { taskStatus: 'active', awaitingInputCompletion: true, step, plan: { id: 'plan-state', currentStepIndex: 0, steps: [planned, { ...planned, targetDescription: 'Language' }] } } } };
  const query = buildAssessmentQuestions(input, input.page.elements);
  assert.deepEqual(query.state.session, { goal: request.session.goal, recentActions: [], awaitingInputCompletion: true });
  assert.deepEqual(query.state.savedStep, planned);
  assert.equal(query.state.nextStep.targetDescription, 'Language');
  assert.equal(query.state.session.decisionContext, undefined);
  assert.equal(query.state.session.workflow, undefined);
});
