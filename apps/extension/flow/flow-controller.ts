import { validateDecisionContext, type SemanticPlan, type RequestTrigger } from '../reasoning/decision-context';
import {
  discoverSemanticElements,
  type SemanticPageSnapshot,
  type SemanticScanner,
} from '../dom/semantic';
import type { GuideController, GuideResult } from '../guide/guide-controller';
import type {
  InteractionEvent,
  InteractionObserver,
} from '../interaction/interaction-observer';
import {
  buildReasonRequest,
  type PlanUpdate,
  type GuideAction,
  type ReasonRequest,
  type Reasoner,
  type ReasoningPage,
} from '../reasoning/reasoning';
import type { ElementRegistry } from '../registry/element-registry';
import type { SessionStateStore } from '../session/session-state';
import type {
  SpeechToTextResult,
  VoiceController,
  VoiceResult,
} from '../voice/voice';
import {
  latencyDurationMs,
  type LatencyMetric,
  type LatencyStage,
} from '../runtime/latency';

const REASONING_DEDUPE_WINDOW_MS = 2_000;

export type FlowPhase =
  | 'stopped'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'guiding'
  | 'waiting'
  | 'success'
  | 'error';

export type FlowSnapshot = {
  phase: FlowPhase;
  taskActive?: boolean;
  page: ReasoningPage | null;
  lastTranscript?: SpeechToTextResult;
  retryTranscript?: SpeechToTextResult;
  lastAction?: GuideAction;
  error?: Error;
};

export type FlowResult =
  | {
      status: 'completed';
      transcript: SpeechToTextResult;
      action: GuideAction;
      guide: GuideResult;
    }
  | { status: 'cancelled' }
  | { status: 'error'; error: Error };

export type FlowControllerOptions = {
  document?: Document;
  scanner: SemanticScanner;
  registry: ElementRegistry;
  session: SessionStateStore;
  interactions: InteractionObserver;
  reasoner: Reasoner;
  guide: GuideController;
  voice: VoiceController;
  waitForPageSettled?: () => Promise<void>;
  onPageSnapshot?: (page: ReasoningPage) => void;
  onError?: (error: Error) => void;
  onLatency?: (metric: LatencyMetric) => void;
  now?: () => number;
};

