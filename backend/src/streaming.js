// Provider SSE framing is separate from the model's newline-delimited records.
export async function* readSse(body, signal) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  for await (const chunk of body) {
    signal?.throwIfAborted();
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw new Error('Stream exceeds its size limit.');
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      if (match.index > 65_536) throw new Error('Stream frame is too large.');
      const frame = buffer.slice(0, match.index);
      if (Buffer.byteLength(frame) > 65_536) throw new Error('Stream frame is too large.');
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
    if (Buffer.byteLength(buffer) > 65_536) throw new Error('Stream frame is too large.');
  }
  if ((buffer + decoder.decode()).trim()) throw new Error('Truncated stream frame.');
}
