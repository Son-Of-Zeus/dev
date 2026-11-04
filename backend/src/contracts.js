const SEMANTIC_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'tab',
  'interactive',
]);

const VALIDATION_STATES = new Set(['valid', 'invalid', 'unknown']);
const EXPECTED_ACTIONS = new Set(['click', 'input', 'select']);
const READINESS_STATES = new Set([
  'ready',
  'needs_clarification',
  'not_applicable',
]);
const MAX_TEXT_LENGTH = 2_000;
const MAX_GUIDANCE_INSTRUCTION_LENGTH = 240;
const MAX_EXPLANATION_LENGTH = 2_500;
const MAX_CONSEQUENCE_LENGTH = 240;
const MAX_CLARIFYING_QUESTION_LENGTH = 240;
const MAX_READINESS_ITEM_LENGTH = 120;
const MAX_READINESS_ITEMS = 12;

export class ContractValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ContractValidationError';
    this.details = details;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) {
    throw new ContractValidationError(`${field} must be an object`);
  }
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(`${field} must be an array`);
  }
  return value;
}

function requireString(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractValidationError(`${field} must be a non-empty string`, { field, rule: 'nonempty_string' });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ContractValidationError(`${field} exceeds its maximum length`, { field, rule: 'length' });
  }
  return normalized;
}

function optionalString(value, field, maxLength = MAX_TEXT_LENGTH) {
  return value === undefined
    ? undefined
    : requireString(value, field, maxLength);
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ContractValidationError(`${field} must be a boolean`);
  }
  return value;
}

function validateReadinessItems(value, field) {
  const items = requireArray(value, field);
  if (items.length > MAX_READINESS_ITEMS) {
    throw new ContractValidationError(`${field} exceeds the maximum count`);
  }

  return items.map((item, index) =>
    requireString(item, `${field}[${index}]`, MAX_READINESS_ITEM_LENGTH),
  );
}

function requireAllowedKeys(value, allowedKeys, field) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new ContractValidationError(`${field} contains unexpected field: ${unexpected}`);
  }
}

function validateSemanticElement(value, index) {
  const element = requireRecord(value, `page.elements[${index}]`);
  requireAllowedKeys(
    element,
    [
      'id',
      'role',
      'label',
      'section',
      'visible',
      'inViewport',
      'disabled',
      'hasValue',
      'validationState',
    ],
    `page.elements[${index}]`,
  );

  const role = requireString(element.role, `page.elements[${index}].role`, 24);
  if (!SEMANTIC_ROLES.has(role)) {
    throw new ContractValidationError(`page.elements[${index}].role is not supported`);
  }
  const validationState = optionalString(
    element.validationState,
    `page.elements[${index}].validationState`,
    12,
  );
  if (validationState !== undefined && !VALIDATION_STATES.has(validationState)) {
    throw new ContractValidationError(
      `page.elements[${index}].validationState is not supported`,
    );
  }

  return {
    id: requireString(element.id, `page.elements[${index}].id`, 80),
    role,
    label: requireString(element.label, `page.elements[${index}].label`),
    ...(element.section !== undefined
      ? { section: requireString(element.section, `page.elements[${index}].section`) }
      : {}),
    visible: requireBoolean(element.visible, `page.elements[${index}].visible`),
    inViewport: requireBoolean(
      element.inViewport,
      `page.elements[${index}].inViewport`,
    ),
    disabled: requireBoolean(element.disabled, `page.elements[${index}].disabled`),
    ...(element.hasValue !== undefined
      ? { hasValue: requireBoolean(element.hasValue, `page.elements[${index}].hasValue`) }
      : {}),
    ...(validationState !== undefined ? { validationState } : {}),
  };
}

/**
 * Validate the model's generic intent/readiness assessment.
 *
 * This metadata contains intent-level requirement names and status only. Page
 * entry fields are completed locally by the user and must not be represented
 * as missing conversational information or used as a transport for values.
 */
