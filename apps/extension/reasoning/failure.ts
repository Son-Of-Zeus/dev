// Only known codes select user-facing text. Never display raw provider errors.
const MESSAGES: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: 'A model provider is not configured on the backend.',
  PROVIDER_AUTH: 'Model access was rejected. Check backend provider keys and model access.',
  PROVIDER_RATE_LIMIT: 'The model provider is busy. Wait a moment, then retry.',
  PROVIDER_UNAVAILABLE: 'The model provider is unavailable. Please retry shortly.',
  PROVIDER_TIMEOUT: 'The model response timed out. Please retry.',
  PLANNER_INVALID_RESPONSE: 'Muse returned an invalid plan. Please retry.',
  ASSESSMENT_INVALID_RESPONSE: 'Jev returned an invalid decision. Please retry.',
  MODEL_FAILED: 'Model request failed. Please retry.',
  TARGET_NOT_FOUND: 'The requested control is not available.',
};

export function reasoningFailure(value: { code?: unknown; status?: unknown }): Error & { code: string; status: number } {
  const code = typeof value.code === 'string' && Object.hasOwn(MESSAGES, value.code) ? value.code : 'MODEL_FAILED';
  const status = value.status === 409 ? 409 : 502;
  return Object.assign(new Error(MESSAGES[code]), { code, status });
}
