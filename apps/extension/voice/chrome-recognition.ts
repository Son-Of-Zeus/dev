export type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
export type RecognitionEngine = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null; onaudioend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
export type RecognitionConstructor = new () => RecognitionEngine;
export type ChromeSpeechResult = { transcript: string; language: string; transcriptionMs: number };

export function startChromeRecognition(Recognition: RecognitionConstructor | undefined, language: string, onPartial: (text: string) => void) {
  let engine: RecognitionEngine | undefined;
  let settled = false; let stopping = false; let final = ''; let endedAt: number | undefined;
  let captureTimer: ReturnType<typeof setTimeout>; let finalTimer: ReturnType<typeof setTimeout>;
  let resolve!: (result: ChromeSpeechResult) => void; let reject!: (error: Error) => void;
  const result = new Promise<ChromeSpeechResult>((yes, no) => { resolve = yes; reject = no; });
  const cleanup = () => {
    clearTimeout(captureTimer); clearTimeout(finalTimer);
    if (engine) { engine.onresult = null; engine.onerror = null; engine.onend = null; engine.onaudioend = null; try { engine.abort(); } catch {} }
  };
  const fail = (message: string) => { if (settled) return; settled = true; cleanup(); reject(new Error(message)); };
  const stop = () => {
    if (settled || stopping) return; stopping = true; endedAt ??= performance.now();
    clearTimeout(captureTimer);
    try { engine?.stop(); } catch { fail('Chrome could not stop speech recognition.'); }
    if (!settled) finalTimer = setTimeout(() => fail('Chrome did not return a final transcript. Try again.'), 8_000);
  };
  if (!Recognition) fail('Chrome speech recognition is unavailable. Use Google Chrome or choose server speech explicitly.');
  else {
    engine = new Recognition(); engine.lang = language; engine.continuous = false; engine.interimResults = true; engine.maxAlternatives = 1;
    engine.onaudioend = () => { endedAt ??= performance.now(); };
    engine.onresult = (event) => {
      if (settled) return;
      let interim = ''; final = '';
      for (let i = 0; i < event.results.length; i++) {
        const item = event.results[i]!; const text = item[0]?.transcript ?? '';
        if (item.isFinal) final += text + ' '; else interim += text + ' ';
      }
      final = final.replace(/\s+/g, ' ').trim();
      const partial = (final + ' ' + interim).replace(/\s+/g, ' ').trim();
      if (partial.length > 2000) { fail('The spoken request is too long. Use a shorter request.'); return; }
      if (partial) onPartial(partial);
      if (final) stop();
    };
    engine.onerror = ({ error }) => {
      const messages: Record<string, string> = {
        'not-allowed': 'NEED_MIC_PERMISSION',
        'service-not-allowed': 'Chrome speech recognition is blocked by the browser. Check Chrome speech and microphone settings.',
        'audio-capture': 'Chrome cannot access a microphone. Check the selected input device.',
        network: 'Chrome cannot connect to its speech recognition service. Check your connection and try again.',
        'no-speech': 'No speech was detected. Speak clearly and try again.',
        'language-not-supported': 'Chrome does not support the selected speech language. Change it in Speech settings.',
        aborted: 'Speech capture cancelled.',
      };
      fail(messages[error] ?? 'Chrome speech recognition failed. Try again.');
    };
    engine.onend = () => {
      if (settled) return;
      if (!final) { fail('Chrome returned no final speech. Try again.'); return; }
      settled = true; cleanup(); resolve({ transcript: final, language, transcriptionMs: Math.max(0, Math.round(performance.now() - (endedAt ?? performance.now()))) });
    };
    try { engine.start(); if (!settled) captureTimer = setTimeout(stop, 30_000); }
    catch { fail('Chrome could not start speech recognition. Check microphone access.'); }
  }
  return { result, stop, cancel: () => fail('Speech capture cancelled.') };
}
