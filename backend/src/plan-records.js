// Frame complete JSON objects independently of model whitespace and SSE chunks.
// Yield each object before reading its tail so a later error cannot replay it.
export class PlanRecordReader {
  buffer = '';
  depth = 0;
  quoted = false;
  escaped = false;
  bytes = 0;

  *push(chunk) {
    for (const character of chunk) {
      if (!this.buffer && /\s/.test(character)) continue;
      if (!this.buffer && character !== '{') throw new PlanFormatError('record_json');
      this.buffer += character;
      this.bytes += Buffer.byteLength(character);
      if (this.bytes > 16_384) throw new PlanFormatError('record_limit');
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === '"') this.quoted = false;
      } else if (character === '"') this.quoted = true;
      else if (character === '{' || character === '[') this.depth++;
      else if (character === '}' || character === ']') this.depth--;
      if (this.depth === 0) {
        let value;
        try { value = JSON.parse(this.buffer); }
        catch { throw new PlanFormatError('record_json'); }
        this.buffer = '';
        this.bytes = 0;
        yield value;
      }
    }
  }

  finish() {
    if (this.buffer) throw new PlanFormatError('record_truncated');
  }
}

export class PlanFormatError extends Error {
  constructor(reason, details) {
    super('Invalid plan format.');
    this.reason = reason;
    this.details = details;
  }
}
