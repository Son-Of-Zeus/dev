import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticPageSnapshot, SemanticScanner } from '../dom/semantic';
import type { GuideController, GuideResult } from '../guide/guide-controller';
import type {
  InteractionEvent,
  InteractionObserver,
} from '../interaction/interaction-observer';
import type {
  GuideAction,
  ReasonRequest,
  Reasoner,
} from '../reasoning/reasoning';
import { createElementRegistry } from '../registry/element-registry';
import { createSessionState } from '../session/session-state';
import {
  createFlowController,
  type FlowController,
} from './flow-controller';
import type {
  SpeechToTextResult,
  VoiceController,
  VoiceResult,
} from '../voice/voice';

const initialTranscript: SpeechToTextResult = {
  transcript: 'Help me find account settings.',
  language: 'hi-IN',
};

function createScanner() {
  let listener: ((snapshot: SemanticPageSnapshot) => void) | undefined;
  const semanticSnapshot: SemanticPageSnapshot = {
    page: { title: 'Account Dashboard', section: 'Account Settings' },
    elements: [],
  };
  const scanner: SemanticScanner = {
    scan: vi.fn(() => semanticSnapshot),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  };

  return {
    scanner,
    emit(page?: SemanticPageSnapshot['page']) {
      if (page) Object.assign(semanticSnapshot.page, page);
      listener?.(semanticSnapshot);
    },
  };
}

function createInteractions() {
  let listener: ((event: InteractionEvent) => void) | undefined;
  const interactions: InteractionObserver = {
    start: vi.fn(),
    stop: vi.fn(),
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  };

  return {
    interactions,
    emit(event: InteractionEvent) {
      listener?.(event);
    },
  };
}

function createVoice(result: VoiceResult = { status: 'transcript', ...initialTranscript }) {
  const voice: VoiceController = {
    getState: vi.fn(() => 'idle' as const),
    subscribe: vi.fn(() => () => undefined),
    listen: vi.fn(async () => result),
    stopListening: vi.fn(),
    say: vi.fn(async () => undefined),
    setState: vi.fn(),
    cancel: vi.fn(),
  };
  return voice;
}

function createGuide(
  session: ReturnType<typeof createSessionState>,
): GuideController {
  return {
    run: vi.fn(async (action: GuideAction): Promise<GuideResult> => {
      if (action.action === 'guide') {
        session.setPendingAction({
          targetId: action.targetId,
          expectedUserAction: action.expectedUserAction,
        });
        return { status: 'guided', targetId: action.targetId };
      }
      return { status: 'completed', action: action.action };
    }),
    cancel: vi.fn(),
  };
}

function createHarness(
  actions: GuideAction[],
  buttonLabel = 'Account Settings',
) {
  const button = document.createElement('button');
  button.textContent = buttonLabel;
  document.body.append(button);

  const scannerHarness = createScanner();
  const interactionHarness = createInteractions();
  const registry = createElementRegistry();
  const session = createSessionState();
  const voice = createVoice();
  const guide = createGuide(session);
  const reasoner: Reasoner = {
    reason: vi.fn(async (_request: ReasonRequest) => {
      const action = actions.shift();
      if (!action) {
        throw new Error('No test action remaining.');
      }
      return action;
    }),
  };
  const flow = createFlowController({
    document,
    scanner: scannerHarness.scanner,
    registry,
    session,
    interactions: interactionHarness.interactions,
    reasoner,
    guide,
    voice,
    waitForPageSettled: async () => undefined,
  });

  return {
    button,
    scanner: scannerHarness,
    interactions: interactionHarness,
    registry,
    session,
    voice,
    guide,
    reasoner,
    flow,
  };
}

const guideAction: GuideAction = {
  action: 'guide',
  targetId: 'el_1',
  spokenInstruction: 'Account Settings par click kariye.',
  expectedUserAction: 'click',
  language: 'hi-IN',
};

