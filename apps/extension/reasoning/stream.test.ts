import { describe, expect, it } from 'vitest';
import { readReasonEvents } from './stream';

function body(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
}

describe('reasoning SSE framing', () => {
  it('decodes split UTF-8 and CRLF frames without exposing partial records', async () => {
    const result = [];
    const event = { type: 'diagnostic', text: 'सेटिंग्स' };
    for await (const value of readReasonEvents(body('data: ' + JSON.stringify(event) + '\r\n\r\ndata: {"type":"done"}\n\n'))) result.push(value);
    expect(result).toEqual([event, { type: 'done' }]);
  });
  it('rejects malformed JSON and truncated frames', async () => {
    for (const text of ['data: {broken}\n\n', 'data: {"type":"done"}']) {
      await expect(async () => { for await (const _value of readReasonEvents(body(text))) { /* consume */ } }).rejects.toThrow();
    }
  });
});
