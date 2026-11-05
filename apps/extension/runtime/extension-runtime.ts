import type { CompanionState } from '../session/session-state';
import {
  createSemanticScanner,
  type SemanticScanner,
} from '../dom/semantic';
import {
  createElementRegistry,
  type ElementRegistry,
} from '../registry/element-registry';
import {
  createInteractionObserver,
  type InteractionObserver,
} from '../interaction/interaction-observer';
import {
  type Reasoner,
  type ReasoningPage,
} from '../reasoning/reasoning';
import {
  createSessionState,
  type SessionStateStore,
} from '../session/session-state';
import {
  createGuideController,
  type GuideController,
  type Viewport,
} from '../guide/guide-controller';
import {
  createVoiceController,
  type SpeechInput,
  type SpeechOutput,
  type VoiceController,
  type VoiceState,
} from '../voice/voice';
import {
  createFlowController,
  type FlowController,
  type FlowPhase,
} from '../flow/flow-controller';
import type { CompanionUiStore } from '../companion/companion-ui';
import {
  LATENCY_STAGE_LABELS,
  type LatencyMetric,
} from './latency';

export type ExtensionRuntimeOptions = {
  document?: Document;
  companion: CompanionUiStore;
  reasoner: Reasoner;
  speechInput: SpeechInput;
  speechOutput: SpeechOutput;
  onSessionChange?: (state: import('../session/session-state').SessionState) => void;
  initialSession?: import('../session/session-state').SessionState;
  viewport?: () => Viewport;
  prefersReducedMotion?: () => boolean;
  waitForLayout?: () => Promise<void>;
  waitForMovement?: () => Promise<void>;
  waitForPageSettled?: () => Promise<void>;
  loadingLatencyNoticeMs?: number;
  debug?: ExtensionDebugOptions;
  latency?: ExtensionLatencyOptions;
};

export const DEFAULT_LOADING_LATENCY_NOTICE_MS = 1200;

export type ExtensionDebugRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export type ExtensionDebugEvent =
  | { type: 'semantic-snapshot'; page: ReasoningPage }
  | { type: 'target-box'; targetId: string; rect: ExtensionDebugRect };

export type ExtensionDebugOptions = {
  enabled: boolean;
  logSnapshots?: boolean;
  debugTargetBoxes?: boolean;
  logger?: (event: ExtensionDebugEvent) => void;
};

export type ExtensionLatencyOptions = {
  enabled?: boolean;
  logger?: (metric: LatencyMetric) => void;
  now?: () => number;
};

export type ExtensionRuntime = {
  session: SessionStateStore;
  registry: ElementRegistry;
  scanner: SemanticScanner;
  interactions: InteractionObserver;
  voice: VoiceController;
  guide: GuideController;
  flow: FlowController;
  start(): void;
  stop(): void;
  reset(): void;
};

function toCompanionState(state: VoiceState): CompanionState {
  return state === 'transcribing' ? 'thinking' : state;
}

function toCompanionPhase(phase: FlowPhase): CompanionState | undefined {
  return phase === 'stopped' ? undefined : phase;
}

function isLatencyState(state: CompanionState): boolean {
  return state === 'thinking' || state === 'speaking';
}

function cloneReasoningPage(page: ReasoningPage): ReasoningPage {
  return {
    page: { ...page.page },
    elements: page.elements.map((element) => ({ ...element })),
  };
}