export function validateIntentReadiness(value, field = 'workflow') {
  const workflow = requireRecord(value, field);
  requireAllowedKeys(
    workflow,
    [
      'intent',
      'requiredInformation',
      'knownInformation',
      'missingInformation',
      'readiness',
      'clarifyingQuestion',
    ],
    field,
  );

  const intent =
    workflow.intent === null || workflow.intent === undefined
      ? undefined
      : requireString(workflow.intent, `${field}.intent`, 160);
  const requiredInformation = validateReadinessItems(
    workflow.requiredInformation,
    `${field}.requiredInformation`,
  );
  const knownInformation = validateReadinessItems(
    workflow.knownInformation,
    `${field}.knownInformation`,
  );
  const missingInformation = validateReadinessItems(
    workflow.missingInformation,
    `${field}.missingInformation`,
  );
  const readiness = requireString(workflow.readiness, `${field}.readiness`, 32);
  if (!READINESS_STATES.has(readiness)) {
    throw new ContractValidationError(`${field}.readiness is not supported`);
  }
  const clarifyingQuestion =
    workflow.clarifyingQuestion === null || workflow.clarifyingQuestion === undefined
      ? undefined
      : requireInstruction(
          workflow.clarifyingQuestion,
          `${field}.clarifyingQuestion`,
          MAX_CLARIFYING_QUESTION_LENGTH,
        );

  if (missingInformation.length > 0 && readiness !== 'needs_clarification') {
    throw new ContractValidationError(
      `${field}.readiness must be needs_clarification when information is missing`,
    );
  }
  if (readiness === 'needs_clarification') {
    if (missingInformation.length === 0) {
      throw new ContractValidationError(
        `${field}.missingInformation is required for clarification`,
      );
    }
    if (!clarifyingQuestion) {
      throw new ContractValidationError(
        `${field}.clarifyingQuestion is required for clarification`,
      );
    }
  }
  if (readiness !== 'needs_clarification' && clarifyingQuestion) {
    throw new ContractValidationError(
      `${field}.clarifyingQuestion is only allowed when clarification is needed`,
    );
  }

  return {
    ...(intent ? { intent } : {}),
    requiredInformation,
    knownInformation,
    missingInformation,
    readiness,
    ...(clarifyingQuestion ? { clarifyingQuestion } : {}),
  };
}

export function validateDecisionContext(value) {
  const context = requireRecord(value, 'decisionContext');
  requireAllowedKeys(context, ['taskStatus', 'goal', 'step', 'plan', 'awaitingInputCompletion', 'awaitingConfirmation', 'inputComplete'], 'decisionContext');
  if (!['active', 'completed'].includes(context.taskStatus)) throw new ContractValidationError('Invalid task status');
  // Accept the retired flag from old sessions, but do not restore a confirmation flow.
  if (context.awaitingConfirmation !== undefined) requireBoolean(context.awaitingConfirmation, 'awaitingConfirmation');
  let step;
  if (context.step !== undefined) {
    const source = requireRecord(context.step, 'decisionContext.step');
    requireAllowedKeys(source, ['targetDescription', 'spokenInstruction', 'language', 'consequence'], 'decisionContext.step');
    if (!['en-IN', 'hi-IN'].includes(source.language)) throw new ContractValidationError('Invalid step language');
    step = {
      targetDescription: requireInstruction(source.targetDescription, 'targetDescription', 240),
      spokenInstruction: requireInstruction(source.spokenInstruction, 'spokenInstruction', 240),
      language: source.language,
      ...(source.consequence === undefined ? {} : { consequence: requireInstruction(source.consequence, 'consequence', 240) }),
    };
  }
  const plan = context.plan === undefined ? undefined : validateSemanticPlan(context.plan);
  if (plan) {
    const current = plan.steps[plan.currentStepIndex];
    step = current ? { targetDescription: current.targetDescription, spokenInstruction: current.spokenInstruction, language: current.language, ...(current.consequence ? { consequence: current.consequence } : {}) } : undefined;
  }
  return {
    taskStatus: context.taskStatus,
    ...(context.goal === undefined ? {} : { goal: requireString(context.goal, 'decisionContext.goal') }),
    ...(step ? { step } : {}),
    ...(plan ? { plan } : {}),
    ...(context.awaitingInputCompletion === undefined ? {} : { awaitingInputCompletion: requireBoolean(context.awaitingInputCompletion, 'awaitingInputCompletion') }),
    ...(context.inputComplete === undefined ? {} : { inputComplete: requireBoolean(context.inputComplete, 'inputComplete') }),
  };
}

