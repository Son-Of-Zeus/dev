import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelFailure, providerFailure, publicModelFailure } from '../src/reasoning-errors.js';
import { PlanFormatError } from '../src/plan-records.js';

test('provider failures expose only stable safe categories', () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMIT'], [503, 'PROVIDER_UNAVAILABLE']]) {
    const error = providerFailure({ status, message: 'Synthetic private provider payload' }, 'Muse');
    assert.equal(error.code, code);
    const visible = publicModelFailure(error);
    assert.equal(visible.provider, 'Muse');
    assert.ok(!JSON.stringify(visible).includes('Synthetic private'));
  }
  assert.equal(providerFailure({ name: 'TimeoutError' }, 'Jev').code, 'PROVIDER_TIMEOUT');
  assert.deepEqual(publicModelFailure(new Error('Synthetic private data')), { code: 'MODEL_FAILED', message: 'Model request failed. Please retry.' });
});

test('invalid planning output has a distinct safe message', () => {
  const result = publicModelFailure(new ModelFailure('PLANNER_INVALID_RESPONSE', 'Muse', new Error('Private generated content')));
  assert.equal(result.code, 'PLANNER_INVALID_RESPONSE');
  assert.equal(result.message, 'Muse returned an invalid plan. Please retry.');
  assert.ok(!JSON.stringify(result).includes('Private generated'));
});

test('only allowlisted structural plan reasons enter diagnostics', () => {
  const failure = (cause) => publicModelFailure(new ModelFailure('PLANNER_INVALID_RESPONSE', 'Muse', cause));
  assert.equal(failure(new PlanFormatError('step_evidence')).reason, 'step_evidence');
  assert.equal(failure(new PlanFormatError('Private generated content')).reason, undefined);
  assert.equal(failure({ reason: 'step_evidence' }).reason, undefined);
});
