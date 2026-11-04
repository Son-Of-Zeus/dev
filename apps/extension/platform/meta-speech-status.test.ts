import { describe, it, expect, vi } from 'vitest';
import { readMetaSpeechStatus, SPEECH_STATUS_TIMEOUT_MS } from './meta-speech-status';

const origin = 'https://synthetic-backend.modal.run';
describe('Meta status transport', () => {
  it('uses POST and a JSON body so Chrome sends the extension Origin', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ available: true, message: 'Meta STT is configured.' }))
      : new Response('', { status: 403 }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(await readMetaSpeechStatus(origin, { fetcher })).toEqual({ available: true, message: 'Meta STT is configured.' });
      expect(fetcher).toHaveBeenCalledWith(origin + '/speech/status', expect.objectContaining({ method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, cache: 'no-store' }));
      expect(timeout).toHaveBeenCalledWith(SPEECH_STATUS_TIMEOUT_MS);
      expect(SPEECH_STATUS_TIMEOUT_MS).toBe(30_000);
    } finally { timeout.mockRestore(); }
  });
  it('reports rejection, an old deployment and server failures with specific messages', async () => {
    for (const [status, text] of [[403, 'ALLOWED_ORIGINS'], [404, 'Update the backend'], [405, 'Update the backend'], [502, 'HTTP 502']] as const) {
      const result = await readMetaSpeechStatus(origin, { fetcher: async () => new Response('', { status }) });
      expect(result.available).toBe(false); expect(result.message).toContain(text);
      expect(result.message).not.toContain('Cannot reach');
    }
  });
  it('does not call an invalid status or broken JSON a connection failure', async () => {
    for (const payload of ['not JSON', '{}', JSON.stringify({ available: true, message: '' })]) {
      const result = await readMetaSpeechStatus(origin, { fetcher: async () => new Response(payload) });
      expect(result.available).toBe(false); expect(result.message).toContain('invalid speech status');
    }
  });
  it('reports a real connection failure separately from an abort timeout', async () => {
    expect((await readMetaSpeechStatus(origin, { fetcher: async () => { throw new TypeError('Failed to fetch'); } })).message).toContain('Cannot reach');
    const timedOut = await readMetaSpeechStatus(origin, { timeoutMs: 5, fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }) });
    expect(timedOut.message).toContain('too long'); expect(timedOut.message).not.toContain('Cannot reach');
  });
});