export function validateSemanticPlan(value) {
  const plan = requireRecord(value, 'plan');
  requireAllowedKeys(plan, ['id', 'steps', 'currentStepIndex', 'complete'], 'plan');
  const id = requireString(plan.id, 'plan.id', 80);
  const items = requireArray(plan.steps, 'plan.steps');
  if (items.length < 1 || items.length > 3 || !Number.isInteger(plan.currentStepIndex) || plan.currentStepIndex < 0 || plan.currentStepIndex > items.length) throw new ContractValidationError('Invalid plan bounds');
  const steps = items.map((item) => {
    const source = requireRecord(item, 'plan step');
    requireAllowedKeys(source, ['targetDescription', 'spokenInstruction', 'language', 'consequence', 'precondition', 'expectedOutcome'], 'plan step');
    const { precondition, expectedOutcome, ...step } = source;
    return { ...validateDecisionContext({ taskStatus: 'active', step }).step,
      precondition: requireInstruction(precondition, 'precondition', 240),
      expectedOutcome: requireInstruction(expectedOutcome, 'expectedOutcome', 240) };
  });
  return { id, steps, currentStepIndex: plan.currentStepIndex, complete: plan.complete === undefined ? true : requireBoolean(plan.complete, 'plan.complete') };
}

export function validatePageOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error();
    return url.origin;
  } catch { throw new ContractValidationError('Invalid page origin'); }
}

export function validatePageEvidence(value) {
  const evidence = requireArray(value, 'page.evidence');
  if (evidence.length > 12) throw new ContractValidationError('Too much page evidence');
  return evidence.map((item) => {
    const entry = requireRecord(item, 'page.evidence item');
    requireAllowedKeys(entry, ['kind', 'text'], 'page.evidence item');
    if (!['heading', 'status', 'alert', 'text'].includes(entry.kind)) throw new ContractValidationError('Invalid evidence kind');
    return { kind: entry.kind, text: requireString(entry.text, 'page.evidence.text', 240) };
  });
}

export function validateReasonRequest(value) {
  const request = requireRecord(value, 'reason request');
  requireAllowedKeys(
    request,
    ['userUtterance', 'userLanguage', 'trigger', 'session', 'page'],
    'reason request',
  );

  const session = requireRecord(request.session, 'session');
  requireAllowedKeys(
    session,
    ['goal', 'recentActions', 'pendingAction', 'workflow', 'decisionContext'],
    'session',
  );
  const recentActions = requireArray(session.recentActions, 'session.recentActions');
  const normalizedActions = recentActions.slice(-8).map((action, index) => {
    const normalized = requireRecord(action, `session.recentActions[${index}]`);
    requireAllowedKeys(
      normalized,
      ['type', 'label'],
      `session.recentActions[${index}]`,
    );
    return {
      type: requireString(normalized.type, `session.recentActions[${index}].type`, 40),
      ...(normalized.label !== undefined
        ? {
            label: requireString(
              normalized.label,
              `session.recentActions[${index}].label`,
            ),
          }
        : {}),
    };
  });

  let pendingAction;
  if (session.pendingAction !== undefined) {
    const pending = requireRecord(session.pendingAction, 'session.pendingAction');
    requireAllowedKeys(pending, ['type', 'targetLabel'], 'session.pendingAction');
    const type = requireString(pending.type, 'session.pendingAction.type', 12);
    if (!EXPECTED_ACTIONS.has(type)) {
      throw new ContractValidationError('session.pendingAction.type is not supported');
    }
    pendingAction = {
      type,
      ...(pending.targetLabel !== undefined
        ? { targetLabel: requireString(pending.targetLabel, 'session.pendingAction.targetLabel') }
        : {}),
    };
  }

  const workflow =
    session.workflow === undefined
      ? undefined
      : validateIntentReadiness(session.workflow, 'session.workflow');

  const page = requireRecord(request.page, 'page');
  requireAllowedKeys(page, ['origin', 'title', 'section', 'status', 'evidence', 'elements'], 'page');
  const elements = requireArray(page.elements, 'page.elements');
  if (elements.length > 1000) {
    throw new ContractValidationError('page.elements exceeds the maximum count');
  }

  if (new Set(elements.map((element) => element?.id)).size !== elements.length) throw new ContractValidationError('Duplicate element IDs');
  if (request.trigger !== undefined && !['user', 'manual-action', 'page-change', 'resume'].includes(request.trigger)) throw new ContractValidationError('Invalid trigger');
  return {
    ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
    userUtterance: requireString(request.userUtterance, 'userUtterance'),
    ...(request.userLanguage !== undefined
      ? { userLanguage: requireString(request.userLanguage, 'userLanguage', 24) }
      : {}),
    session: {
      ...(session.goal !== undefined
        ? { goal: requireString(session.goal, 'session.goal') }
        : {}),
      recentActions: normalizedActions,
      ...(session.decisionContext === undefined ? {} : { decisionContext: validateDecisionContext(session.decisionContext) }),
      ...(pendingAction ? { pendingAction } : {}),
      ...(workflow ? { workflow } : {}),
    },
    page: {
      ...(page.origin === undefined ? {} : { origin: validatePageOrigin(page.origin) }),
      ...(page.title !== undefined ? { title: requireString(page.title, 'page.title') } : {}),
      ...(page.section !== undefined
        ? { section: requireString(page.section, 'page.section') }
        : {}),
      ...(page.status !== undefined ? { status: requireString(page.status, 'page.status', 240) } : {}),
      elements: elements.map(validateSemanticElement),
      ...(page.evidence === undefined ? {} : { evidence: validatePageEvidence(page.evidence) }),
    },
  };
}