describe('general flow controller', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('starts the scanner and observer, builds a safe page request, and guides the selected target', async () => {
    const harness = createHarness([guideAction]);
    harness.flow.start();

    const result = await harness.flow.requestVoice();

    expect(harness.scanner.scanner.start).toHaveBeenCalledTimes(1);
    expect(harness.interactions.interactions.start).toHaveBeenCalledTimes(1);
    expect(harness.reasoner.reason).toHaveBeenCalledWith(
      expect.objectContaining({
        userUtterance: initialTranscript.transcript,
        userLanguage: initialTranscript.language,
        page: expect.objectContaining({
          title: 'Account Dashboard',
          elements: [expect.objectContaining({ id: 'el_1', label: 'Account Settings' })],
        }),
      }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      action: guideAction,
      guide: { status: 'guided', targetId: 'el_1' },
    });
    expect(harness.flow.getSnapshot()).toMatchObject({
      phase: 'waiting',
      lastTranscript: initialTranscript,
      lastAction: guideAction,
    });
    expect(harness.session.getState()).toMatchObject({
      goal: initialTranscript.transcript,
      pendingAction: { targetId: 'el_1', expectedUserAction: 'click' },
      companionState: 'waiting',
    });
  });

  it('persists generic readiness metadata so later voice turns retain the clarification plan', async () => {
    const workflow = {
      intent: 'complete a request',
      requiredInformation: ['request details'],
      knownInformation: [],
      missingInformation: ['request details'],
      readiness: 'needs_clarification' as const,
      clarifyingQuestion: 'What details should I use for this request?',
    };
    const clarifyAction: GuideAction = {
      action: 'clarify',
      spokenInstruction: workflow.clarifyingQuestion,
      language: 'en-IN',
      workflow,
    };
    const harness = createHarness([clarifyAction]);
    harness.flow.start();

    await expect(harness.flow.requestVoice()).resolves.toMatchObject({
      status: 'completed',
      action: clarifyAction,
      guide: { status: 'completed', action: 'clarify' },
    });
    expect(harness.session.getState().workflow).toEqual(workflow);
    expect(harness.session.getState().pendingAction).toBeUndefined();
  });

  it('waits for an explicit input completion phrase instead of advancing on validation', async () => {
    const inputAction: GuideAction = {
      ...guideAction,
      expectedUserAction: 'input',
    };
    const successAction: GuideAction = {
      action: 'success',
      spokenInstruction: 'Aapka request complete ho gaya.',
      language: 'en-IN',
    };
    const harness = createHarness([inputAction, successAction]);
    harness.flow.start();
    await harness.flow.requestVoice();

    harness.interactions.emit({
      type: 'input-complete',
      action: 'input',
      targetId: 'el_1',
      label: 'Account identifier',
      matchedPending: false,
      hasValue: true,
      validationState: 'valid',
      timestamp: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.reasoner.reason).toHaveBeenCalledTimes(1);
    expect(harness.session.getState().pendingAction).toEqual({
      targetId: 'el_1',
      expectedUserAction: 'input',
    });

    harness.voice.listen = vi.fn(async () => ({
      status: 'transcript' as const,
      transcript: "I'm done",
      language: 'en-IN',
    }));
    await expect(harness.flow.requestVoice()).resolves.toMatchObject({
      status: 'completed',
      action: successAction,
    });
    expect(harness.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(harness.flow.getSnapshot().phase).toBe('success');
  });

  it('retries post-transcription failures without asking for another recording', async () => {
    const harness = createHarness([]);
    const failingReasoner = vi.fn(async () => {
      throw new Error('Reasoning service unavailable.');
    });
    harness.reasoner.reason = failingReasoner;
    harness.flow.start();

    const failed = await harness.flow.requestVoice();

    expect(failed).toMatchObject({ status: 'error' });
    expect(harness.voice.listen).toHaveBeenCalledTimes(1);
    expect(harness.flow.getSnapshot().retryTranscript).toEqual(initialTranscript);

    const retryReasoner = vi.fn(async () => ({ action: 'wait' as const }));
    harness.reasoner.reason = retryReasoner;
    const retried = await harness.flow.retry();

    expect(retried).toMatchObject({
      status: 'completed',
      action: { action: 'wait' },
    });
    expect(harness.voice.listen).toHaveBeenCalledTimes(1);
    expect(failingReasoner).toHaveBeenCalledTimes(1);
    expect(retryReasoner).toHaveBeenCalledTimes(1);
    expect(harness.flow.getSnapshot()).toMatchObject({
      phase: 'waiting',
      retryTranscript: undefined,
    });
  });

  it('falls back to fresh voice capture when the original request has no transcript', async () => {
    const harness = createHarness([{ action: 'wait' }]);
    let listenCalls = 0;
    harness.voice.listen = vi.fn(async () => {
      listenCalls += 1;
      if (listenCalls === 1) {
        return {
          status: 'error' as const,
          error: new Error('Microphone unavailable.'),
        };
      }
      return { status: 'transcript' as const, ...initialTranscript };
    });
    harness.flow.start();

    await expect(harness.flow.requestVoice()).resolves.toMatchObject({
      status: 'error',
    });
    const recovered = await harness.flow.retry();

    expect(recovered).toMatchObject({
      status: 'completed',
      action: { action: 'wait' },
    });
    expect(listenCalls).toBe(2);
  });

  it('reasons again after the expected user action and keeps the loop on the new page', async () => {
    const successAction: GuideAction = {
      action: 'success',
      spokenInstruction: 'Aapka request complete ho gaya.',
      language: 'hi-IN',
    };
    const harness = createHarness([guideAction, successAction]);
    harness.flow.start();
    await harness.flow.requestVoice();

    const claimButton = document.createElement('button');
    claimButton.textContent = 'Request Status';
    document.body.append(claimButton);
    harness.scanner.emit();

    harness.interactions.emit({
      type: 'click',
      action: 'click',
      targetId: 'el_1',
      label: 'Account Settings',
      matchedPending: true,
      timestamp: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(harness.reasoner.reason).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({ label: 'Request Status' }),
          ]),
        }),
      }),
    );
    expect(harness.guide.run).toHaveBeenCalledTimes(2);
    expect(harness.flow.getSnapshot()).toMatchObject({
      phase: 'success',
      lastAction: successAction,
    });

    harness.interactions.emit({
      type: 'navigation',
      url: 'http://localhost:5173/requests/success',
      previousUrl: 'http://localhost:5173/requests/review',
      reason: 'push-state',
      timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(harness.flow.getSnapshot().phase).toBe('success');
  });

  it('checks page evidence after submission instead of assuming success', async () => {
    const action: GuideAction = { ...guideAction, consequence: 'This sends your request.' };
    const harness = createHarness([action, { action: 'wait' }], 'Submit Request');
    harness.flow.start();
    await harness.flow.requestVoice();
    harness.interactions.emit({ type: 'click', action: 'click', targetId: 'el_1', label: 'Submit Request', matchedPending: true, timestamp: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(harness.flow.getSnapshot().phase).toBe('waiting');
    harness.flow.stop();
  });

  it('coalesces repeated continuation events while reasoning is in flight', async () => {
    const nextAction: GuideAction = { action: 'wait' };
    const harness = createHarness([guideAction, nextAction]);
    harness.flow.start();
    await harness.flow.requestVoice();

    let releaseReasoning!: (action: GuideAction) => void;
    const pendingReasoning = new Promise<GuideAction>((resolve) => {
      releaseReasoning = resolve;
    });
    harness.reasoner.reason = vi.fn(() => pendingReasoning);

    harness.interactions.emit({
      type: 'navigation',
      url: 'http://localhost:5173/requests/review',
      previousUrl: 'http://localhost:5173/dashboard',
      reason: 'push-state',
      timestamp: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    harness.interactions.emit({
      type: 'navigation',
      url: 'http://localhost:5173/requests/review',
      previousUrl: 'http://localhost:5173/dashboard',
      reason: 'url-poll',
      timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.reasoner.reason).toHaveBeenCalledTimes(1);
    releaseReasoning(nextAction);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.reasoner.reason).toHaveBeenCalledTimes(1);
    expect(harness.guide.run).toHaveBeenCalledTimes(2);
  });

  it('keeps guidance active after an unmatched page interaction', async () => {
    const harness = createHarness([guideAction]);
    harness.flow.start();
    await harness.flow.requestVoice();
    const cancelCallCount = vi.mocked(harness.guide.cancel).mock.calls.length;

    const unexpectedButton = document.createElement('button');
    unexpectedButton.textContent = 'Request Status';
    document.body.append(unexpectedButton);


    harness.interactions.emit({
      type: 'click',
      action: 'click',
      targetId: 'el_2',
      label: 'Request Status',
      matchedPending: false,
      timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.reasoner.reason).toHaveBeenCalledTimes(1);
    expect(harness.guide.cancel).toHaveBeenCalledTimes(cancelCallCount);
    expect(harness.session.getState()).toMatchObject({
      pendingAction: { targetId: 'el_1', expectedUserAction: 'click' },
    });
    expect(harness.flow.getSnapshot().phase).toBe('waiting');
  });

  it('does not cancel an input guide while the user clicks or types in the field', async () => {
    const inputAction: GuideAction = {
      ...guideAction,
      expectedUserAction: 'input',
    };
    const harness = createHarness([inputAction]);
    harness.flow.start();
    await harness.flow.requestVoice();
    const cancelCallCount = vi.mocked(harness.guide.cancel).mock.calls.length;

    harness.interactions.emit({
      type: 'click',
      action: 'click',
      targetId: 'el_1',
      label: 'Account identifier',
      matchedPending: false,
      timestamp: 1,
    });
    harness.interactions.emit({
      type: 'input-complete',
      action: 'input',
      targetId: 'el_1',
      label: 'Account identifier',
      matchedPending: false,
      hasValue: true,
      validationState: 'valid',
      timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.guide.cancel).toHaveBeenCalledTimes(cancelCallCount);
    expect(harness.reasoner.reason).toHaveBeenCalledTimes(1);
    expect(harness.session.getState().pendingAction).toEqual({
      targetId: 'el_1',
      expectedUserAction: 'input',
    });
    expect(harness.flow.getSnapshot().phase).toBe('waiting');
  });

  it('preserves pending workflow context for a voice explanation interruption', async () => {
    const explainAction: GuideAction = {
      action: 'explain',
      targetId: 'el_1',
      spokenInstruction: 'Account Settings ek menu hai.',
      language: 'hi-IN',
    };
    const harness = createHarness([guideAction, explainAction]);
    harness.flow.start();
    await harness.flow.requestVoice();
    (harness.voice.listen as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'transcript',
      transcript: 'Ye Account Settings kya hai?',
      language: 'hi-IN',
    });

    const result = await harness.flow.requestVoice();

    expect(result).toMatchObject({
      status: 'completed',
      action: explainAction,
    });
    expect(harness.guide.cancel).toHaveBeenLastCalledWith({
      preservePendingAction: true,
    });
    expect(harness.session.getState()).toMatchObject({
      pendingAction: { targetId: 'el_1', expectedUserAction: 'click' },
      companionState: 'waiting',
    });
    expect(harness.flow.getSnapshot().phase).toBe('waiting');
  });

  it('cancels an in-flight voice request before it can reason or guide', async () => {
    let resolveVoice!: (result: VoiceResult) => void;
    const harness = createHarness([guideAction]);
    harness.voice.listen = vi.fn(
      () =>
        new Promise<VoiceResult>((resolve) => {
          resolveVoice = resolve;
        }),
    );
    harness.flow.start();

    const pending = harness.flow.requestVoice();
    harness.flow.cancel();
    resolveVoice({ status: 'transcript', ...initialTranscript });

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(harness.reasoner.reason).not.toHaveBeenCalled();
    expect(harness.guide.run).not.toHaveBeenCalled();
    expect(harness.voice.cancel).toHaveBeenCalled();
    expect(harness.flow.getSnapshot().phase).toBe('idle');
  });

  it('resets the workflow, cancels active services, and rescans the current page', async () => {
    const harness = createHarness([guideAction]);
    harness.flow.start();
    await harness.flow.requestVoice();
    harness.session.recordAction({ type: 'click', label: 'Account Settings' });

    harness.flow.reset();

    expect(harness.guide.cancel).toHaveBeenCalled();
    expect(harness.voice.cancel).toHaveBeenCalled();
    expect(harness.session.getState()).toEqual({
      recentActions: [],
      companionState: 'idle',
    });
    expect(harness.flow.getSnapshot().phase).toBe('idle');
    expect(harness.flow.getSnapshot().page).not.toBeNull();
    expect(harness.flow.getSnapshot().lastTranscript).toBeUndefined();
    expect(harness.flow.getSnapshot().lastAction).toBeUndefined();
    expect(harness.flow.getSnapshot().error).toBeUndefined();
    expect(harness.reasoner.reason).toHaveBeenCalledTimes(1);
  });

  it('ignores a late voice result after task reset', async () => {
    let resolveVoice!: (result: VoiceResult) => void;
    const harness = createHarness([guideAction]);
    harness.voice.listen = vi.fn(
      () =>
        new Promise<VoiceResult>((resolve) => {
          resolveVoice = resolve;
        }),
    );
    harness.flow.start();

    const pending = harness.flow.requestVoice();
    harness.flow.reset();
    resolveVoice({ status: 'transcript', ...initialTranscript });

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(harness.reasoner.reason).not.toHaveBeenCalled();
    expect(harness.flow.getSnapshot().phase).toBe('idle');
  });

  it('stops all observers and cancels active work on teardown', () => {
    const harness = createHarness([]);
    harness.flow.start();
    harness.flow.stop();

    expect(harness.scanner.scanner.stop).toHaveBeenCalledTimes(1);
    expect(harness.interactions.interactions.stop).toHaveBeenCalledTimes(1);
    expect(harness.guide.cancel).toHaveBeenCalled();
    expect(harness.voice.cancel).toHaveBeenCalled();
    expect(harness.flow.getSnapshot().phase).toBe('stopped');
  });
});

describe('Jev missing-target recovery', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('rescans once before accepting a newly found target', async () => {
    const h = createHarness([guideAction]);
    h.reasoner.reason = vi.fn().mockRejectedValueOnce(Object.assign(new Error('missing'), {status:409})).mockResolvedValue(guideAction);
    h.flow.start(); const result = await h.flow.requestVoice();
    expect(result.status).toBe('completed'); expect(h.reasoner.reason).toHaveBeenCalledTimes(2); h.flow.stop();
  });
  it('asks the user after a second missing match without retrying indefinitely', async () => {
    const h = createHarness([guideAction]);
    h.reasoner.reason = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), {status:409}));
    h.flow.start(); const result = await h.flow.requestVoice();
    expect(result).toMatchObject({status:'completed',action:{action:'clarify'}}); expect(h.reasoner.reason).toHaveBeenCalledTimes(2); h.flow.stop();
  });
});


