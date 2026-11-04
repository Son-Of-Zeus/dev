import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePlanResponse, reportRejectedPlan } from '../src/planner-diagnostics.js';
import { PlanFormatError } from '../src/plan-records.js';

test('rejected plan diagnostics redact generated text and omit unknown fields', () => {
  const source = { sequence: 1, decision: { action: 'guide', targetDescription: 'backend function page', spokenInstruction: 'Email person@example.test; password: private123; https://example.test/?token=secret <input value="private">', privateField: 'PRIVATE', workflow: { requiredInformation: ['PRIVATE'], readiness: 'ready' } }, precondition: 'Metrics are visible.', token: 'PRIVATE' };
  const summary = summarizePlanResponse(source);
  const serialized = JSON.stringify(summary);
  for (const secret of ['person@example.test', 'private123', '?token=secret', '<input', 'PRIVATE']) assert.ok(!serialized.includes(secret));
  assert.equal(summary.decision.targetDescription.text, 'backend function page');
  assert.equal(summary.decision.workflow.requiredInformation.count, 1);
});

test('diagnostics identify the exact rejected field without raw errors', () => {
  const reports = [];
  reportRejectedPlan({ sequence: 1 }, new PlanFormatError('step_evidence', { field: 'precondition', rule: 'executable_content' }), { attempt: 2, committed: 0, onRejectedPlan: (value) => reports.push(value) });
  assert.equal(reports[0].failure.field, 'precondition');
  assert.equal(reports[0].failure.rule, 'executable_content');
  const unknown = [];
  reportRejectedPlan(undefined, new PlanFormatError('step_evidence', { field: 'private string', rule: 'private string' }), { onRejectedPlan: (value) => unknown.push(value) });
  assert.equal(unknown[0].failure.field, undefined);
  assert.deepEqual(unknown[0].response, { parsed: false });
});
