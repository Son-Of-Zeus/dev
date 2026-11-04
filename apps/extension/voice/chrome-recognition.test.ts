import { afterEach, describe, expect, it, vi } from 'vitest';
import { startChromeRecognition, type RecognitionEngine } from './chrome-recognition';
function harness() {
  let engine!: RecognitionEngine;
  class Recognition implements RecognitionEngine {
    lang = ''; continuous = true; interimResults = false; maxAlternatives = 0;
    onresult: RecognitionEngine['onresult'] = null; onerror: RecognitionEngine['onerror'] = null;
    onend: RecognitionEngine['onend'] = null; onaudioend: RecognitionEngine['onaudioend'] = null;
    start = vi.fn(); stop = vi.fn(); abort = vi.fn();
    constructor() { engine = this; }
  }
  const partial = vi.fn(); const capture = startChromeRecognition(Recognition, 'en-IN', partial);
  return {engine,capture,partial};
}
afterEach(() => vi.useRealTimers());
describe('Chrome speech recognition', () => {
  it('shows interim text and resolves only a final transcript after recognition ends', async () => {
    const h=harness(); expect(h.engine.lang).toBe('en-IN'); expect(h.engine.continuous).toBe(false); expect(h.engine.interimResults).toBe(true);
    h.engine.onresult?.({results:[{0:{transcript:'open'},isFinal:false}]}); expect(h.partial).toHaveBeenCalledWith('open');
    h.engine.onresult?.({results:[{0:{transcript:'Open settings'},isFinal:true}]}); expect(h.engine.stop).toHaveBeenCalled();
    h.engine.onend?.(); expect(await h.capture.result).toMatchObject({transcript:'Open settings',language:'en-IN'}); expect(h.engine.abort).toHaveBeenCalled();
  });
  it('manual stop waits for a final result and does not accept interim text as final', async () => {
    const h=harness(); h.engine.onresult?.({results:[{0:{transcript:'unfinished'},isFinal:false}]}); h.capture.stop();
    h.engine.onend?.(); await expect(h.capture.result).rejects.toThrow('no final speech');
  });
  it('cancellation rejects immediately and ignores a queued result event', async () => {
    const h=harness(); const late=h.engine.onresult; h.capture.cancel();
    await expect(h.capture.result).rejects.toThrow('cancelled'); late?.({results:[{0:{transcript:'late'},isFinal:true}]});
    expect(h.partial).not.toHaveBeenCalled();
  });
  it('reports permission, network, and unsupported browser failures', async () => {
    for(const [error,message] of [['not-allowed','NEED_MIC_PERMISSION'],['network','cannot connect'],['no-speech','No speech']]) {
      const h=harness(); h.engine.onerror?.({error:error!}); await expect(h.capture.result).rejects.toThrow(message!);
    }
    await expect(startChromeRecognition(undefined,'en-IN',()=>{}).result).rejects.toThrow('unavailable');
  });
  it('stops at 30 seconds and times out a missing final response', async () => {
    vi.useFakeTimers();const h=harness();const failure=expect(h.capture.result).rejects.toThrow('final transcript');
    await vi.advanceTimersByTimeAsync(30_000);expect(h.engine.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);await failure;expect(h.engine.abort).toHaveBeenCalled();
  });
});