describe('Jev completion flow', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('checks delayed result text and speaks completion once', async () => {
    const success: GuideAction = { action: 'success', spokenInstruction: 'Task complete.', language: 'en-IN', decisionContext: { taskStatus: 'completed' } };
    const h = createHarness([guideAction, { action: 'wait' }, success]);
    h.flow.start(); await h.flow.requestVoice();
    h.interactions.emit({ type: 'click', action: 'click', targetId: 'el_1', label: 'Settings', matchedPending: true, timestamp: 1 });
    await vi.waitFor(() => expect(h.reasoner.reason).toHaveBeenCalledTimes(2));
    h.scanner.emit({ status: 'Settings saved', evidence: [{ kind: 'status', text: 'Settings saved' }] });
    await vi.waitFor(() => expect(h.flow.getSnapshot().phase).toBe('success'));
    expect(h.reasoner.reason).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: 'page-change' }));
    h.scanner.emit({ status: 'Settings saved again' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.reasoner.reason).toHaveBeenCalledTimes(3);
    expect(vi.mocked(h.guide.run).mock.calls.filter(([action]) => action.action === 'success')).toHaveLength(1);
    expect(h.session.getState().decisionContext?.taskStatus).toBe('completed');
    expect(h.session.getState().pendingAction).toBeUndefined();
    h.flow.stop();
  });
  it('does not check automatic page updates during pending text entry', async () => {
    const h = createHarness([{ ...guideAction, expectedUserAction: 'input' }]);
    h.flow.start(); await h.flow.requestVoice();
    h.scanner.emit({ status: 'Input valid' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.reasoner.reason).toHaveBeenCalledTimes(1);
    expect(h.session.getState().pendingAction?.expectedUserAction).toBe('input');
    h.flow.stop();
  });
  it('sends new speech to Jev instead of using a completion phrase heuristic', async () => {
    const h = createHarness([{ ...guideAction, expectedUserAction: 'input' }, { action: 'wait', decisionContext: { taskStatus: 'active' } }]);
    h.flow.start(); await h.flow.requestVoice();
    h.voice.listen = vi.fn(async () => ({ status: 'transcript' as const, transcript: 'अभी नहीं, पूरा नहीं हो गया', language: 'hi-IN' }));
    await h.flow.requestVoice();
    expect(h.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(h.reasoner.reason).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: 'user', userUtterance: 'अभी नहीं, पूरा नहीं हो गया' }));
    expect(h.session.getState().pendingAction?.expectedUserAction).toBe('input');
    h.flow.stop();
  });
  it('restores completion without restarting the task, then starts a fresh spoken goal', async () => {
    const h = createHarness([{ action: 'wait' }]);
    h.session.setGoal('Old goal');
    h.session.recordAction({ type: 'click', label: 'Old step' });
    h.session.setDecisionContext({ taskStatus: 'completed', goal: 'Old goal' });
    h.flow.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.flow.getSnapshot().phase).toBe('success');
    expect(h.reasoner.reason).not.toHaveBeenCalled();
    h.voice.listen = vi.fn(async () => ({ status: 'transcript' as const, transcript: 'Open help', language: 'en-IN' }));
    await h.flow.requestVoice();
    expect(h.reasoner.reason).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ goal: 'Open help', recentActions: [] }) }));
    h.flow.stop();
  });
  it('clears old goal state when Jev identifies a replacement task', async () => {
    const h = createHarness([guideAction, { action: 'wait', decisionContext: { taskStatus: 'active', goal: 'Open help' } }]);
    h.flow.start(); await h.flow.requestVoice();
    h.session.recordAction({ type: 'click', label: 'Old step' });
    h.voice.listen = vi.fn(async () => ({ status: 'transcript' as const, transcript: 'Open help', language: 'en-IN' }));
    await h.flow.requestVoice();
    expect(h.session.getState().goal).toBe('Open help');
    expect(h.session.getState().recentActions).toEqual([]);
    expect(h.session.getState().pendingAction).toBeUndefined();
    h.flow.stop();
  });
  it('does not speak a completion answer when newer evidence has appeared', async () => {
    const h = createHarness([{ action: 'wait' }]);
    let resolve!: (action: GuideAction) => void;
    h.reasoner.reason = vi.fn().mockImplementationOnce(() => new Promise<GuideAction>((done) => { resolve = done; })).mockResolvedValue({ action: 'wait' });
    h.flow.start();
    const pending = h.flow.requestVoice();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    h.scanner.emit({ status: 'Submission failed' });
    resolve({ action: 'success', spokenInstruction: 'Done.', language: 'en-IN', decisionContext: { taskStatus: 'completed' } });
    expect((await pending).status).toBe('completed');
    expect(h.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.guide.run).mock.calls.every(([action]) => action.action !== 'success')).toBe(true);
    h.flow.stop();
  });
  it('ignores late Jev answers after reset', async () => {
    const h = createHarness([]);
    let resolve!: (action: GuideAction) => void;
    h.reasoner.reason = vi.fn(() => new Promise<GuideAction>((done) => { resolve = done; }));
    h.flow.start(); const pending = h.flow.requestVoice();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    h.flow.reset();
    resolve({ action: 'success', spokenInstruction: 'Done.', language: 'en-IN' });
    expect((await pending).status).toBe('cancelled');
    expect(h.guide.run).not.toHaveBeenCalled(); h.flow.stop();
  });
  it('does not repeat guidance for the same pending step on a page check', async () => {
    const h = createHarness([guideAction, guideAction]);
    h.flow.start(); await h.flow.requestVoice();
    h.scanner.emit({ status: 'Page updated' });
    await vi.waitFor(() => expect(h.reasoner.reason).toHaveBeenCalledTimes(2));
    expect(h.guide.run).toHaveBeenCalledTimes(1);
    h.scanner.emit();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.reasoner.reason).toHaveBeenCalledTimes(2); h.flow.stop();
  });
});

