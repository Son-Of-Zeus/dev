import { containsExecutableText, redactSensitiveText } from '../safety/safety';

export type SemanticStep = {
  targetDescription: string;
  spokenInstruction: string;
  language: 'en-IN' | 'hi-IN';
  consequence?: string;
};

export type PlannedStep = SemanticStep & { precondition: string; expectedOutcome: string };
export type SemanticPlan = { id: string; steps: PlannedStep[]; currentStepIndex: number; complete?: boolean };

export type DecisionContext = {
  taskStatus: 'active' | 'completed';
  goal?: string;
  step?: SemanticStep;
  plan?: SemanticPlan;
  awaitingInputCompletion?: boolean;
  /** Retired: accepted from old sessions and removed during validation. */
  awaitingConfirmation?: boolean;
  inputComplete?: boolean;
};

export type RequestTrigger = 'user' | 'manual-action' | 'page-change' | 'resume';

export function validateTrigger(value: unknown): RequestTrigger {
  if (!['user', 'manual-action', 'page-change', 'resume'].includes(value as string)) {
    throw new Error('Invalid reasoning trigger');
  }
  return value as RequestTrigger;
}

export function validateDecisionContext(value: unknown): DecisionContext {
  const record = (item: unknown, keys: string[]): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some((key) => !keys.includes(key))) throw new Error('Invalid decision context');
    return item as Record<string, unknown>;
  };
  const text = (item: unknown, limit: number): string => {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > limit ||
      containsExecutableText(item)) {
      throw new Error('Invalid decision context text');
    }
    return redactSensitiveText(item.trim());
  };
  const source = record(value, ['taskStatus', 'goal', 'step', 'plan', 'awaitingInputCompletion', 'awaitingConfirmation', 'inputComplete']);
  if (source.taskStatus !== 'active' && source.taskStatus !== 'completed') throw new Error('Invalid task status');
  for (const key of ['awaitingConfirmation', 'inputComplete', 'awaitingInputCompletion']) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') throw new Error('Invalid decision flag');
  }
  let step: SemanticStep | undefined;
  if (source.step !== undefined) {
    const saved = record(source.step, ['targetDescription', 'spokenInstruction', 'language', 'consequence']);
    if (saved.language !== 'en-IN' && saved.language !== 'hi-IN') throw new Error('Invalid step language');
    step = {
      targetDescription: text(saved.targetDescription, 240),
      spokenInstruction: text(saved.spokenInstruction, 240),
      language: saved.language,
      ...(saved.consequence === undefined ? {} : { consequence: text(saved.consequence, 240) }),
    };
  }
  let plan: SemanticPlan | undefined;
  if (source.plan !== undefined) {
    const saved = record(source.plan, ['id', 'steps', 'currentStepIndex', 'complete']);
    if (!Array.isArray(saved.steps) || saved.steps.length < 1 || saved.steps.length > 3 ||
      !Number.isInteger(saved.currentStepIndex) || (saved.currentStepIndex as number) < 0 || (saved.currentStepIndex as number) > saved.steps.length) throw new Error('Invalid plan bounds');
    if (saved.complete !== undefined && typeof saved.complete !== 'boolean') throw new Error('Invalid plan completion');
    plan = { id: text(saved.id, 80), complete: saved.complete === undefined ? true : saved.complete as boolean, currentStepIndex: saved.currentStepIndex as number,
      steps: saved.steps.map((item) => {
        const entry = record(item, ['targetDescription', 'spokenInstruction', 'language', 'consequence', 'precondition', 'expectedOutcome']);
        const { precondition, expectedOutcome, ...semantic } = entry;
        const step = validateDecisionContext({ taskStatus: 'active', step: semantic }).step!;
        return { ...step, precondition: text(precondition, 240), expectedOutcome: text(expectedOutcome, 240) };
      }) };
  }
  if (plan) {
    const current = plan.steps[plan.currentStepIndex];
    step = current ? { targetDescription: current.targetDescription, spokenInstruction: current.spokenInstruction, language: current.language, ...(current.consequence ? { consequence: current.consequence } : {}) } : undefined;
  }
  return {
    taskStatus: source.taskStatus,
    ...(source.goal === undefined ? {} : { goal: text(source.goal, 2000) }),
    ...(step ? { step } : {}),
    ...(plan ? { plan } : {}),
    ...(source.awaitingInputCompletion === undefined ? {} : { awaitingInputCompletion: source.awaitingInputCompletion as boolean }),
    ...(source.inputComplete === undefined ? {} : { inputComplete: source.inputComplete as boolean }),
  };
}
