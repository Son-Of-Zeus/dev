import { describe, it, expect } from 'vitest';
import { validateDecisionContext } from './decision-context';
import { sanitizeReasonRequest, validateGuideAction } from './reasoning';
import { safeSession } from '../platform/session';
import { createSessionState } from '../session/session-state';

const step = { targetDescription: 'Email field', spokenInstruction: 'Enter your email.', language: 'en-IN' as const };
describe('decision context safety and storage', () => {
  it('rejects DOM identifiers, unknown fields and invalid status', () => {
    expect(() => validateDecisionContext({ taskStatus: 'active', step: { ...step, targetId: 'el_1' } })).toThrow();
    expect(() => validateDecisionContext({ taskStatus: 'unknown' })).toThrow();
    expect(() => validateDecisionContext({ taskStatus: 'active', html: '<p>' })).toThrow();
  });
  it('redacts semantic memory and preserves completion across session storage', () => {
    const state = safeSession({ goal: 'Email person@example.com', decisionContext: { taskStatus: 'completed', goal: 'Email person@example.com', inputComplete: true } });
    expect(state.decisionContext).toEqual({ taskStatus: 'completed', goal: 'Email [redacted]' });
    expect(state.goal).toBe('Email [redacted]');
    expect(safeSession({ recentActions: [] }).decisionContext).toBeUndefined();
  });
  it('clones saved steps and drops transient input completion flags', () => {
    const session = createSessionState();
    session.setDecisionContext({ taskStatus: 'active', step, inputComplete: true });
    const snapshot = session.getState(); snapshot.decisionContext!.step!.targetDescription = 'Changed';
    expect(session.getState().decisionContext?.step?.targetDescription).toBe('Email field');
    expect(session.getState().decisionContext?.inputComplete).toBeUndefined();
    session.reset(); expect(session.getState().decisionContext).toBeUndefined();
  });
  it('validates action metadata and redacts evidence before transport', () => {
    const result = validateGuideAction({ action: 'wait', decisionContext: { taskStatus: 'active', step } }, []);
    expect(result.decisionContext?.step).toEqual(step);
    const request = sanitizeReasonRequest({ trigger: 'page-change', userUtterance: 'Continue', session: { recentActions: [], decisionContext: { taskStatus: 'active', step } }, page: { elements: [], evidence: [{ kind: 'status', text: 'Email person@example.com' }] } });
    expect(request.page.evidence?.[0]?.text).toBe('Email [redacted]');
    expect(() => sanitizeReasonRequest({ ...request, trigger: 'invalid' as never })).toThrow();
    expect(() => sanitizeReasonRequest({ ...request, page: { elements: [], evidence: Array(13).fill({ kind: 'status', text: 'A' }) } })).toThrow();
  });
});

describe('semantic plan persistence', () => {
  it('deep-copies and redacts plans while retaining the input-completion lock', () => {
    const session = createSessionState();
    session.setDecisionContext({ taskStatus: 'active', awaitingInputCompletion: true, plan: { id: 'test-plan', currentStepIndex: 0, complete: false, steps: [{ ...step, precondition: 'Email person@example.com', expectedOutcome: 'The next section is visible.' }] } });
    const snapshot = session.getState();
    snapshot.decisionContext!.plan!.steps[0]!.spokenInstruction = 'Changed';
    expect(session.getState().decisionContext?.plan?.steps[0]?.spokenInstruction).toBe(step.spokenInstruction);
    const saved = safeSession(session.getState());
    expect(saved.decisionContext?.awaitingInputCompletion).toBe(true);
    expect(saved.decisionContext?.step).toEqual(step);
    expect(JSON.stringify(saved)).not.toContain('person@example.com');
  });
});

describe('ordinary function descriptions', () => {
  it('accepts the captured metrics guidance through action and plan memory checks', () => {
    const metrics = { targetDescription: 'Metrics tab in the function header navigation next to Function Calls', spokenInstruction: 'Tap the Metrics tab to see the backend metrics.', language: 'en-IN' as const, precondition: 'The voice-companion backend function page is open with Function Calls selected.', expectedOutcome: 'The Metrics view will open showing charts for invocations, latency and errors.' };
    const context = { taskStatus: 'active' as const, plan: { id: 'metrics-plan', currentStepIndex: 0, steps: [metrics] } };
    const target = { id: 'synthetic_metrics', role: 'tab', label: 'Metrics', visible: true, inViewport: true, disabled: false };
    const result = validateGuideAction({ action: 'guide', targetId: target.id, expectedUserAction: 'click', spokenInstruction: 'Open Metrics in the backend function header.', language: 'en-IN', decisionContext: context }, [target.id]);
    expect(result.action).toBe('guide');
    expect(result.decisionContext?.plan?.steps[0]).toEqual(metrics);
    expect(safeSession({ decisionContext: context }).decisionContext?.plan?.steps[0]).toEqual(metrics);
  });
  it('allows ordinary prose and keeps rejecting script syntax in speech and saved steps', () => {
    for (const text of ['Metrics tab in the function header', 'The backend function page is open.', 'Let me see the metrics.', 'Function Calls is selected.']) {
      expect(validateGuideAction({ action: 'explain', spokenInstruction: text, language: 'en-IN' }, []).action).toBe('explain');
      expect(validateDecisionContext({ taskStatus: 'active', step: { ...step, targetDescription: text } }).step?.targetDescription).toBe(text);
    }
    for (const text of ['function run() {}', 'function () {}', 'function* run() {}', 'const x = 1;', 'let x;', 'var x, y;', 'const {x} = data;', 'let [x] = data;', '() => run()', 'javascript:run()', '<script>run()</script>', '```js']) {
      expect(() => validateGuideAction({ action: 'explain', spokenInstruction: text, language: 'en-IN' }, [])).toThrow();
      expect(() => validateDecisionContext({ taskStatus: 'active', step: { ...step, targetDescription: text } })).toThrow();
    }
  });
});

describe('retired whole-task confirmation', () => {
  it('drops the old flag from memory while preserving input completion', () => {
    const context = validateDecisionContext({ taskStatus: 'active', awaitingConfirmation: true, awaitingInputCompletion: true });
    expect(context.awaitingConfirmation).toBeUndefined();
    expect(context.awaitingInputCompletion).toBe(true);
    expect(safeSession({ decisionContext: context }).decisionContext?.awaitingConfirmation).toBeUndefined();
    expect(() => validateDecisionContext({ taskStatus: 'active', awaitingConfirmation: 'yes' })).toThrow();
  });
});