describe('cached request phase', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('returns to waiting when an identical spoken request is deduplicated', async () => {
    const h = createHarness([{ action: 'wait' }]);
    h.flow.start(); await h.flow.requestVoice(); await h.flow.requestVoice();
    expect(h.reasoner.reason).toHaveBeenCalledTimes(1);
    expect(h.flow.getSnapshot().phase).toBe('waiting'); h.flow.stop();
  });
});

describe('input completion during page settling', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('rechecks the same explicit speech when input evidence changes during assessment', async () => {
    const h = createHarness([{ ...guideAction, expectedUserAction: 'input' }]);
    h.flow.start(); await h.flow.requestVoice();
    h.voice.listen = vi.fn(async () => ({ status: 'transcript' as const, transcript: 'Done', language: 'en-IN' }));
    let resolve!: (action: GuideAction) => void;
    h.reasoner.reason = vi.fn().mockImplementationOnce(() => new Promise<GuideAction>((done) => { resolve = done; })).mockResolvedValue({ action: 'wait', decisionContext: { taskStatus: 'active', inputComplete: true } });
    const pending = h.flow.requestVoice();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    h.scanner.emit({ status: 'Entry checked' });
    resolve({ action: 'wait', decisionContext: { taskStatus: 'active', inputComplete: true } });
    expect((await pending).status).toBe('completed');
    expect(h.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(h.reasoner.reason).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: 'user', userUtterance: 'Done' }));
    expect(h.session.getState().pendingAction).toBeUndefined(); h.flow.stop();
  });
});

