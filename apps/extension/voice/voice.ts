import type { SessionStateStore } from '../session/session-state';
import type { LatencyMetric } from '../runtime/latency';

export type SpeechToTextResult = { transcript: string; language?: string; transcriptionMs?: number };
export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'guiding' | 'speaking' | 'waiting' | 'success' | 'error';
export type VoiceResult = ({ status: 'transcript' } & SpeechToTextResult) | { status: 'cancelled' } | { status: 'error'; error: Error };
export interface SpeechInput {
  listen(onPartial: (text: string) => void): Promise<SpeechToTextResult>;
  stop(): void;
  cancel(): void;
}
export interface SpeechOutput {
  speak(text: string, language?: string): Promise<{ warning?: string } | void>;
  cancel(): void;
}
export type VoiceController = {
  getState(): VoiceState;
  subscribe(listener: (state: VoiceState) => void): () => void;
  listen(): Promise<VoiceResult>;
  stopListening(): void;
  say(text: string, language?: string): Promise<void>;
  setState(state: VoiceState): void;
  cancel(): void;
};
export function createVoiceController(options: {
  speechInput: SpeechInput;
  speechOutput: SpeechOutput;
  session?: SessionStateStore;
  onPartial?: (text: string) => void;
  onInstruction?: (text: string) => void;
  onNotice?: (text: string) => void;
  onLatency?: (metric: LatencyMetric) => void;
  now?: () => number;
}): VoiceController {
  let state: VoiceState = 'idle';
  let generation = 0;
  let stoppedAt: number | undefined;
  const now = options.now ?? (() => performance.now());
  const listeners = new Set<(state: VoiceState) => void>();
  const setState = (next: VoiceState) => {
    state = next;
    options.session?.setCompanionState(next === 'transcribing' ? 'thinking' : next);
    listeners.forEach((listener) => listener(next));
  };
  const cancel = () => { generation += 1; options.speechInput.cancel(); options.speechOutput.cancel(); setState('idle'); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setState,
    async listen() {
      cancel();
      const run = generation;
      const start = now();
      stoppedAt = undefined;
      setState('listening');
      try {
        const result = await options.speechInput.listen((text) => { if (run === generation) options.onPartial?.(text); });
        if (run !== generation) return { status: 'cancelled' };
        if (!result.transcript.trim()) throw new Error('No speech was detected.');
        options.onPartial?.(result.transcript);
        options.onLatency?.({ stage: 'speech-to-text', durationMs: result.transcriptionMs ?? now() - (stoppedAt ?? start) });
        setState('thinking');
        return { status: 'transcript', ...result };
      } catch (error) {
        if (run !== generation) return { status: 'cancelled' };
        setState('error');
        return { status: 'error', error: error instanceof Error ? error : new Error('Speech input failed.') };
      }
    },
    stopListening() { if (state === 'listening') { stoppedAt = now(); setState('transcribing'); options.speechInput.stop(); } },
    async say(text, language) {
      const run = generation;
      options.onInstruction?.(text);
      setState('speaking');
      const start = now();
      const result = await options.speechOutput.speak(text, language);
      if (run !== generation) return;
      if (result?.warning) options.onNotice?.(result.warning);
      options.onLatency?.({ stage: 'text-to-speech', durationMs: now() - start });
      setState('idle');
    },
    cancel,
  };
}
