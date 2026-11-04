import { PlanFormatError } from './plan-records.js';

const PLAN_REASONS = new Set(['record_json', 'record_limit', 'record_truncated', 'decision_contract', 'step_evidence', 'step_sequence', 'stream_incomplete', 'stream_empty', 'output_limit']);
const PLAN_FIELDS = new Set(['targetDescription', 'spokenInstruction', 'consequence', 'precondition', 'expectedOutcome', 'language', 'action', 'workflow.readiness']);
const PLAN_RULES = new Set(['nonempty_string', 'length', 'executable_content']);

const MESSAGES = {
  PROVIDER_NOT_CONFIGURED: 'A model provider is not configured on the backend.',
  PROVIDER_AUTH: 'Model access was rejected. Check backend provider keys and model access.',
  PROVIDER_RATE_LIMIT: 'The model provider is busy. Wait a moment, then retry.',
  PROVIDER_UNAVAILABLE: 'The model provider is unavailable. Please retry shortly.',
  PROVIDER_TIMEOUT: 'The model response timed out. Please retry.',
  PLANNER_INVALID_RESPONSE: 'Muse returned an invalid plan. Please retry.',
  ASSESSMENT_INVALID_RESPONSE: 'Jev returned an invalid decision. Please retry.',
  MODEL_FAILED: 'Model request failed. Please retry.',
};

export class ModelFailure extends Error {
  constructor(code, provider, cause) {
    super(MESSAGES[code] ?? MESSAGES.MODEL_FAILED, { cause });
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'MODEL_FAILED';
    this.provider = ['Muse', 'Jev'].includes(provider) ? provider : undefined;
  }
}

export function providerFailure(error, provider) {
  if (error instanceof ModelFailure) return error;
  const status = [error?.status, error?.statusCode, error?.httpStatus, error?.response?.status].find(Number.isInteger);
  const timeout = [408, 504].includes(status) || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.type === 'timeout';
  const code = timeout ? 'PROVIDER_TIMEOUT' : [401, 403].includes(status) ? 'PROVIDER_AUTH' : status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_UNAVAILABLE';
  return new ModelFailure(code, provider, error);
}

export function publicModelFailure(error) {
  const code = error instanceof ModelFailure ? error.code : 'MODEL_FAILED';
  const reason = error instanceof ModelFailure && error.cause instanceof PlanFormatError && PLAN_REASONS.has(error.cause.reason) ? error.cause.reason : undefined;
  const details = reason ? error.cause.details : undefined;
  return { code, message: MESSAGES[code], ...(error instanceof ModelFailure && error.provider ? { provider: error.provider } : {}), ...(reason ? { reason } : {}),
    ...(PLAN_FIELDS.has(details?.field) && PLAN_RULES.has(details?.rule) ? { field: details.field, rule: details.rule } : {}) };
}
