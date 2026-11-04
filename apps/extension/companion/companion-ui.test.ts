import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANION_STATE_LABELS,
  createCompanionUiStore,
  getDockedCompanionPosition,
  getCompanionPosition,
} from './companion-ui';

function rect(top: number, bottom: number, left = 100, right = 300): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('companion UI', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('positions beside the target and flips left when right-side space is unavailable', () => {
    expect(
      getCompanionPosition(rect(100, 160, 100, 300), {
        width: 1200,
        height: 800,
      }),
    ).toEqual({ left: 312, top: 108 });

    expect(
      getCompanionPosition(rect(100, 160, 1080, 1180), {
        width: 1200,
        height: 800,
      }),
    ).toEqual({ left: 1024, top: 108 });
  });

  it('clamps the companion inside the viewport edges', () => {
    expect(
      getCompanionPosition(rect(-100, -40, -80, -20), {
        width: 320,
        height: 240,
      }),
    ).toEqual({ left: 14, top: 14 });
  });

  it('uses explicit dock coordinates so movement to a target can interpolate', () => {
    expect(
      getDockedCompanionPosition({
        width: 1200,
        height: 800,
      }),
    ).toEqual({ left: 844, top: 740 });
  });

  it('publishes state and target changes through the external store', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState('guiding');
    store.setTarget(rect(20, 80));

    expect(store.getSnapshot()).toMatchObject({
      state: 'guiding',
      targetRect: { top: 20, bottom: 80 },
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(COMPANION_STATE_LABELS.guiding).toBe('Look here');
  });

  it('tracks a slow-work notice without allowing it to persist into another state', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);

    store.setState('thinking');
    store.setLatencyNotice(true);
    expect(store.getSnapshot()).toMatchObject({
      state: 'thinking',
      latencyNotice: true,
    });

    store.setState('error');
    expect(store.getSnapshot()).toMatchObject({
      state: 'error',
      latencyNotice: false,
    });
  });

  it('records a bounded latency breakdown and clears it for a new run', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);

    store.recordLatency({ stage: 'speech-to-text', durationMs: 820.4 });
    store.recordLatency({ stage: 'reasoning', durationMs: 1_240.2 });

    expect(store.getSnapshot().latencyMetrics).toEqual([
      { stage: 'speech-to-text', durationMs: 820.4 },
      { stage: 'reasoning', durationMs: 1_240.2 },
    ]);

    store.clearLatencyMetrics();
    expect(store.getSnapshot().latencyMetrics).toEqual([]);
  });

  it('creates pointer-transparent focus and highlight layers without changing page styles', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    const target = rect(40, 120, 50, 250);

    store.activateFocusMask(target);
    store.highlight(target);

    const focusMask = host.querySelector('[data-companion-layer="focus-mask"]') as HTMLElement;
    const highlight = host.querySelector('[data-companion-layer="highlight"]') as HTMLElement;
    expect(focusMask.hidden).toBe(false);
    expect(highlight.hidden).toBe(false);
    expect(focusMask.className).toContain('companion-focus-mask');
    expect(focusMask.style.left).toBe('50px');
    expect(focusMask.style.top).toBe('40px');
    expect(focusMask.style.width).toBe('200px');
    expect(focusMask.style.height).toBe('80px');
    expect(highlight.style.left).toBe('50px');
    expect(highlight.style.top).toBe('40px');
    expect(highlight.style.pointerEvents).toBe('');
    expect(store.getSnapshot().focusMaskActive).toBe(true);
  });

  it('clears presentation layers and removes them on destroy', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    const target = rect(20, 80);
    store.activateFocusMask(target);
    store.highlight(target);

    store.clear();
    expect(store.getSnapshot()).toMatchObject({
      focusMaskActive: false,
      highlightRect: null,
      targetRect: null,
    });
    expect((host.querySelector('[data-companion-layer="focus-mask"]') as HTMLElement).hidden).toBe(true);

    store.destroy();
    expect(host.querySelector('[data-companion-layer]')).toBeNull();
  });

  it('toggles listening without introducing a chat transcript or message feed', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);

    store.toggleListening();
    expect(store.getSnapshot().state).toBe('listening');
    store.toggleListening();
    expect(store.getSnapshot().state).toBe('idle');
    expect(host.querySelector('[role="log"]')).toBeNull();
    expect(host.querySelector('aside')).toBeNull();
  });

  it('delegates microphone clicks to the runtime when a listening handler is attached', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    const handler = vi.fn();
    store.setListeningHandler(handler);

    store.toggleListening();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().state).toBe('idle');
  });

  it('resets local presentation state when no runtime handler is attached', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);

    store.setState('waiting');
    const target = rect(20, 80);
    store.activateFocusMask(target);
    store.highlight(target);
    store.stopTask();

    expect(store.getSnapshot()).toMatchObject({
      state: 'idle',
      focusMaskActive: false,
      targetRect: null,
      highlightRect: null,
    });
  });

  it('delegates task reset to the runtime when a reset handler is attached', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    const handler = vi.fn();
    store.setStopHandler(handler);

    store.stopTask();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('error presentation and provider changes', () => {
  it('clears the prior instruction and transcript after failure', () => {
    const store = createCompanionUiStore(document.createElement('div'));
    store.setInstruction('Open deployment history.'); store.setTranscript('Old request');
    store.setNotice('The page changed.'); store.setState('error');
    expect(store.getSnapshot()).toMatchObject({ instruction: '', transcript: '', notice: 'The page changed.', targetRect: null });
    store.setState('listening'); expect(store.getSnapshot().notice).toBe(''); store.destroy();
  });
  it('keeps the old provider if saving fails and reports the error', async () => {
    const store = createCompanionUiStore(document.createElement('div'));
    store.setProviderHandler(async () => { throw new Error('Finish the current recording.'); });
    await store.changeSpeechProvider('meta');
    expect(store.getSnapshot().speech.provider).toBe('chrome');
    expect(store.getSnapshot().providerPending).toBe(false);
    expect(store.getSnapshot().providerNotice).toContain('Finish'); store.destroy();
  });
});
