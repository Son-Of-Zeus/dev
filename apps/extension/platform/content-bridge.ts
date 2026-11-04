import { browser } from 'wxt/browser';
import { validateDecisionContext } from '../reasoning/decision-context';
import { sanitizeReasonRequest, validateGuideAction, ReasoningRequestError, type PlanUpdate, type Reasoner } from '../reasoning/reasoning';
import type { SpeechInput, SpeechOutput } from '../voice/voice';
import type { LatencyMetric } from '../runtime/latency';

export async function backgroundRequest(op: string, data: Record<string, unknown> = {}) {
  const result = await browser.runtime.sendMessage({ target: 'background', op, ...data });
  if (!result?.ok) throw Object.assign(new ReasoningRequestError(result?.error ?? 'Extension service is unavailable.', result?.status), { code: result?.code });
  return result.data;
}
export function createContentBridge(onLatency: (metric: LatencyMetric) => void = () => {}, onInactiveDocument: () => void = () => {}) {
  let inactive = false;
  const clientId = crypto.randomUUID();
  let workEpoch = 0;
  let workBarrier: Promise<unknown> = Promise.resolve();
  const request = async (op: string, data: Record<string, unknown> = {}) => {
    if (inactive) throw Object.assign(new Error('The page changed.'), { code: 'STALE_DOCUMENT' });
    const epoch = workEpoch;
    await workBarrier;
    try { return await backgroundRequest(op, { ...data, clientId, workEpoch: epoch }); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'STALE_DOCUMENT' && !inactive) { inactive = true; onInactiveDocument(); }
      throw error;
    }
  };
  let speechId: string | undefined;
  let reasonId: string | undefined;
  const streamIds = new Set<string>();
  const planListeners = new Set<(update: PlanUpdate) => void>();
  let partial: ((text: string) => void) | undefined;
  const metric = (value: any) => {
    if (value && ['assessment', 'planning', 'selection', 'first-step', 'first-guidance', 'plan-completion'].includes(value.stage) && Number.isFinite(value.durationMs) && value.durationMs >= 0) onLatency(value);
  };
  const listener = (message: any) => {
    if (!inactive && message?.target === 'content' && message.type === 'reason-event' && streamIds.has(message.requestId)) {
      const event = message.event;
      if (event?.type === 'diagnostic') metric(event.metric);
      if (event?.type === 'plan' || event?.type === 'plan-failed') {
        try {
          const plan = validateDecisionContext({ taskStatus: 'active', plan: event.plan }).plan!;
          for (const listener of planListeners) listener({ plan, ...(event.failed || event.type === 'plan-failed' ? { failed: true } : {}) });
        } catch { /* Invalid late data must not change the task. */ }
      }
      if (event?.type === 'done' || event?.type === 'plan-failed') streamIds.delete(message.requestId);
    }
    if (message?.target === 'content' && message.type === 'partial' && message.requestId === speechId && typeof message.transcript === 'string') partial?.(message.transcript);
  };
  browser.runtime.onMessage.addListener(listener);
  const speechInput: SpeechInput = {
    async listen(onPartial) {
      const requestId = crypto.randomUUID(); speechId = requestId; partial = onPartial;
      try { return await request('speech-start', { requestId }); }
      finally { if (speechId === requestId) { speechId = undefined; partial = undefined; } }
    },
    stop() { if (speechId) void request('speech-stop', { requestId: speechId }).catch(() => {}); },
    cancel() { if (speechId) void request('speech-cancel', { requestId: speechId }).catch(() => {}); speechId = undefined; partial = undefined; },
  };
  const speechOutput: SpeechOutput = {
    speak: (text, language) => request('speak', { text, language }),
    cancel() { void request('cancel-output').catch(() => {}); },
  };
  const reasoner: Reasoner = {
    cancel() {
      if (reasonId) { streamIds.delete(reasonId); void request('cancel-reason', { requestId: reasonId }).catch(() => {}); }
      reasonId = undefined;
    },
    cancelPlans() {
      streamIds.clear(); workEpoch++;
      if (!inactive) workBarrier = backgroundRequest('stop-work', { clientId, workEpoch }).catch(() => {});
    },
    subscribePlan(listener) { planListeners.add(listener); return () => { planListeners.delete(listener); }; },
    async reason(input) {
      const safe = sanitizeReasonRequest(input);
      const requestId = crypto.randomUUID(); reasonId = requestId; streamIds.add(requestId);
      try {
        const result = await request('reason-stream', { request: safe, requestId });
        if (reasonId !== requestId) throw new Error('Reasoning cancelled.');
        reasonId = undefined;
        const action = validateGuideAction(result.action, safe.page.elements.map((element) => element.id), safe.page.elements);
        const context = action.decisionContext;
        if ((context?.goal && context.goal !== safe.session.goal) ||
          (safe.session.decisionContext?.plan && context?.plan?.id !== safe.session.decisionContext.plan.id)) {
          for (const id of streamIds) if (id !== requestId) {
            streamIds.delete(id); void request('cancel-plan', { requestId: id }).catch(() => {});
          }
        }
        for (const timing of result.timings ?? []) metric(timing);
        return action;
      } catch (error) {
        streamIds.delete(requestId);
        if (reasonId === requestId) reasonId = undefined;
        throw error;
      }
    },
  };
  return { speechInput, speechOutput, reasoner, destroy() { reasoner.cancel?.(); reasoner.cancelPlans?.(); planListeners.clear(); speechInput.cancel(); speechOutput.cancel(); browser.runtime.onMessage.removeListener(listener); } };
}
