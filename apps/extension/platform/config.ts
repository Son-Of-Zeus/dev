import { validateBackendUrl } from '../backend-url';

export { validateBackendUrl } from '../backend-url';
export const BACKEND_URL = validateBackendUrl(import.meta.env.WXT_BACKEND_URL).origin;
export const SPEECH_URL = BACKEND_URL.replace(/^https:/, 'wss:') + '/speech/stream';

const provider = import.meta.env.WXT_STT_PROVIDER ?? 'chrome';
if (!['chrome', 'server'].includes(provider)) throw new Error('WXT_STT_PROVIDER must be chrome or server.');
export const STT_PROVIDER = provider as 'chrome' | 'server';