function toDebugRect(rect: DOMRect): ExtensionDebugRect {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function defaultDebugLogger(event: ExtensionDebugEvent): void {
  console.debug('[Dev - Voice Companion]', event);
}

function defaultLatencyLogger(metric: LatencyMetric): void {
  console.log('[Dev - Voice Companion latency]', {
    stage: LATENCY_STAGE_LABELS[metric.stage],
    durationMs: metric.durationMs,
    ...(metric.museCalls === undefined ? {} : { museCalls: metric.museCalls, escalationReason: metric.escalationReason }),
  });
}

export function createExtensionRuntime(
  options: ExtensionRuntimeOptions,
): ExtensionRuntime {
  const documentNode = options.document ?? document;
  const debug = options.debug?.enabled ? options.debug : undefined;
  const debugLogger = debug?.logger ?? defaultDebugLogger;
  const logSnapshots = debug?.logSnapshots !== false;
  const debugTargetBoxes = debug?.debugTargetBoxes !== false;
  const latencyEnabled = options.latency?.enabled !== false;
  const latencyLogger = options.latency?.logger ?? defaultLatencyLogger;
  let latencyRunActive = false;
  const recordLatency = (metric: LatencyMetric) => {
    if (!latencyEnabled || !latencyRunActive) {
      return;
    }
    options.companion.recordLatency(metric);
    latencyLogger(metric);
  };
  const emitDebugSnapshot = (page: ReasoningPage) => {
    if (debug && logSnapshots) {
      debugLogger({
        type: 'semantic-snapshot',
        page: cloneReasoningPage(page),
      });
    }
  };
  const emitDebugTargetBox = (targetId: string, rect: DOMRect) => {
    if (debug && debugTargetBoxes) {
      debugLogger({
        type: 'target-box',
        targetId,
        rect: toDebugRect(rect),
      });
    }
  };
  const session = createSessionState();
  if (options.initialSession) {
    session.setGoal(options.initialSession.goal);
    const context = options.initialSession.decisionContext;
    // A provider stream belongs to the old document. Restore committed steps,
    // but never wait for a tail that can no longer deliver events here.
    session.setDecisionContext(context ? { ...context, ...(context.plan ? { plan: { ...context.plan, complete: true } } : {}) } : undefined);
    session.setWorkflow(options.initialSession.workflow);
    for (const action of options.initialSession.recentActions ?? []) session.recordAction(action);
  }
  let unsubscribeSession: (() => void) | undefined;
  const registry = createElementRegistry();
  const scanner = createSemanticScanner({ root: documentNode });
  const interactions = createInteractionObserver({
    document: documentNode,
    registry,
    session,
  });
  const voice = createVoiceController({
    speechInput: options.speechInput,
    speechOutput: options.speechOutput,
    session,
    onPartial: (text) => options.companion.setTranscript(text),
    onInstruction: (text) => options.companion.setInstruction(text),
    onNotice: (text) => options.companion.setNotice(text),
    onLatency: recordLatency,
    now: options.latency?.now,
  });
  const guide = createGuideController({
    document: documentNode,
    registry,
    session,
    overlay: options.companion,
    companion: options.companion,
    speech: voice,
    viewport: options.viewport,
    prefersReducedMotion: options.prefersReducedMotion,
    waitForLayout: options.waitForLayout,
    waitForMovement: options.waitForMovement,
    onTargetRect: emitDebugTargetBox,
    onLatency: recordLatency,
    now: options.latency?.now,
  });
  const reasoner = options.reasoner;
  const flow = createFlowController({
    document: documentNode,
    scanner,
    registry,
    session,
    interactions,
    reasoner,
    guide,
    voice,
    waitForPageSettled: options.waitForPageSettled,
    onPageSnapshot: emitDebugSnapshot,
    onLatency: recordLatency,
    now: options.latency?.now,
  });
  const loadingLatencyNoticeMs = Math.max(
    0,
    options.loadingLatencyNoticeMs ?? DEFAULT_LOADING_LATENCY_NOTICE_MS,
  );

  let unsubscribeVoice: (() => void) | undefined;
  let unsubscribeFlow: (() => void) | undefined;
  let latencyTimer: ReturnType<typeof setTimeout> | undefined;
  let latencyState: CompanionState | undefined;

  const clearLatencyNotice = () => {
    if (latencyTimer !== undefined) {
      clearTimeout(latencyTimer);
      latencyTimer = undefined;
    }
    latencyState = undefined;
    options.companion.setLatencyNotice(false);
  };

  const publishCompanionState = (state: CompanionState) => {
    options.companion.setState(state);
    if (!isLatencyState(state)) {
      clearLatencyNotice();
      return;
    }

    if (latencyState === state) {
      return;
    }

    if (latencyTimer !== undefined) {
      clearTimeout(latencyTimer);
    }
    latencyState = state;
    options.companion.setLatencyNotice(false);
    latencyTimer = setTimeout(() => {
      latencyTimer = undefined;
      if (latencyState === state) {
        options.companion.setLatencyNotice(true);
      }
    }, loadingLatencyNoticeMs);
  };

  const handleListening = () => {

    if (
      voice.getState() === 'listening' ||
      voice.getState() === 'transcribing' ||
      voice.getState() === 'thinking' ||
      voice.getState() === 'guiding' ||
      voice.getState() === 'speaking' ||
      flow.getSnapshot().phase === 'thinking' ||
      flow.getSnapshot().phase === 'guiding'
    ) {
      handleStop();
      return;
    }
    latencyRunActive = true;
    options.companion.clearLatencyMetrics();
    void flow.requestVoice();
  };
  const handleRetry = () => {
    latencyRunActive = true;
    options.companion.clearLatencyMetrics();
    options.companion.setNotice('');
    void flow.retry();
  };
  const handleStop = () => {
    clearLatencyNotice();
    latencyRunActive = false;
    options.companion.clearLatencyMetrics();
    flow.cancel();
    options.companion.setInstruction('');
    options.companion.setTranscript('');
    options.companion.setNotice('');
    options.companion.setTaskActive(false);
  };
  options.companion.setListeningHandler(handleListening);
  options.companion.setStopHandler(handleStop);
  options.companion.setRetryHandler(handleRetry);
  options.companion.setFinishRecordingHandler(() => { if (voice.getState() === 'listening') voice.stopListening(); });

  let started = false;
  return {
    session,
    registry,
    scanner,
    interactions,
    voice,
    guide,
    flow,

    start() {
      if (started) {
        return;
      }
      started = true;
      latencyRunActive = false;
      unsubscribeVoice = voice.subscribe((state) => {
        publishCompanionState(toCompanionState(state));
      });
      unsubscribeFlow = flow.subscribe((snapshot) => {
        options.companion.setTaskActive(Boolean(snapshot.taskActive));
        const companionState = toCompanionPhase(snapshot.phase);
        if (snapshot.error) options.companion.setNotice(snapshot.error.message);
        if (companionState) {
          publishCompanionState(companionState);
        }
      });
      options.companion.setListeningHandler(handleListening);
      options.companion.setStopHandler(handleStop);
      options.companion.setFinishRecordingHandler(() => { if (voice.getState() === 'listening') voice.stopListening(); });
      options.companion.setRetryHandler(handleRetry);
      unsubscribeSession = session.subscribe((state) => options.onSessionChange?.(state));
      flow.start();
      options.companion.clearLatencyMetrics();
    },

    stop() {
      if (!started) {
        return;
      }
      started = false;
      latencyRunActive = false;
      clearLatencyNotice();
      options.companion.clearLatencyMetrics();
      unsubscribeSession?.();
      flow.stop();
      options.companion.setListeningHandler(undefined);
      options.companion.setStopHandler(undefined);
      options.companion.setFinishRecordingHandler(undefined);
      options.companion.setRetryHandler(undefined);
      unsubscribeVoice?.();
      unsubscribeFlow?.();
      unsubscribeVoice = undefined;
      unsubscribeFlow = undefined;
    },

    reset() {
      clearLatencyNotice();
      latencyRunActive = false;
      options.companion.clearLatencyMetrics();
      flow.reset();
    },
  };
}
