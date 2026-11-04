import { validateDecisionContext, type DecisionContext } from '../reasoning/decision-context';
import { redactSensitiveText } from '../safety/safety';
export const DEFAULT_RECENT_ACTION_LIMIT = 8;

export type RecentActionType =
  | 'click'
  | 'input'
  | 'select'
  | 'explanation';

export type ExpectedUserAction = 'click' | 'input' | 'select';

export type CompanionState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'guiding'
  | 'speaking'
  | 'waiting'
  | 'success'
  | 'error';

export type RecentAction = {
  type: RecentActionType;
  label?: string;
  timestamp: number;
};

export type PendingAction = {
  targetId: string;
  expectedUserAction: ExpectedUserAction;
};

/**
 * Bounded intent-planning metadata. It contains conversational requirement
 * names/status only; page-entry progress remains local to the pending action
 * and recent semantic actions. Never store the user's actual values here.
 */
export type IntentReadiness = {
  intent?: string;
  requiredInformation: string[];
  knownInformation: string[];
  missingInformation: string[];
  readiness: 'ready' | 'needs_clarification' | 'not_applicable';
  clarifyingQuestion?: string;
};

export type SessionState = {
  storageRevision?: number;
  goal?: string;
  recentActions: RecentAction[];
  pendingAction?: PendingAction;
  workflow?: IntentReadiness;
  decisionContext?: DecisionContext;
  companionState: CompanionState;
};

export type RecordActionInput = {
  type: RecentActionType;
  label?: string;
  timestamp?: number;
};

export type SessionStateOptions = {
  recentActionLimit?: number;
  now?: () => number;
};

export interface SessionStateStore {
  getState(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  setGoal(goal?: string): void;
  recordAction(action: RecordActionInput): void;
  setPendingAction(pendingAction?: PendingAction): void;
  clearPendingAction(): void;
  setWorkflow(workflow?: IntentReadiness): void;
  setDecisionContext(context?: DecisionContext): void;
  setCompanionState(companionState: CompanionState): void;
  reset(): void;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value ? redactSensitiveText(value).replace(/\s+/g, ' ').trim().slice(0, 2000) : undefined;
  return normalized || undefined;
}

function normalizeWorkflowText(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  return normalized?.replace(
    /(?:₹|rs\.?|inr|\$|€|£)\s*[\d,]+(?:\.\d+)?|\b\d{5,18}\b/gi,
    '[redacted]',
  );
}

function cloneState(state: SessionState): SessionState {
  return {
    goal: state.goal,
    ...(state.decisionContext ? { decisionContext: validateDecisionContext(state.decisionContext) } : {}),
    recentActions: state.recentActions.map((action) => ({ ...action })),
    pendingAction: state.pendingAction ? { ...state.pendingAction } : undefined,
    workflow: state.workflow
      ? {
          ...state.workflow,
          requiredInformation: [...state.workflow.requiredInformation],
          knownInformation: [...state.workflow.knownInformation],
          missingInformation: [...state.workflow.missingInformation],
        }
      : undefined,
    companionState: state.companionState,
  };
}

function createInitialState(): SessionState {
  return {
    recentActions: [],
    companionState: 'idle',
  };
}

export function createSessionState(
  options: SessionStateOptions = {},
): SessionStateStore {
  const recentActionLimit = Math.max(
    1,
    Math.floor(options.recentActionLimit ?? DEFAULT_RECENT_ACTION_LIMIT),
  );
  const now = options.now ?? Date.now;
  const listeners = new Set<(state: SessionState) => void>();
  let state = createInitialState();

  const publish = (nextState: SessionState) => {
    state = nextState;
    const snapshot = cloneState(state);
    listeners.forEach((listener) => listener(snapshot));
  };

  return {
    getState() {
      return cloneState(state);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setGoal(goal) {
      const normalizedGoal = normalizeText(goal);
      if (normalizedGoal === state.goal) {
        return;
      }

      publish({ ...state, goal: normalizedGoal });
    },

    recordAction(action) {
      const label = normalizeText(action.label);
      const timestamp = action.timestamp ?? now();
      const nextAction: RecentAction = {
        type: action.type,
        timestamp,
        ...(label ? { label } : {}),
      };

      publish({
        ...state,
        recentActions: [...state.recentActions, nextAction].slice(
          -recentActionLimit,
        ),
      });
    },

    setPendingAction(pendingAction) {
      if (
        pendingAction &&
        pendingAction.targetId === state.pendingAction?.targetId &&
        pendingAction.expectedUserAction ===
          state.pendingAction.expectedUserAction
      ) {
        return;
      }

      publish({
        ...state,
        pendingAction: pendingAction
          ? { ...pendingAction }
          : undefined,
      });
    },

    clearPendingAction() {
      if (!state.pendingAction) {
        return;
      }

      publish({ ...state, pendingAction: undefined });
    },

    setWorkflow(workflow) {
      if (!workflow) {
        if (!state.workflow) {
          return;
        }
        publish({ ...state, workflow: undefined });
        return;
      }

      const intent = normalizeWorkflowText(workflow.intent);
      const clarifyingQuestion = normalizeWorkflowText(
        workflow.clarifyingQuestion,
      );

      publish({
        ...state,
        workflow: {
          ...(intent ? { intent } : {}),
          requiredInformation: workflow.requiredInformation
            .map(normalizeWorkflowText)
            .filter((item): item is string => Boolean(item)),
          knownInformation: workflow.knownInformation
            .map(normalizeWorkflowText)
            .filter((item): item is string => Boolean(item)),
          missingInformation: workflow.missingInformation
            .map(normalizeWorkflowText)
            .filter((item): item is string => Boolean(item)),
          readiness: workflow.readiness,
          ...(clarifyingQuestion ? { clarifyingQuestion } : {}),
        },
      });
    },

    setDecisionContext(context) {
      const safe = context ? validateDecisionContext(context) : undefined;
      if (safe) delete safe.inputComplete;
      publish({ ...state, decisionContext: safe });
    },

    setCompanionState(companionState) {
      if (companionState === state.companionState) {
        return;
      }

      publish({ ...state, companionState });
    },

    reset() {
      publish(createInitialState());
    },
  };
}
