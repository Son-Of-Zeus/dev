import type { MetaSpeechStatus } from './speech-settings';

export const SPEECH_STATUS_TIMEOUT_MS = 30_000;

export async function readMetaSpeechStatus(
  backendUrl: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<MetaSpeechStatus> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? SPEECH_STATUS_TIMEOUT_MS);
  let response: Response;
  try {
    // Chrome can omit Origin on privileged GET requests. POST uses the same
    // origin-validated transport as /reason; no provider is called by this route.
    response = await (options.fetcher ?? fetch)(`${backendUrl}/speech/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      cache: 'no-store', signal,
    });
  } catch {
    return {
      available: false,
      message: signal.aborted
        ? 'The speech backend took too long to respond. Try again.'
        : 'Cannot reach the speech backend. Check your connection.',
    };
  }
  if (!response.ok) {
    if (response.status === 403) return { available: false, message: 'The backend rejected this extension (HTTP 403). Check ALLOWED_ORIGINS.' };
    if (response.status === 404 || response.status === 405) return { available: false, message: 'Update the backend to enable the Meta STT status check.' };
    return { available: false, message: `The speech backend returned HTTP ${response.status}. Try again.` };
  }
  try {
    const result = await response.json();
    if (!result || typeof result.available !== 'boolean' || typeof result.message !== 'string' ||
      !result.message.trim() || result.message.length > 240) throw new Error('Invalid status');
    return { available: result.available, message: result.message };
  } catch {
    return {
      available: false,
      message: signal.aborted
        ? 'The speech backend took too long to respond. Try again.'
        : 'The backend returned an invalid speech status. Update the backend.',
    };
  }
}