export type FlowController = {
  getSnapshot(): FlowSnapshot;
  subscribe(listener: (snapshot: FlowSnapshot) => void): () => void;
  start(): void;
  stop(): void;
  reset(): void;
  refresh(): ReasoningPage;
  requestVoice(): Promise<FlowResult>;
  retry(): Promise<FlowResult>;
  cancel(): void;
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function defaultWaitForPageSettled(documentNode: Document): Promise<void> {
  const windowNode = documentNode.defaultView;
  return new Promise((resolve) => {
    if (windowNode?.requestAnimationFrame) {
      windowNode.requestAnimationFrame(() => {
        windowNode.requestAnimationFrame(() => resolve());
      });
      return;
    }

    setTimeout(resolve, 0);
  });
}

function pageFromSnapshot(
  snapshot: SemanticPageSnapshot,
  registry: ElementRegistry,
): ReasoningPage {
  return {
    page: snapshot.page,
    elements: registry.snapshot(),
  };
}

function flowPhaseForGuideResult(
  result: GuideResult,
  hasPendingAction: boolean,
): FlowPhase {
  if (result.status === 'guided') {
    return 'waiting';
  }
  if (result.status === 'completed') {
    if (result.action === 'success') {
      return 'success';
    }
    if (result.action === 'wait') {
      return 'waiting';
    }
    if (result.action === 'explain' && hasPendingAction) {
      return 'waiting';
    }
  }
  return 'idle';
}

export function createFlowController(
  options: FlowControllerOptions,
): FlowController {
  const documentNode = options.document ?? document;
  const waitForPageSettled =
    options.waitForPageSettled ?? (() => defaultWaitForPageSettled(documentNode));
  const listeners = new Set<(snapshot: FlowSnapshot) => void>();
  let snapshot: FlowSnapshot = {
    phase: 'stopped',
    page: null,
  };
  let started = false;
  let taskActive = false;
  let planSubscription: (() => void) | undefined;
  const stagedPlans = new Map<string, PlanUpdate>();
  let generation = 0;
  let pageSubscription: (() => void) | undefined;
  let interactionSubscription: (() => void) | undefined;
  let continuationTimer: ReturnType<typeof setTimeout> | undefined;
  let continuationInFlight = false;
  let continuationOwner: number | undefined;
  let continuationRequested = false;
  let pageRevision = 0;
  let continuationTrigger: RequestTrigger = 'page-change';
  let lastAutomaticKey: string | undefined;
  let lastNavigationUrl: string | undefined;
  let pageFingerprint: string | undefined;
  let inFlightReasoning:
    | { key: string; promise: Promise<GuideAction> }
    | undefined;
  let lastReasoning:
    | { key: string; result: FlowResult; expiresAt: number }
    | undefined;
  const now = options.now ?? (() => performance.now());

  const measure = async <Result>(
    stage: LatencyStage,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const startedAt = now();
    try {
      return await operation();
    } finally {
      options.onLatency?.({
        stage,
        durationMs: latencyDurationMs(startedAt, now()),
      });
    }
  };

  const measureSync = <Result>(
    stage: LatencyStage,
    operation: () => Result,
  ): Result => {
    const startedAt = now();
    try {
      return operation();
    } finally {
      options.onLatency?.({
        stage,
        durationMs: latencyDurationMs(startedAt, now()),
      });
    }
  };

  const publish = (nextSnapshot: FlowSnapshot) => {
    snapshot = { ...nextSnapshot, taskActive };
    listeners.forEach((listener) => listener(snapshot));
  };

  const setPhase = (phase: FlowPhase, error?: Error) => {
    options.session.setCompanionState(phase === 'stopped' ? 'idle' : phase);
    publish({
      ...snapshot,
      phase,
      ...(error ? { error } : { error: undefined }),
    });
  };

  const refresh = (existingSnapshot?: SemanticPageSnapshot): ReasoningPage => {
    const page = measureSync('semantic-scan', () => {
      const semanticSnapshot = existingSnapshot ?? options.scanner.scan();
      options.registry.reconcile(options.scanner.getDiscovered?.() ?? discoverSemanticElements(documentNode));
      const page = pageFromSnapshot(semanticSnapshot, options.registry);
      const origin = documentNode.location?.origin;
      if (origin && /^https?:/.test(origin)) page.origin = origin;
      return page;
    });
    const semanticElements = page.elements.map(({ id: _id, inViewport: _inViewport, ...element }) => JSON.stringify(element)).sort();
    const nextPageFingerprint = JSON.stringify({ origin: page.origin, page: page.page, elements: semanticElements });
    if (nextPageFingerprint !== pageFingerprint) {
      pageRevision += 1;
      pageFingerprint = nextPageFingerprint;
    }
    options.onPageSnapshot?.(page);
    publish({ ...snapshot, page });
    return page;
  };

  const clearContinuation = () => {
    if (continuationTimer) {
      clearTimeout(continuationTimer);
      continuationTimer = undefined;
    }
  };

  const activate = () => {
    taskActive = true;
    options.scanner.start();
    options.interactions.start();
  };
  const stopObservers = () => {
    options.scanner.stop();
    options.interactions.stop();
  };
  const mergePlan = (context: NonNullable<GuideAction['decisionContext']>) => {
    const plan = context.plan;
    if (!plan) return context;
    const update = stagedPlans.get(plan.id);
    if (!update) return context;
    const count = Math.min(plan.steps.length, update.plan.steps.length);
    if (JSON.stringify(plan.steps.slice(0, count)) !== JSON.stringify(update.plan.steps.slice(0, count))) return context;
    const steps = update.failed ? plan.steps.slice(0, Math.min(plan.steps.length, plan.currentStepIndex + 1)) : update.plan.steps;
    const merged: SemanticPlan = { ...update.plan, steps, currentStepIndex: Math.min(plan.currentStepIndex, steps.length), complete: update.failed ? true : update.plan.complete };
    const current = merged.steps[merged.currentStepIndex];
    const step = current ? { targetDescription: current.targetDescription, spokenInstruction: current.spokenInstruction, language: current.language, ...(current.consequence ? { consequence: current.consequence } : {}) } : undefined;
    return validateDecisionContext({ ...context, plan: merged, step });
  };

  const beginRun = (): number => {
    generation += 1;
    options.reasoner.cancel?.();
    inFlightReasoning = undefined;
    continuationRequested = false;
    clearContinuation();
    return generation;
  };

  const isCurrent = (runGeneration: number) =>
    started && taskActive && generation === runGeneration;

  const fail = (
    error: unknown,
    retryTranscript?: SpeechToTextResult,
  ): FlowResult => {
    const normalized = asError(error);
    options.guide.cancel({ preservePendingAction: options.session.getState().pendingAction?.expectedUserAction === 'input' });
    options.voice.setState('error');
    setPhase('error', normalized);
    publish({ ...snapshot, retryTranscript });
    options.onError?.(normalized);
    return { status: 'error', error: normalized };
  };

  const guideResultToFlowResult = (
    transcript: SpeechToTextResult,
    action: GuideAction,
    guideResult: GuideResult,
  ): FlowResult => {
    if (guideResult.status === 'cancelled') {
      return { status: 'cancelled' };
    }
    if (guideResult.status === 'error') {
      return fail(guideResult.error, transcript);
    }
    if (guideResult.status === 'blocked') {
      return fail(new Error(guideResult.reason), transcript);
    }
    if (guideResult.status === 'stale-target') {
      return fail(
        new Error(`Target ${guideResult.targetId} is no longer live.`),
        transcript,
      );
    }

    setPhase(
      flowPhaseForGuideResult(
        guideResult,
        Boolean(options.session.getState().pendingAction),
      ),
    );
    return {
      status: 'completed',
      transcript,
      action,
      guide: guideResult,
    };
  };

  const waitForInputCompletion = (
    transcript: SpeechToTextResult,
  ): FlowResult => {
    const action: GuideAction = { action: 'wait' };
    setPhase('waiting');
    return {
      status: 'completed',
      transcript,
      action,
      guide: { status: 'completed', action: 'wait' },
    };
  };

  const reasoningKeyFor = (
    request: ReasonRequest,
    recentActionTimestamps: number[],
  ): string =>
    JSON.stringify({
      pageRevision,
      request,
      recentActionTimestamps,
    });

  const reasonOnce = (
    request: ReasonRequest,
    key: string,
  ): Promise<GuideAction> => {
    if (inFlightReasoning?.key === key) {
      return inFlightReasoning.promise;
    }

    const promise = options.reasoner.reason(request);
    inFlightReasoning = { key, promise };
    promise.then(
      () => {
        if (inFlightReasoning?.promise === promise) {
          inFlightReasoning = undefined;
        }
      },
      () => {
        if (inFlightReasoning?.promise === promise) {
          inFlightReasoning = undefined;
        }
      },
    );
    return promise;
  };

  const reasonAndGuide = async (
    transcript: SpeechToTextResult,
    runGeneration: number,
    trigger: RequestTrigger = 'user',
    staleRetries = 0,
  ): Promise<FlowResult> => {
    if (!isCurrent(runGeneration)) {
      return { status: 'cancelled' };
    }

    if (trigger !== 'user' && (options.session.getState().pendingAction?.expectedUserAction === 'input' || options.session.getState().decisionContext?.awaitingInputCompletion)) {
      return waitForInputCompletion(transcript);
    }

    // Automatic evidence checks must not flash the user's waiting state.
    if (trigger === 'user') setPhase('thinking');
    try {
      const page = refresh();
      const session = options.session.getState();
      let request = buildReasonRequest({
        trigger,
        userUtterance: transcript.transcript,
        language: transcript.language,
        session,
        page,
      });
      let requestRevision = pageRevision;
      const automaticKey = JSON.stringify({ page: pageFingerprint, goal: session.goal, recentActions: request.session.recentActions, pending: request.session.pendingAction, plan: request.session.decisionContext?.plan });
      if (!staleRetries && trigger !== 'user' && automaticKey === lastAutomaticKey) {
        return waitForInputCompletion(transcript);
      }
      const reasoningKey = reasoningKeyFor(
        request,
        session.recentActions.map((action) => action.timestamp),
      );
      if (
        !staleRetries && lastReasoning?.key === reasoningKey &&
        lastReasoning.expiresAt > now()
      ) {
        const cached = lastReasoning.result;
        if (cached.status === 'completed') {
          setPhase(flowPhaseForGuideResult(cached.guide, Boolean(options.session.getState().pendingAction)));
        }
        return cached;
      }
      const action = await measure('reasoning', () => staleRetries ? options.reasoner.reason(request) : reasonOnce(request, reasoningKey));
      if (!isCurrent(runGeneration)) {
        return { status: 'cancelled' };
      }

      refresh();
      if ('targetId' in action && action.targetId) {
        const original = request.page.elements.find((element) => element.id === action.targetId);
        const live = options.registry.getLive(action.targetId);
        if (!live || live.disabled || !live.visible || (original && (original.label !== live.label || original.role !== live.role))) {
          throw Object.assign(new Error('The selected control is no longer live.'), { staleTarget: true });
        }
      }
      if (pageRevision !== requestRevision) throw Object.assign(new Error('Page evidence changed during selection.'), { staleTarget: true });
      if (trigger !== 'user') lastAutomaticKey = automaticKey;
      if (action.decisionContext) {
        if (action.decisionContext.goal && action.decisionContext.goal !== session.goal) {
          options.session.reset();
          options.session.setGoal(action.decisionContext.goal);
        }
        if (action.decisionContext.inputComplete) options.session.clearPendingAction();
      }
      if (action.action === 'success') {
        options.session.clearPendingAction();
        options.session.setDecisionContext({ taskStatus: 'completed', goal: options.session.getState().goal });
        clearContinuation();
      }
      if (trigger !== 'user' && action.action === 'guide' && snapshot.lastAction?.action === 'guide' &&
        action.targetId === snapshot.lastAction.targetId && action.spokenInstruction === snapshot.lastAction.spokenInstruction &&
        action.consequence === snapshot.lastAction.consequence && options.session.getState().pendingAction?.targetId === action.targetId) {
        return waitForInputCompletion(transcript);
      }

      if (action.workflow) {
        options.session.setWorkflow(action.workflow);
      }
      publish({ ...snapshot, lastAction: action });
      if (action.action === 'guide') {
        setPhase('guiding');
      }
      const guideResult = await options.guide.run(action);
      if (!isCurrent(runGeneration)) {
        return { status: 'cancelled' };
      }

      if (guideResult.status === 'stale-target') throw Object.assign(new Error('The selected control was replaced during guidance.'), { staleTarget: true });
      if (action.decisionContext && ['guided', 'completed'].includes(guideResult.status) && action.action !== 'success') options.session.setDecisionContext(mergePlan(action.decisionContext));
      const flowResult = guideResultToFlowResult(
        transcript,
        action,
        guideResult,
      );
      if (flowResult.status === 'completed' && action.action === 'success') {
        taskActive = false; stopObservers(); options.reasoner.cancelPlans?.(); publish({ ...snapshot });
      }
      if (flowResult.status === 'completed') {
        lastReasoning = {
          key: reasoningKey,
          result: flowResult,
          expiresAt: now() + REASONING_DEDUPE_WINDOW_MS,
        };
      }
      return flowResult;
    } catch (error) {
      if (!isCurrent(runGeneration)) {
        return { status: 'cancelled' };
      }
      const stale = Boolean(error && typeof error === 'object' && (('staleTarget' in error && error.staleTarget) || ('status' in error && error.status === 409)));
      if (stale && staleRetries === 0) {
        lastReasoning = undefined; lastAutomaticKey = undefined; inFlightReasoning = undefined;
        options.reasoner.cancel?.();
        options.guide.cancel({ preservePendingAction: Boolean(options.session.getState().decisionContext?.awaitingInputCompletion) });
        await measure('page-settle', waitForPageSettled);
        if (!isCurrent(runGeneration)) return { status: 'cancelled' };
        return reasonAndGuide(transcript, runGeneration, trigger, 1);
      }
      if (stale && error && typeof error === 'object' && 'status' in error && error.status === 409) {
        const action: GuideAction = { action: 'clarify', language: transcript.language ?? 'en-IN', spokenInstruction: 'I cannot find that control. Open the relevant section, then ask again.' };
        const guide = await options.guide.run(action);
        if (!isCurrent(runGeneration)) return { status: 'cancelled' };
        return guideResultToFlowResult(transcript, action, guide);
      }
      return fail(error, transcript);
    }
  };

  const continueAfterPageChange = async () => {
    if (!taskActive || !snapshot.lastTranscript) {
      return;
    }

    if (continuationInFlight) {
      continuationRequested = true;
      return;
    }

    continuationRequested = false;
    continuationInFlight = true;
    const runGeneration = beginRun();
    continuationOwner = runGeneration;
    try {
      await measure('page-settle', waitForPageSettled);
      if (!isCurrent(runGeneration) || !snapshot.lastTranscript) {
        return;
      }

      const trigger = continuationTrigger;
      continuationTrigger = 'page-change';
      await reasonAndGuide(snapshot.lastTranscript, runGeneration, trigger);
    } finally {
      if (continuationOwner !== runGeneration) return;
      continuationOwner = undefined;
      continuationInFlight = false;
      if (
        continuationRequested &&
        started &&
        snapshot.phase !== 'success' &&
        snapshot.lastTranscript
      ) {
        clearContinuation();
        continuationTimer = setTimeout(() => {
          continuationTimer = undefined;
          void continueAfterPageChange();
        }, 0);
      }
    }
  };

  const scheduleContinuation = (trigger: RequestTrigger = 'page-change') => {
    if (!started || !taskActive || snapshot.phase === 'error' || snapshot.phase === 'success' || options.session.getState().decisionContext?.taskStatus === 'completed' ||
      (options.session.getState().pendingAction?.expectedUserAction === 'input' || options.session.getState().decisionContext?.awaitingInputCompletion) || !snapshot.lastTranscript) {
      return;
    }
    if (trigger !== 'page-change' || continuationTrigger === 'page-change') continuationTrigger = trigger;
    continuationRequested = true;
    clearContinuation();
    continuationTimer = setTimeout(() => {
      continuationTimer = undefined;
      void continueAfterPageChange();
    }, 0);
  };

  const handleInteraction = (event: InteractionEvent) => {
    if (!taskActive || snapshot.phase === 'success') {
      return;
    }

    if (event.type === 'navigation') {
      if (event.url === lastNavigationUrl) return;
      lastNavigationUrl = event.url;
      beginRun();
      options.voice.cancel();
      options.guide.cancel({ preservePendingAction: options.session.getState().pendingAction?.expectedUserAction === 'input' });
      scheduleContinuation('page-change');
      return;
    }

    if (
      event.type === 'input-complete' &&
      options.session.getState().pendingAction?.expectedUserAction === 'input'
    ) {
      return;
    }

    if (event.matchedPending) {
      options.session.clearPendingAction();
      options.guide.cancel();
      scheduleContinuation('manual-action');
      return;
    }

    // Unmatched page activity is not a stop signal. In particular, clicking
    // and typing in a guided input must leave the highlight and pending step
    // intact until the user explicitly returns to the companion control.
  };

  const clearRetryTranscript = () => {
    if (!snapshot.retryTranscript) {
      return;
    }
    publish({ ...snapshot, retryTranscript: undefined });
  };

  const cancel = () => {
    taskActive = false;
    continuationOwner = undefined; continuationInFlight = false;
    beginRun();
    options.reasoner.cancelPlans?.();
    stopObservers();
    options.guide.cancel();
    options.voice.cancel();
    stagedPlans.clear();
    lastAutomaticKey = undefined; lastReasoning = undefined;
    options.session.reset();
    publish({ phase: started ? 'idle' : 'stopped', page: snapshot.page });
    setPhase(started ? 'idle' : 'stopped');
  };

  // Retain an internal clear-and-scan helper for teardown and old callers.
  const reset = () => { cancel(); if (started) refresh(); };

  const requestVoice = async (): Promise<FlowResult> => {
    if (!started) {
      return fail(new Error('Flow controller is not started.'));
    }

    activate();
    clearRetryTranscript();
    const runGeneration = beginRun();
    const preservePendingAction = Boolean(
      options.session.getState().pendingAction,
    );
    options.guide.cancel({ preservePendingAction });
    setPhase('listening');

    let voiceResult: VoiceResult;
    try {
      voiceResult = await options.voice.listen();
    } catch (error) {
      if (!isCurrent(runGeneration)) {
        return { status: 'cancelled' };
      }
      return fail(error);
    }

    if (!isCurrent(runGeneration)) {
      return { status: 'cancelled' };
    }
    if (voiceResult.status === 'cancelled') {
      setPhase('idle');
      return { status: 'cancelled' };
    }
    if (voiceResult.status === 'error') {
      return fail(voiceResult.error);
    }

    const transcript: SpeechToTextResult = {
      transcript: voiceResult.transcript,
      ...(voiceResult.language ? { language: voiceResult.language } : {}),
    };
    if (options.session.getState().decisionContext?.taskStatus === 'completed') {
      options.session.reset();
      lastAutomaticKey = undefined;
      lastReasoning = undefined;
      publish({ ...snapshot, lastAction: undefined });
    }
    publish({ ...snapshot, lastTranscript: transcript });
    if (!options.session.getState().goal) {
      options.session.setGoal(transcript.transcript);
    }
    return reasonAndGuide(transcript, runGeneration);
  };

  const retry = async (): Promise<FlowResult> => {
    if (!started || !snapshot.retryTranscript) {
      return requestVoice();
    }

    const transcript = snapshot.retryTranscript;
    activate();
    clearRetryTranscript();
    const runGeneration = beginRun();
    const preservePendingAction = Boolean(
      options.session.getState().pendingAction,
    );
    options.guide.cancel({ preservePendingAction });
    setPhase('thinking');
    return reasonAndGuide(transcript, runGeneration);
  };

  return {
    getSnapshot() {
      return {
        ...snapshot,
        page: snapshot.page
          ? {
              ...snapshot.page,
              page: { ...snapshot.page.page },
              elements: snapshot.page.elements.map((element) => ({ ...element })),
            }
          : null,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      if (started) {
        return;
      }

      started = true;
      pageSubscription = options.scanner.subscribe((semanticSnapshot) => {
        if (!taskActive) return;
        const before = pageRevision;
        refresh(semanticSnapshot);
        if (pageRevision !== before && (snapshot.phase === 'waiting' || snapshot.phase === 'idle')) {
          scheduleContinuation('page-change');
        }
      });
      interactionSubscription = options.interactions.subscribe(handleInteraction);
      planSubscription = options.reasoner.subscribePlan?.((update) => {
        if (!taskActive) return;
        stagedPlans.set(update.plan.id, update);
        if (stagedPlans.size > 3) stagedPlans.delete(stagedPlans.keys().next().value!);
        const context = options.session.getState().decisionContext;
        if (context?.plan?.id !== update.plan.id) return;
        options.session.setDecisionContext(mergePlan(context));
        if (snapshot.phase === 'waiting' && !options.session.getState().pendingAction) scheduleContinuation('page-change');
      });
      refresh();
      setPhase('idle');
      const goal = options.session.getState().goal;
      if (options.session.getState().decisionContext?.taskStatus === 'completed') {
        setPhase('success');
      } else if (goal) {
        activate();
        publish({ ...snapshot, lastTranscript: { transcript: goal } });
        scheduleContinuation('resume');
      }
    },

    stop() {
      if (!started) {
        return;
      }

      started = false;
      continuationOwner = undefined; continuationInFlight = false;
      taskActive = false;
      generation += 1;
      options.reasoner.cancel?.();
      options.reasoner.cancelPlans?.();
      planSubscription?.(); planSubscription = undefined; stagedPlans.clear();
      clearContinuation();
      pageSubscription?.();
      interactionSubscription?.();
      pageSubscription = undefined;
      interactionSubscription = undefined;
      options.scanner.stop();
      options.interactions.stop();
      options.guide.cancel();
      options.voice.cancel();
      setPhase('stopped');
    },

    reset,

    refresh,

    requestVoice,

    retry,

    cancel,
  };
}
