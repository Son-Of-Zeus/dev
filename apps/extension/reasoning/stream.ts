// Parse bounded SSE envelopes. The server sends complete JSON in each event.
export async function* readReasonEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Reasoning stream is too large.');
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (match.index > 65_536) throw new Error('Reasoning event is too large.');
        const frame = buffer.slice(0, match.index);
        if (encoder.encode(frame).byteLength > 65_536) throw new Error('Reasoning event is too large.');
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield JSON.parse(data);
      }
      if (encoder.encode(buffer).byteLength > 65_536) throw new Error('Reasoning event is too large.');
    }
    if ((buffer + decoder.decode()).trim()) throw new Error('Truncated reasoning event.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
