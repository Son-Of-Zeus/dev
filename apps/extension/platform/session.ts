import { validateDecisionContext } from '../reasoning/decision-context';
import type { SessionState } from '../session/session-state';
import { redactSensitiveText } from '../safety/safety';
import { validateGuideAction } from '../reasoning/reasoning';

export function webOrigin(url?: string): string | undefined {
  try { const parsed = new URL(url ?? ''); return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname !== 'chromewebstore.google.com' ? parsed.origin : undefined; } catch { return undefined; }
}
export function safeSession(value: unknown): SessionState {
  const source = value && typeof value === 'object' ? value as Partial<SessionState> : {};
  const state: SessionState = { companionState: 'idle', recentActions: [] };
  if (typeof source.goal === 'string' && source.goal.trim()) state.goal = redactSensitiveText(source.goal).slice(0, 2000);
  if (Array.isArray(source.recentActions)) state.recentActions = source.recentActions.slice(-8).filter((action) => ['click', 'input', 'select', 'explanation'].includes(action.type)).map((action) => ({ type: action.type, timestamp: Number.isFinite(action.timestamp) ? action.timestamp : 0, ...(typeof action.label === 'string' ? { label: redactSensitiveText(action.label).slice(0, 160) } : {}) }));
  if (source.decisionContext) {
    try {
      const context = validateDecisionContext(source.decisionContext);
      delete context.inputComplete;
      state.decisionContext = context;
    } catch { /* Discard invalid semantic context. */ }
  }
  if (source.workflow) {
    // Reuse the strict readiness validator; never persist pending DOM IDs.
    try {
      const workflow = JSON.parse(JSON.stringify(source.workflow), (_key, item) => typeof item === 'string' ? redactSensitiveText(item) : item);
      const action = validateGuideAction({ action: 'wait', workflow }, []);
      state.workflow = action.workflow;
    } catch { /* Discard malformed planning memory. */ }
  }
  return state;
}
export type TabSession = { origin: string; activationId?: string; documentId?: string; sessionRevision?: number; state: SessionState };
