export type SpeechVoice = { voiceName?: string; lang?: string; extensionId?: string; remote?: boolean };
export type SavedVoice = { voiceName: string; lang: string; extensionId?: string };
export type VoiceStore = { get(family: string): Promise<unknown>; set(family: string, voice: SavedVoice): Promise<void> };
export type ChromeSpeechApi = {
  getVoices(): Promise<SpeechVoice[]>;
  speak(text: string, options: { lang: string; voiceName?: string; extensionId?: string; rate?: number; pitch?: number; volume?: number; enqueue?: boolean; onEvent: (event: { type: string }) => void }): void | Promise<void>;
  stop(): void;
};
const normalize = (language = '') => language.replaceAll('_', '-').toLowerCase();
export const voiceId = (voice: SpeechVoice) => JSON.stringify([voice.extensionId ?? '', voice.voiceName ?? '', normalize(voice.lang)]);
export function savedVoice(value: unknown): SavedVoice | undefined {
  if (!value || typeof value !== 'object') return;
  const voice = value as SpeechVoice;
  if (typeof voice.voiceName !== 'string' || !voice.voiceName || voice.voiceName.length > 200 || typeof voice.lang !== 'string' || !/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(voice.lang.replaceAll('_', '-')) || (voice.extensionId !== undefined && typeof voice.extensionId !== 'string')) return;
  return { voiceName: voice.voiceName, lang: voice.lang.replaceAll('_', '-'), ...(voice.extensionId ? { extensionId: voice.extensionId } : {}) };
}
export function pickDefaultVoice(voices: SpeechVoice[], language: string): SavedVoice | undefined {
  const requested = normalize(language); const family = requested.split('-')[0];
  const candidates = voices.filter((voice) => savedVoice(voice) && normalize(voice.lang).split('-')[0] === family);
  candidates.sort((a, b) => Number(normalize(b.lang) === requested) - Number(normalize(a.lang) === requested) || Number(!!a.remote) - Number(!!b.remote) || voiceId(a).localeCompare(voiceId(b), 'en'));
  return savedVoice(candidates[0]);
}
export function createChromeSpeech(api: ChromeSpeechApi, persistence?: VoiceStore) {
  let generation = 0; let finish: (() => void) | undefined;
  const pins = new Map<string, SavedVoice>();
  const store: VoiceStore = persistence ?? { get: async (family) => pins.get(family), set: async (family, voice) => { pins.set(family, voice); } };
  return {
    cancel() { generation += 1; api.stop(); finish?.(); finish = undefined; },
    async speak(text: string, language = 'en-IN'): Promise<{ warning?: string }> {
      const run = ++generation; api.stop(); finish?.();
      const family = normalize(language).split('-')[0]!;
      let voice: SavedVoice;
      try {
        const voices = await api.getVoices();
        if (run !== generation) return {};
        const pinned = savedVoice(await store.get(family));
        if (run !== generation) return {};
        const selected = pinned ? voices.find((item) => voiceId(item) === voiceId(pinned)) : pickDefaultVoice(voices, language);
        if (!selected) return { warning: pinned ? 'Your saved voice is unavailable. Choose a voice in extension Speech settings, or read the instruction on screen.' : `No ${family === 'hi' ? 'Hindi' : 'English'} voice is available. Read the instruction on screen.` };
        voice = savedVoice(selected)!;
        if (!pinned) await store.set(family, voice);
      } catch { return { warning: 'Speech settings are unavailable. Read the instruction on screen.' }; }
      if (run !== generation) return {};
      return new Promise((resolve) => {
        let settled = false;
        const done = (warning?: string) => { if (settled) return; settled = true; clearTimeout(timeout); finish = undefined; resolve(warning ? { warning } : {}); };
        finish = () => done();
        const timeout = setTimeout(() => { api.stop(); done('Speech timed out. Read the instruction on screen.'); }, 60_000);
        try {
          const started = api.speak(text, { lang: voice.lang, voiceName: voice.voiceName, ...(voice.extensionId ? { extensionId: voice.extensionId } : {}), rate: 1, pitch: 1, volume: 1, enqueue: false, onEvent: (event) => {
            if (['end', 'interrupted', 'cancelled'].includes(event.type)) done();
            if (event.type === 'error') done('Speech is unavailable. Read the instruction on screen.');
          } });
          if (started) void started.catch(() => done('Speech is unavailable. Read the instruction on screen.'));
        } catch { done('Speech is unavailable. Read the instruction on screen.'); }
      });
    },
  };
}
