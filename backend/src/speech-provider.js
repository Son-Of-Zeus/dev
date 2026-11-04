import { relaySpeech } from './speech-relay.js';

export function speechProviderStatus(options = {}) {
  const provider = options.provider ?? process.env.SERVER_STT_PROVIDER ?? 'none';
  if (provider !== 'meta') return { available: false, message: 'Enable Meta STT on the backend to use this provider.' };
  const key = options.meta?.apiKey ?? process.env.MODEL_API_KEY;
  return typeof key === 'string' && key.trim()
    ? { available: true, message: 'Meta STT is configured.' }
    : { available: false, message: 'Add the Meta API key to the backend configuration.' };
}

export function createSpeechProvider(options = {}) {
  const provider = options.provider ?? process.env.SERVER_STT_PROVIDER ?? 'none';
  if (provider === 'meta') return { provider, relay: (client) => relaySpeech(client, options.meta), close() {} };
  if (provider !== 'none') throw new Error('SERVER_STT_PROVIDER must be none or meta.');
  return {
    provider,
    relay(client) {
      client.send(JSON.stringify({ type: 'error', message: 'Server transcription is disabled. Use Chrome speech recognition.' }));
      client.close(1011);
    },
    close() {},
  };
}
