export const SPEECH_LANGUAGE_KEY = 'companion:speech-language';
export const SPEECH_LANGUAGES = ['en-IN', 'en-US', 'hi-IN'] as const;
export function speechLanguage(value: unknown): string { return typeof value === 'string' && (SPEECH_LANGUAGES as readonly string[]).includes(value) ? value : 'en-IN'; }
export const voiceKey = (family: string) => `companion:voice:${family}`;

export const SPEECH_PROVIDER_KEY = 'companion:speech-provider';
export type SpeechProvider = 'chrome' | 'meta';
export type MetaSpeechStatus = { available: boolean; message: string };
export type SpeechPreferences = { provider: SpeechProvider; language: string; meta?: MetaSpeechStatus };
export function speechProvider(value: unknown, fallback: SpeechProvider = 'chrome'): SpeechProvider {
  return value === 'chrome' || value === 'meta' ? value : fallback;
}
