import { ModelFailure, providerFailure } from './reasoning-errors.js';
import { randomUUID } from 'node:crypto';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { createBasetenPlanner } from './baseten-adapter.js';
import { buildTargetQuestions, DEFAULT_JEV_MODEL, readTargetAnswer } from './target-questions.js';
import { buildAssessmentQuestions, readAssessment, YES, NO, COMPLETION } from './assessment-questions.js';
import { classifyConsequence, validateGuideAction } from './contracts.js';

export class MissingTargetError extends Error {
  code = 'TARGET_NOT_FOUND';
}

const READY = { requiredInformation: [], knownInformation: [], missingInformation: [], readiness: 'ready' };

function routineInstruction(target, language) {
  if (language === 'hi-IN') {
    if (target.role === 'textbox') return `${target.label} भरें। पूरा होने पर “हो गया” कहें।`;
    if (target.role === 'combobox') return `${target.label} में विकल्प चुनें।`;
    return `${target.label} पर क्लिक करें।`;
  }
  if (target.role === 'textbox') return `Enter ${target.label}. Say “done” when finished.`;
  if (target.role === 'combobox') return `Choose an option in ${target.label}.`;
  return `Click ${target.label}.`;
}

export function createReasoner(options = {}) {
  const planner = options.planner ?? createBasetenPlanner(options.baseten);
  let client = options.client;
  return {
    async reason(request, { signal, onTiming, onDecision, onPlan, onBackground } = {}) {
      const previous = request.session.decisionContext;
      const previousPlan = previous?.plan;
      const isUser = (request.trigger ?? 'user') === 'user';
      let museCalls = 0;
      let escalationReason = 'none';
      const ask = async (query, stage) => {
        client ??= new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY });
        const start = performance.now();
        let result;
        try { result = await client.systemOne({ model: process.env.TYPESAFE_MODEL ?? DEFAULT_JEV_MODEL, state: query.state, questions: query.questions }, {
          signal, timeout: 15_000, retry: { maxRetries: 2 },
          ...(Buffer.byteLength(JSON.stringify(query.state)) > 40_000 ? { headers: { 'TypeSafe-Danger-Zone-Long-Context': 'true' } } : {}),
        });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw providerFailure(error, 'Jev');
        }
        signal?.throwIfAborted();
        onTiming?.(stage, performance.now() - start);
        return result.answers;
      };
      const candidates = request.page.elements.filter((element) => element.visible && !element.disabled);
      const query = buildAssessmentQuestions(request, candidates);
      const answers = await ask(query, 'assessment');
      let assessment;
      try { assessment = readAssessment(answers, Boolean(previous?.step)); }
      catch (error) { throw new ModelFailure('ASSESSMENT_INVALID_RESPONSE', 'Jev', error); }
      const replacing = isUser && assessment.newTask >= YES;
      const goal = replacing ? request.userUtterance : request.session.goal ?? request.userUtterance;
      const language = assessment.language;
      const inputComplete = isUser && !replacing && (request.session.pendingAction?.type === 'input' || previous?.awaitingInputCompletion) && assessment.inputComplete >= YES;
      const context = { taskStatus: 'active', goal,
        ...(!replacing && previous?.step ? { step: previous.step } : {}),
        ...(!replacing && previousPlan ? { plan: { ...previousPlan, steps: [...previousPlan.steps] } } : {}),
        ...(!replacing && previous?.awaitingInputCompletion ? { awaitingInputCompletion: !inputComplete } : {}),
        ...(inputComplete ? { inputComplete: true } : {}),
      };
      const finish = (action, extra = {}) => {
        onDecision?.({ museCalls, escalationReason });
        return validateGuideAction({ ...action, decisionContext: { ...context, ...(action.action === 'guide' ? { awaitingInputCompletion: action.expectedUserAction === 'input' } : {}), ...extra } }, request.page.elements);
      };
      const clarify = (english, hindi, extra = {}) => finish({ action: 'clarify', language, spokenInstruction: language === 'hi-IN' ? hindi : english }, extra);
      const wait = () => finish({ action: 'wait' });
      if (previous?.taskStatus === 'completed' && !isUser) return finish({ action: 'wait' }, { taskStatus: 'completed', step: undefined, plan: undefined, awaitingInputCompletion: false });

      // Completing an input unlocks the next step, never the task completion gate.
      const inputPending = !replacing && (request.session.pendingAction?.type === 'input' || previous?.awaitingInputCompletion) && !inputComplete;
      if (inputPending && (!isUser || assessment.explanation < YES)) return wait();
      const completion = replacing ? assessment.requestComplete : assessment.goalComplete;
      const hasPageEvidence = Boolean(request.page.title || request.page.section || request.page.status || request.page.evidence?.length);
      if (!inputPending && !inputComplete && assessment.blockingError <= NO &&
        hasPageEvidence && completion >= COMPLETION) {
        return finish({ action: 'success', language, spokenInstruction: language === 'hi-IN' ? 'काम पूरा हो गया।' : 'Task complete.' }, { taskStatus: 'completed', step: undefined, plan: undefined, awaitingInputCompletion: false });
      }

      let target;
      let savedStep;
      let attemptingSelection = false;
      const explanation = isUser && assessment.explanation >= YES;
      const readSelection = (selectionAnswers, ids) => {
        const selection = readTargetAnswer(selectionAnswers, ids);
        if (selection.status === 'missing') throw new MissingTargetError('The requested control is not available.');
        return selection.status === 'selected' ? candidates.find((item) => item.id === selection.targetId) : undefined;
      };
      const judgment = (name) => {
        const value = answers[name]?.noul;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ModelFailure('ASSESSMENT_INVALID_RESPONSE', 'Jev');
        return value;
      };
      let planAdvanced = false;
      if (!explanation && !replacing && previousPlan && previousPlan.currentStepIndex < previousPlan.steps.length && assessment.blockingError <= NO &&
        (inputComplete || (hasPageEvidence && judgment('stepComplete') >= YES))) {
        planAdvanced = true;
        context.plan.currentStepIndex++;
        delete context.step;
        const next = context.plan.steps[context.plan.currentStepIndex];
        if (next) {
          if (judgment('nextApplicable') < YES) {
            if (assessment.nextStepVisible < YES) return wait();
            delete context.plan;
          } else if (candidates.length) {
            attemptingSelection = true;
            target = readSelection({ target: answers.nextTarget, exists: answers.nextExists }, query.ids);
            savedStep = next;
          } else return wait();
        }
      }
      if (!planAdvanced && !explanation && isUser && assessment.direct >= YES && candidates.length) {
        delete context.plan;
        attemptingSelection = true;
        target = readSelection(answers, query.ids);
      } else if (!planAdvanced && !explanation && !inputComplete && !replacing && previous?.step && assessment.blockingError <= NO && assessment.reuseStep >= YES && candidates.length) {
        attemptingSelection = true;
        target = readSelection({ target: answers.savedTarget, exists: answers.savedExists }, query.ids);
        savedStep = previous.step;
      }
      if (attemptingSelection) {
        if (!target) return clarify('Which control do you mean?', 'आपको कौन सा नियंत्रण चाहिए?');
        if (!classifyConsequence(target.label) || savedStep?.consequence) {
          const instruction = savedStep?.spokenInstruction ?? routineInstruction(target, language);
          const step = savedStep ?? { targetDescription: `${target.role}: ${target.label}${target.section ? ` in ${target.section}` : ''}`, spokenInstruction: instruction, language };
          // Long labels need a short semantic description from Muse, never a cut sentence.
          if (instruction.length <= 240 && step.targetDescription.length <= 240) {
            return finish({
              action: 'guide', targetId: target.id, spokenInstruction: instruction,
              language: savedStep?.language ?? language, workflow: READY,
              expectedUserAction: target.role === 'textbox' ? 'input' : target.role === 'combobox' ? 'select' : 'click',
              ...(step.consequence ? { consequence: step.consequence } : {}),
            }, { step: Object.fromEntries(Object.entries(step).filter(([key]) => !['precondition', 'expectedOutcome'].includes(key))) });
          }
        }
      }
      if (!explanation && !replacing && request.session.pendingAction && !inputComplete) return wait();
      if (!isUser && assessment.nextStepVisible < YES && assessment.blockingError <= NO) return wait();
      if (!explanation && context.plan && context.plan.currentStepIndex >= context.plan.steps.length && context.plan.complete === false) return wait();
      escalationReason = explanation ? 'explanation' : target && classifyConsequence(target.label) ? 'consequence' : 'new-step';
      museCalls += 1;
      const start = performance.now();
      const planningRequest = { ...request, session: { ...request.session, goal, decisionContext: { ...context },
        ...(replacing ? { pendingAction: undefined, workflow: undefined, decisionContext: undefined } : {}),
        ...(inputComplete ? { pendingAction: undefined } : {}),
      } };
      let plan;
      if (onPlan && planner.stream) {
        let resolveFirst;
        let rejectFirst;
        const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
        let committedPlan;
        let firstDelivered = false;
        const pump = (async () => {
          try {
            for await (const record of planner.stream(planningRequest, signal)) {
              signal?.throwIfAborted();
              if (record.decision.action === 'guide') {
                const decision = record.decision;
                const step = { targetDescription: decision.targetDescription, spokenInstruction: decision.spokenInstruction, language: decision.language,
                  ...(decision.consequence ? { consequence: decision.consequence } : {}), precondition: record.precondition, expectedOutcome: record.expectedOutcome };
                committedPlan ??= { id: randomUUID(), steps: [], currentStepIndex: 0, complete: false };
                committedPlan.steps.push(step);
                onPlan({ plan: structuredClone(committedPlan) });
              }
              if (record.sequence === 1) {
                if (committedPlan) context.plan = committedPlan;
                onTiming?.('first-step', performance.now() - start);
                firstDelivered = true;
                resolveFirst(record.decision);
              }
            }
            if (!firstDelivered) throw new Error('Planner returned no steps.');
            if (committedPlan) { committedPlan.complete = true; onPlan({ plan: structuredClone(committedPlan) }); }
            onTiming?.('plan-completion', performance.now() - start);
          } catch (error) {
            if (!firstDelivered) rejectFirst(error);
            else if (committedPlan) onPlan({ plan: structuredClone(committedPlan), failed: true });
          }
        })();
        onBackground?.(pump);
        plan = await first;
      } else plan = await planner.plan(planningRequest, signal);
      signal?.throwIfAborted();
      onTiming?.('planning', performance.now() - start);
      if (inputPending && plan.action !== 'explain') return wait();
      if (plan.action === 'success') return wait();
      if (plan.targetDescription) {
        const available = request.page.elements.filter((element) => element.visible && (plan.action === 'explain' || !element.disabled));
        if (!available.length) throw new MissingTargetError('No matching control is available.');
        const selectionQuery = buildTargetQuestions(plan.targetDescription, available);
        const selection = readTargetAnswer(await ask(selectionQuery, 'selection'), selectionQuery.ids);
        if (selection.status === 'missing') throw new MissingTargetError('The requested control is not available.');
        if (selection.status === 'uncertain') return clarify('Which control do you mean?', 'आपको कौन सा नियंत्रण चाहिए?');
        target = available.find((element) => element.id === selection.targetId);
      }
      const action = { action: plan.action, workflow: plan.workflow };
      if (plan.targetDescription && target) action.targetId = target.id;
      if (plan.spokenInstruction) Object.assign(action, { spokenInstruction: plan.spokenInstruction, language: plan.language });
      if (plan.action === 'guide') {
        action.expectedUserAction = target.role === 'textbox' ? 'input' : target.role === 'combobox' ? 'select' : 'click';
        if (plan.consequence) action.consequence = plan.consequence;
        context.awaitingInputCompletion = target.role === 'textbox';
        context.step = { targetDescription: plan.targetDescription, spokenInstruction: plan.spokenInstruction, language: plan.language, ...(plan.consequence ? { consequence: plan.consequence } : {}) };
      } else if (!['explain', 'wait'].includes(plan.action)) delete context.step;
      return finish(action);
    },
  };
}
