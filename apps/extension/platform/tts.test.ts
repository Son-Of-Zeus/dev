import { describe, expect, it, vi } from 'vitest';
import { createChromeSpeech, type ChromeSpeechApi } from './tts';

describe('Chrome speech', () => {
  it('selects Hindi, completes on end, and resolves cancellation', async () => {
    let event!: (value: { type: string }) => void;
    const api: ChromeSpeechApi = { getVoices: async () => [{ lang: 'hi-IN', voiceName: 'Hindi' }], stop: vi.fn(), speak: vi.fn((_text, options) => { event = options.onEvent; }) };
    const speech = createChromeSpeech(api);
    const speaking = speech.speak('यहाँ क्लिक करें।', 'hi-IN');
    await vi.waitFor(() => expect(api.speak).toHaveBeenCalled()); event({ type: 'end' });
    expect(await speaking).toEqual({});
    const cancelled = speech.speak('Stop', 'hi-IN'); await vi.waitFor(() => expect(api.speak).toHaveBeenCalledTimes(2)); speech.cancel();
    expect(await cancelled).toEqual({});
    expect(api.stop).toHaveBeenCalled();
  });
  it('returns a visible notice when a voice is absent or the engine fails', async () => {
    const api: ChromeSpeechApi = { getVoices: async () => [], stop: vi.fn(), speak: vi.fn() };
    expect((await createChromeSpeech(api).speak('Hello', 'en-IN')).warning).toContain('No English voice');
    api.getVoices = async () => [{ lang: 'en-US', voiceName: 'English' }];
    api.speak = (_text, options) => options.onEvent({ type: 'error' });
    expect((await createChromeSpeech(api).speak('Hello', 'en-IN')).warning).toContain('unavailable');
  });
  it('does not start speech if cancelled during voice lookup', async () => {
    let resolve!: (voices: Array<{lang: string}>) => void;
    const api: ChromeSpeechApi = { getVoices: () => new Promise((r) => { resolve = r; }), stop: vi.fn(), speak: vi.fn() };
    const output = createChromeSpeech(api); const pending = output.speak('Hello'); output.cancel(); resolve([{ lang: 'en-IN' }]);
    await pending; expect(api.speak).not.toHaveBeenCalled();
  });
});

describe('fixed Chrome voices', () => {
  function harness() {
    let voices = [{voiceName:'Zeta',lang:'en-US',extensionId:'engine-z'}, {voiceName:'Alpha',lang:'en-US',extensionId:'engine-a'}];
    const values = new Map<string, unknown>();
    const store = {get:vi.fn(async(family:string)=>values.get(family)),set:vi.fn(async(family:string,voice:unknown)=>{values.set(family,voice);})};
    const api: ChromeSpeechApi = {getVoices:async()=>voices,stop:vi.fn(),speak:vi.fn((_text,options)=>options.onEvent({type:'end'}))};
    return {api,store,values,setVoices:(value:typeof voices)=>{voices=value;}};
  }
  it('keeps the same named voice and engine after reordering and worker restart', async () => {
    const h=harness(); await createChromeSpeech(h.api,h.store).speak('First');
    expect(h.api.speak).toHaveBeenLastCalledWith('First',expect.objectContaining({voiceName:'Alpha',extensionId:'engine-a',lang:'en-US',rate:1,pitch:1}));
    h.setVoices([{voiceName:'Zeta',lang:'en-US',extensionId:'engine-z'},{voiceName:'Alpha',lang:'en-US',extensionId:'engine-a'}].reverse());
    await createChromeSpeech(h.api,h.store).speak('Next');
    expect(h.api.speak).toHaveBeenLastCalledWith('Next',expect.objectContaining({voiceName:'Alpha',extensionId:'engine-a'}));
    expect(h.store.set).toHaveBeenCalledTimes(1);
  });
  it('shows a notice instead of swapping a missing saved voice', async () => {
    const h=harness(); const speech=createChromeSpeech(h.api,h.store); await speech.speak('First');
    h.setVoices([{voiceName:'Zeta',lang:'en-US',extensionId:'engine-z'}]);
    expect((await speech.speak('Next')).warning).toContain('saved voice is unavailable');
    expect(h.api.speak).toHaveBeenCalledTimes(1);
  });
  it('uses a saved preference and keeps English and Hindi choices separate', async () => {
    const h=harness(); h.values.set('en',{voiceName:'Zeta',lang:'en-US',extensionId:'engine-z'});
    h.setVoices([{voiceName:'Zeta',lang:'en-US',extensionId:'engine-z'},{voiceName:'Hindi',lang:'hi-IN',extensionId:'engine-hi'}]);
    const speech=createChromeSpeech(h.api,h.store); await speech.speak('English'); await speech.speak('हिन्दी','hi-IN'); await speech.speak('English again');
    expect(h.api.speak).toHaveBeenLastCalledWith('English again',expect.objectContaining({voiceName:'Zeta',extensionId:'engine-z'}));
    expect(h.values.get('hi')).toMatchObject({voiceName:'Hindi'});
  });
});