describe('stream lifetime and shared recovery budget', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('retains queued steps across continuation and rejects late steps after Stop', async () => {
    const h = createHarness([]);
    const step = { targetDescription: 'Settings button', spokenInstruction: 'Open Settings.', language: 'en-IN' as const, precondition: 'Home is visible.', expectedOutcome: 'Settings is visible.' };
    const plan = { id: 'synthetic-plan', steps: [step], currentStepIndex: 0, complete: false };
    let emit!: (update: import('../reasoning/reasoning').PlanUpdate) => void;
    h.reasoner.subscribePlan = (listener) => { emit = listener; return () => {}; };
    h.reasoner.cancelPlans = vi.fn();
    h.reasoner.reason = vi.fn().mockResolvedValueOnce({ ...guideAction, decisionContext: { taskStatus: 'active', step: { targetDescription: step.targetDescription, spokenInstruction: step.spokenInstruction, language: step.language }, plan } }).mockResolvedValue({ action: 'wait' });
    h.flow.start(); await h.flow.requestVoice();
    const next = { ...plan, steps: [step, { ...step, targetDescription: 'Language dropdown' }], complete: true };
    emit({ plan: next });
    expect(h.session.getState().decisionContext?.plan?.steps).toHaveLength(2);
    h.interactions.emit({ type: 'click', action: 'click', targetId: 'el_1', label: 'Settings', matchedPending: true, timestamp: 1 });
    await vi.waitFor(() => expect(h.reasoner.reason).toHaveBeenCalledTimes(2));
    expect(vi.mocked(h.reasoner.reason).mock.calls[1]![0].session.decisionContext?.plan?.steps).toHaveLength(2);
    expect(h.reasoner.cancelPlans).not.toHaveBeenCalled();
    h.flow.cancel();
    emit({ plan: next });
    expect(h.session.getState().decisionContext).toBeUndefined();
    expect(h.reasoner.cancelPlans).toHaveBeenCalled();
    h.flow.stop();
  });

  it('uses one shared retry for missing targets and stale guide preparation', async () => {
    const h = createHarness([]);
    h.reasoner.reason = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Missing'), { status: 409 })).mockResolvedValue(guideAction);
    h.guide.run = vi.fn(async () => ({ status: 'stale-target' as const, targetId: 'el_1' }));
    h.flow.start();
    expect((await h.flow.requestVoice()).status).toBe('error');
    expect(h.reasoner.reason).toHaveBeenCalledTimes(2);
    expect(h.voice.listen).toHaveBeenCalledTimes(1);
    h.flow.stop();
  });
});

