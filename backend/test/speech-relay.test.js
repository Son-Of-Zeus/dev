import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { relaySpeech } from '../src/speech-relay.js';

class Socket extends EventEmitter {
  readyState = 1; sent = []; closed = false;
  send(data, options) { this.sent.push({ data, options }); }
  close(code) { if (this.closed) return; this.closed = true; this.readyState = 3; this.emit('close', code); }
  terminate() { this.close(); }
  json(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
}
function setup() {
  const client = new Socket(); const upstream = new Socket();
  relaySpeech(client, { apiKey: 'synthetic-secret', connect: (url) => { assert.equal(url, 'wss://api.meta.ai/v1/asr/realtime'); return upstream; } });
  upstream.emit('open');
  return { client, upstream };
}
test('Meta handshake enables endpointing and only exposes safe events to the client', () => {
  const { client, upstream } = setup();
  const handshake = JSON.parse(upstream.sent[0].data);
  assert.equal(handshake.model, 'muse-voice-transcribe-1.0');
  assert.equal(handshake.mode, 'ENDPOINTING'); assert.equal(handshake.audioEncoding, 'PCM_24KHZ');
  assert.deepEqual(handshake.languageBias, ['English', 'Hindi']);
  upstream.json({ sessionId: 'synthetic' });
  upstream.json({ type: 'transcript', transcript: 'Open' });
  const pcm = Buffer.alloc(3840); client.emit('message', pcm, true);
  assert.equal(upstream.sent[1].data, pcm);
  upstream.json({ type: 'speechComplete', transcript: 'Open settings', turnId: 1 });
  const events = client.sent.map(({ data }) => JSON.parse(data));
  assert.deepEqual(events.map((e) => e.type), ['ready', 'partial', 'final']);
  assert.equal(events.at(-1).transcript, 'Open settings');
  assert.ok(!JSON.stringify(events).includes('synthetic-secret'));
  assert.equal(JSON.parse(upstream.sent[2].data).type, 'endStream');
});
test('manual stop drains input and waits for a final transcript', () => {
  const { client, upstream } = setup(); upstream.json({ sessionId: 'synthetic' });
  client.json({ type: 'stop' }); assert.equal(JSON.parse(upstream.sent[1].data).type, 'endStream');
  assert.ok(!client.closed); upstream.json({ type: 'speechComplete', transcript: 'सेटिंग खोलें' });
  assert.equal(JSON.parse(client.sent.at(-1).data).type, 'final');
});
test('invalid PCM, premature close, bad commands and provider errors fail without a final', () => {
  for (const scenario of ['odd', 'early', 'command', 'provider']) {
    const { client, upstream } = setup();
    if (scenario !== 'early') upstream.json({ sessionId: 'synthetic' });
    if (scenario === 'odd') client.emit('message', Buffer.alloc(3), true);
    if (scenario === 'early') upstream.close();
    if (scenario === 'command') client.json({ type: 'execute', script: 'no' });
    if (scenario === 'provider') upstream.json({ type: 'error', message: 'private provider body' });
    assert.equal(JSON.parse(client.sent.at(-1).data).type, 'error'); assert.ok(client.closed);
    assert.ok(!JSON.stringify(client.sent).includes('private provider body'));
  }
});
test('client cancellation closes the provider connection', () => {
  const { client, upstream } = setup(); client.json({ type: 'cancel' }); assert.ok(upstream.closed);
});
