import { describe, it, expect, vi } from 'vitest';
import { createVoiceController, type SpeechInput, type SpeechOutput, type SpeechToTextResult } from './voice';
import { createPcmEncoder } from '../public/pcm-worklet.js';

describe('streaming voice controller', () => {
  function setup() {
    let partial!: (text: string) => void;
    let finish!: (value: SpeechToTextResult) => void;
    let reject!: (error: Error) => void;
    const input: SpeechInput = { listen: vi.fn((onPartial) => { partial = onPartial; return new Promise<SpeechToTextResult>((yes, no) => { finish = yes; reject = no; }); }), stop: vi.fn(), cancel: vi.fn() };
    const output: SpeechOutput = { speak: vi.fn(async () => ({})), cancel: vi.fn() };
    const onPartial = vi.fn(), onInstruction = vi.fn(), onNotice = vi.fn();
    const voice = createVoiceController({ speechInput: input, speechOutput: output, onPartial, onInstruction, onNotice });
    return { voice, input, output, onPartial, onInstruction, onNotice, partial: (text: string) => partial(text), finish: (value: SpeechToTextResult) => finish(value), reject: (error: Error) => reject(error) };
  }
  it('shows partials without completing a turn until final speech', async () => {
    const h = setup(); let settled = false; const result = h.voice.listen().then((value) => { settled = true; return value; });
    h.partial('Open'); await Promise.resolve(); expect(settled).toBe(false); expect(h.onPartial).toHaveBeenCalledWith('Open');
    h.finish({ transcript: 'Open settings' }); expect(await result).toEqual({ status: 'transcript', transcript: 'Open settings' });
  });
  it('stops input while awaiting a final transcript', async () => {
    const h = setup(); const turn = h.voice.listen(); h.voice.stopListening(); expect(h.input.stop).toHaveBeenCalled(); expect(h.voice.getState()).toBe('transcribing'); h.finish({ transcript: 'सेटिंग खोलें' }); expect((await turn).status).toBe('transcript');
  });
  it('discards cancelled transcripts and surfaces permission/connection failures', async () => {
    const h = setup(); const turn = h.voice.listen(); h.voice.cancel(); h.partial('stale'); h.finish({ transcript: 'stale' }); expect(await turn).toEqual({ status: 'cancelled' }); expect(h.onPartial).not.toHaveBeenCalled();
    const next = h.voice.listen(); h.reject(new Error('Microphone access denied')); expect(await next).toMatchObject({ status: 'error', error: { message: 'Microphone access denied' } });
  });
  it('keeps spoken instructions visible when no matching voice exists', async () => {
    const h = setup(); h.output.speak = async () => ({ warning: 'No Hindi voice' }); await h.voice.say('सेटिंग खोलें', 'hi-IN'); expect(h.onInstruction).toHaveBeenCalledWith('सेटिंग खोलें'); expect(h.onNotice).toHaveBeenCalledWith('No Hindi voice');
  });
});

describe('PCM capture', () => {
  it('produces signed 16-bit mono samples with clipping', () => {
    const encoder = createPcmEncoder(24000, 24000, 4);
    const packets = encoder.push(new Float32Array([-2, -1, 0, 1, 2, 0]));
    expect(Array.from(new Int16Array(packets[0]!))).toEqual([-32768, -32768, 0, 32767]);
  });
  it('keeps resampling phase continuous across worklet frames', () => {
    const source = Float32Array.from({length: 4801}, (_, i) => Math.sin(i / 10));
    const whole = createPcmEncoder(48000, 24000, 1920);
    const split = createPcmEncoder(48000, 24000, 1920);
    const one = [...whole.push(source), whole.flush()];
    const chunks: ArrayBuffer[] = [];
    for (let index = 0; index < source.length; index += 128) chunks.push(...split.push(source.slice(index, index + 128)));
    chunks.push(split.flush());
    const samples = (buffers: ArrayBuffer[]) => buffers.flatMap((buffer) => Array.from(new Int16Array(buffer)));
    expect(samples(chunks)).toEqual(samples(one)); expect(samples(one)).toHaveLength(2400);
  });
});