describe('plan tail failure', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('keeps the issued step and drops unissued steps when the tail fails', async () => {
    const h = createHarness([]);
    const step = { targetDescription: 'Settings button', spokenInstruction: 'Open Settings.', language: 'en-IN' as const, precondition: 'Home is visible.', expectedOutcome: 'Settings is visible.' };
    const plan = { id: 'tail-failure', steps: [step, { ...step, targetDescription: 'Language dropdown' }], currentStepIndex: 0, complete: false };
    let emit!: (update: import('../reasoning/reasoning').PlanUpdate) => void;
    h.reasoner.subscribePlan = (listener) => { emit = listener; return () => {}; };
    h.reasoner.reason = vi.fn(async () => ({ ...guideAction, decisionContext: { taskStatus: 'active' as const, plan } }));
    h.flow.start(); await h.flow.requestVoice();
    emit({ plan, failed: true });
    expect(h.session.getState().decisionContext?.plan).toMatchObject({ complete: true, currentStepIndex: 0, steps: [step] });
    expect(h.session.getState().pendingAction?.targetId).toBe('el_1');
    expect(h.flow.getSnapshot().phase).toBe('waiting');
    h.flow.stop();
  });
});

describe('automatic completion checks', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('keeps the waiting UI stable while Jev checks page evidence in the background', async () => {
    const h = createHarness([guideAction]);
    h.flow.start(); await h.flow.requestVoice();
    const phases: string[] = [];
    h.flow.subscribe((snapshot) => phases.push(snapshot.phase));
    let resolve!: (action: GuideAction) => void;
    h.reasoner.reason = vi.fn(() => new Promise<GuideAction>((done) => { resolve = done; }));
    h.interactions.emit({ type: 'click', action: 'click', targetId: 'el_1', label: 'Settings', matchedPending: true, timestamp: 1 });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    expect(h.flow.getSnapshot().phase).toBe('waiting');
    expect(phases).not.toContain('thinking');
    resolve({ action: 'wait', decisionContext: { taskStatus: 'active' } });
    await vi.waitFor(() => expect(h.flow.getSnapshot().phase).toBe('waiting'));
    expect(phases).not.toContain('thinking');
    h.flow.stop();
  });
  it('completes from Jev evidence without asking for a spoken answer', async () => {
    const success: GuideAction = { action: 'success', spokenInstruction: 'Task complete.', language: 'en-IN', decisionContext: { taskStatus: 'completed' } };
    const h = createHarness([guideAction, success]);
    h.flow.start(); await h.flow.requestVoice();
    h.scanner.emit({ status: 'Selected tab: Settings' });
    await vi.waitFor(() => expect(h.flow.getSnapshot().phase).toBe('success'));
    expect(h.voice.listen).toHaveBeenCalledTimes(1);
    expect(h.session.getState().pendingAction).toBeUndefined();
    h.scanner.emit({ status: 'Selected tab: Settings refreshed' });
    h.interactions.emit({ type: 'navigation', url: 'https://example.test/settings', previousUrl: 'https://example.test/', reason: 'push-state', timestamp: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.reasoner.reason).toHaveBeenCalledTimes(2);
    h.flow.stop();
  });
});
