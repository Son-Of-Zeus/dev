import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanFormatError, PlanRecordReader } from '../src/plan-records.js';

test('object framing handles pretty JSON, strings, escapes and every split boundary', () => {
  const expected = [{ sequence: 1, text: 'quoted " } [ \\ \n हिन्दी' }, { sequence: 2, nested: [{ ok: true }] }];
  const content = expected.map((value) => JSON.stringify(value, null, 2)).join('\r\n');
  for (let split = 0; split <= content.length; split++) {
    const reader = new PlanRecordReader();
    assert.deepEqual([...reader.push(content.slice(0, split)), ...reader.push(content.slice(split))], expected);
    reader.finish();
  }
});

test('object framing rejects prose, arrays, invalid JSON, incomplete records and byte overflow', () => {
  for (const content of ['```json\n{}', '[{}]', '{broken}', '{"a":]}', '{"a":"unfinished', '{"a":' + ' '.repeat(16_384)]) {
    const reader = new PlanRecordReader();
    assert.throws(() => { [...reader.push(content)]; reader.finish(); }, PlanFormatError);
  }
  const reader = new PlanRecordReader();
  assert.throws(() => [...reader.push(JSON.stringify({ text: 'ह'.repeat(6000) }))], (error) => error.reason === 'record_limit');
});

test('a valid record is yielded before an invalid tail in the same chunk', () => {
  const iterator = new PlanRecordReader().push('{"sequence":1}\ninvalid');
  assert.deepEqual(iterator.next().value, { sequence: 1 });
  assert.throws(() => iterator.next(), PlanFormatError);
});
