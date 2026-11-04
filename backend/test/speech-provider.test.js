import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechProvider } from '../src/speech-provider.js';

test('browser speech mode does not construct a server recognizer', () => {
  const messages=[]; let closed=false;
  const provider=createSpeechProvider({provider:'none'});
  provider.relay({send:value=>messages.push(JSON.parse(value)),close:()=>{closed=true;}});
  assert.equal(provider.provider,'none'); assert.match(messages[0].message,/Chrome speech recognition/); assert.ok(closed); provider.close();
});
test('Meta transcription remains explicitly available with clear configuration errors', () => {
  const messages=[];
  createSpeechProvider({provider:'meta',meta:{apiKey:''}}).relay({send:value=>messages.push(JSON.parse(value)),close(){}});
  assert.equal(messages[0].message,'MODEL_API_KEY is not configured.');
  assert.throws(()=>createSpeechProvider({provider:'invalid'}),/none or meta/);
});

test('speech readiness checks configuration without contacting Meta', async () => {
  const { speechProviderStatus } = await import('../src/speech-provider.js');
  assert.equal(speechProviderStatus({ provider: 'none' }).available, false);
  assert.equal(speechProviderStatus({ provider: 'meta', meta: { apiKey: '' } }).available, false);
  assert.equal(speechProviderStatus({ provider: 'meta', meta: { apiKey: 'synthetic-key' } }).available, true);
  assert.ok(!JSON.stringify(speechProviderStatus({ provider: 'meta', meta: { apiKey: 'synthetic-key' } })).includes('synthetic-key'));
});
