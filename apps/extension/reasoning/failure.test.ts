import { describe, expect, it } from 'vitest';
import { reasoningFailure } from './failure';

describe('safe reasoning failure messages', () => {
  it('shows the validated failure category instead of a generic model error', () => {
    expect(reasoningFailure({ code: 'PLANNER_INVALID_RESPONSE', status: 502 }).message).toBe('Muse returned an invalid plan. Please retry.');
    expect(reasoningFailure({ code: 'PROVIDER_AUTH' }).message).toContain('Model access was rejected');
    expect(reasoningFailure({ code: 'PROVIDER_TIMEOUT' }).message).toContain('timed out');
  });
  it('does not display arbitrary provider strings and preserves missing-target recovery', () => {
    expect(reasoningFailure({ code: 'Synthetic private content' }).message).toBe('Model request failed. Please retry.');
    expect(reasoningFailure({ code: 'TARGET_NOT_FOUND', status: 409 }).status).toBe(409);
    expect(reasoningFailure({ code: '__proto__' }).code).toBe('MODEL_FAILED');
  });
});