const CONSEQUENCE_RULES = [
  ['submission', /\b(?:submit|file|send|finalize|publish|delete|remove|erase)\b/i],
  ['consent', /\b(?:consent|agree|accept|authorize|approve|declaration)\b/i],
  ['identity', /\b(?:aadhaar|aadhar|otp|kyc|identity|verify|verification)\b/i],
  ['personal-data', /\b(?:change|update|edit|modify)\b.*\b(?:name|phone|mobile|address|bank|email|profile)\b/i],
  ['financial', /\b(?:withdraw|transfer|payment|payout|bank|money|purchase|buy|checkout|pay)\b/i],
  ['credentials', /\b(?:password|passcode|pin|secret)\b/i],
];

export function classifyConsequence(label) {
  return CONSEQUENCE_RULES.find(([, pattern]) => pattern.test(label))?.[0];
}

function requireInstruction(
  value,
  field,
  maxLength = MAX_GUIDANCE_INSTRUCTION_LENGTH,
) {
  const instruction = requireString(value, field, maxLength);
  // Match code syntax, not UI descriptions such as "function header".
  if (/<\/?script\b|javascript:|```|=>|\bfunction\s*\*?\s*(?:[\w$]+\s*)?\(|\b(?:const|let|var)\s+(?:[\w$]+\s*[=;,]|[\[{])/i.test(instruction)) {
    throw new ContractValidationError(`${field} contains executable content`, { field, rule: 'executable_content' });
  }
  return instruction;
}

function targetById(elements, targetId) {
  const target = elements.find((element) => element.id === targetId);
  if (!target) {
    throw new ContractValidationError(`Unknown targetId: ${targetId}`);
  }
  return target;
}

export function validateGuideAction(value, elements) {
  const source = requireRecord(value, 'GuideAction');
  if (source.decisionContext !== undefined) {
    const { decisionContext, ...action } = source;
    const context = validateDecisionContext(decisionContext);
    if ((action.action === 'success' && context.taskStatus !== 'completed') ||
      (context.taskStatus === 'completed' && !['success', 'wait'].includes(action.action))) throw new ContractValidationError('Action and task status disagree');
    return { ...validateGuideAction(action, elements), decisionContext: context };
  }
  const action = source;
  const availableElements = elements ?? [];
  const actionType = requireString(action.action, 'GuideAction.action', 16);
  const workflow =
    action.workflow === undefined
      ? undefined
      : validateIntentReadiness(action.workflow, 'GuideAction.workflow');

  const workflowFields = ['workflow'];
  const enforceGuideReadiness = () => {
    if (!workflow) {
      return;
    }
    if (
      workflow.readiness === 'needs_clarification' ||
      workflow.missingInformation.length > 0
    ) {
      throw new ContractValidationError(
        'GuideAction cannot guide while intent information is missing',
      );
    }
    if (workflow.readiness !== 'ready') {
      throw new ContractValidationError(
        'GuideAction requires a ready intent assessment',
      );
    }
  };

  if (actionType === 'guide') {
    requireAllowedKeys(
      action,
      [
        'action',
        'targetId',
        'spokenInstruction',
        'consequence',
        'expectedUserAction',
        'language',
        ...workflowFields,
      ],
      'GuideAction',
    );
    enforceGuideReadiness();
    const targetId = requireString(action.targetId, 'targetId', 80);
    const target = targetById(availableElements, targetId);
    if (target.disabled) {
      throw new ContractValidationError('GuideAction target is disabled');
    }
    const expectedUserAction = requireString(
      action.expectedUserAction,
      'expectedUserAction',
      12,
    );
    if (!EXPECTED_ACTIONS.has(expectedUserAction)) {
      throw new ContractValidationError('expectedUserAction is not supported');
    }
    const consequence =
      action.consequence === undefined
        ? undefined
        : requireInstruction(
            action.consequence,
            'consequence',
            MAX_CONSEQUENCE_LENGTH,
          );
    if (classifyConsequence(target.label) && !consequence) {
      throw new ContractValidationError(
        'Consequential guide actions require a consequence explanation',
      );
    }
    return {
      action: 'guide',
      targetId,
      spokenInstruction: requireInstruction(action.spokenInstruction, 'spokenInstruction'),
      ...(consequence ? { consequence } : {}),
      expectedUserAction,
      language: requireString(action.language, 'language', 24),
      ...(workflow ? { workflow } : {}),
    };
  }

  if (actionType === 'explain') {
    requireAllowedKeys(
      action,
      ['action', 'targetId', 'spokenInstruction', 'language', ...workflowFields],
      'GuideAction',
    );
    const targetId =
      action.targetId === undefined || action.targetId === null
        ? undefined
        : requireString(action.targetId, 'targetId', 80);
    if (targetId) {
      targetById(availableElements, targetId);
    }
    return {
      action: 'explain',
      ...(targetId ? { targetId } : {}),
      spokenInstruction: requireInstruction(
        action.spokenInstruction,
        'spokenInstruction',
        MAX_EXPLANATION_LENGTH,
      ),
      language: requireString(action.language, 'language', 24),
      ...(workflow ? { workflow } : {}),
    };
  }

  if (actionType === 'scroll') {
    requireAllowedKeys(action, ['action', 'targetId', ...workflowFields], 'GuideAction');
    targetById(availableElements, action.targetId);
    return {
      action: 'scroll',
      targetId: requireString(action.targetId, 'targetId', 80),
      ...(workflow ? { workflow } : {}),
    };
  }

  if (actionType === 'wait') {
    requireAllowedKeys(action, ['action', ...workflowFields], 'GuideAction');
    return { action: 'wait', ...(workflow ? { workflow } : {}) };
  }

  if (actionType === 'clarify' || actionType === 'success') {
    requireAllowedKeys(
      action,
      ['action', 'spokenInstruction', 'language', ...workflowFields],
      'GuideAction',
    );
    if (
      workflow &&
      actionType === 'clarify' &&
      workflow.readiness !== 'needs_clarification'
    ) {
      throw new ContractValidationError(
        'Clarify action requires a needs_clarification intent assessment',
      );
    }
    return {
      action: actionType,
      spokenInstruction: requireInstruction(
        action.spokenInstruction,
        'spokenInstruction',
        actionType === 'clarify'
          ? MAX_CLARIFYING_QUESTION_LENGTH
          : MAX_GUIDANCE_INSTRUCTION_LENGTH,
      ),
      language: requireString(action.language, 'language', 24),
      ...(workflow ? { workflow } : {}),
    };
  }

  throw new ContractValidationError(`Unknown GuideAction: ${actionType}`);
}

export const MAX_REASON_BODY_BYTES = 512 * 1024;

export function validatePlanDecision(value) {
  const plan = requireRecord(value, 'PlanDecision');
  requireAllowedKeys(plan, ['action', 'targetDescription', 'spokenInstruction', 'consequence', 'language', 'workflow'], 'PlanDecision');
  const action = requireString(plan.action, 'action', 16);
  if (!['guide', 'explain', 'scroll', 'wait', 'clarify', 'success'].includes(action)) {
    throw new ContractValidationError('Unsupported plan action');
  }
  const targeted = action === 'guide' || action === 'scroll';
  const targetDescription = plan.targetDescription == null ? undefined : requireString(plan.targetDescription, 'targetDescription', 240);
  if (targeted && !targetDescription) throw new ContractValidationError('Target description is required');
  if (!targeted && action !== 'explain' && targetDescription) throw new ContractValidationError('This action cannot have a target');
  const workflow = validateIntentReadiness(plan.workflow, 'workflow');
  if (action === 'guide' && workflow.readiness !== 'ready') throw new ContractValidationError('Guide requires ready workflow');
  if (action === 'clarify' && workflow.readiness !== 'needs_clarification') throw new ContractValidationError('Clarify requires missing information');
  const spokenInstruction = ['wait', 'scroll'].includes(action) ? undefined : requireInstruction(plan.spokenInstruction, 'spokenInstruction', action === 'explain' ? 2500 : 240);
  const language = requireString(plan.language, 'language', 24);
  if (!['en-IN', 'hi-IN'].includes(language)) throw new ContractValidationError('Language must be en-IN or hi-IN');
  if (action === 'clarify' && spokenInstruction !== workflow.clarifyingQuestion) throw new ContractValidationError('Clarification text must match workflow question');
  const consequence = plan.consequence == null ? undefined : requireInstruction(plan.consequence, 'consequence', 240);
  return { action, targetDescription, spokenInstruction, consequence, language, workflow };
}
