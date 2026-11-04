import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuideController, type GuideOverlay } from './guide-controller';
import { createElementRegistry } from '../registry/element-registry';
import { createSessionState } from '../session/session-state';
import type { DiscoveredElement } from '../dom/semantic';
import type { GuideCompanion, GuideSpeech } from './guide-controller';

function rect(top: number, bottom: number, left = 10, right = 210): DOMRect {
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

function discovered(
  element: HTMLElement,
  label = 'Target',
  disabled = false,
): DiscoveredElement {
  return {
    role: 'button',
    label,
    visible: true,
    inViewport: true,
    disabled,
    element,
  };
}

function createHarness(
  initialRect = rect(100, 140),
  disabled = false,
  label = 'Target',
) {
  const element = document.createElement('button');
  element.textContent = label;
  document.body.append(element);
  let currentRect = initialRect;
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => currentRect);
  Object.defineProperty(element, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });

  const registry = createElementRegistry();
  registry.reconcile([discovered(element, label, disabled)]);
  const session = createSessionState();
  const overlay: GuideOverlay = {
    activateFocusMask: vi.fn(),
    highlight: vi.fn(),
    clear: vi.fn(),
  };
  const companion: GuideCompanion = {
    setTarget: vi.fn(),
    setState: vi.fn(),
  };
  const speech: GuideSpeech = {
    say: vi.fn(async () => undefined),
    cancel: vi.fn(),
  };
  const controller = createGuideController({
    document,
    registry,
    session,
    overlay,
    companion,
    speech,
    viewport: () => ({ width: 800, height: 600 }),
    waitForLayout: async () => undefined,
    waitForMovement: async () => undefined,
  });

  return {
    element,
    registry,
    session,
    overlay,
    companion,
    speech,
    controller,
    setRect(nextRect: DOMRect) {
      currentRect = nextRect;
    },
  };
}

describe('guide controller', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('guides to a live target, scrolls when needed, speaks, and waits for the user', async () => {
    const harness = createHarness(rect(900, 940));
    const clickSpy = vi.spyOn(harness.element, 'click');

    const result = await harness.controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Account Settings par click kariye.',
      expectedUserAction: 'click',
      language: 'hi-IN',
    });

    expect(harness.element.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    expect(harness.overlay.activateFocusMask).toHaveBeenCalledTimes(1);
    expect(harness.overlay.activateFocusMask).toHaveBeenCalledWith(
      expect.objectContaining({ top: 900, bottom: 940 }),
    );
    expect(harness.overlay.highlight).toHaveBeenCalledWith(
      expect.objectContaining({ top: 900, bottom: 940 }),
    );
    expect(harness.companion.setTarget).toHaveBeenCalledWith(
      expect.objectContaining({ top: 900, bottom: 940 }),
    );
    expect(harness.speech.say).toHaveBeenCalledWith(
      'Account Settings par click kariye.',
      'hi-IN',
    );
    expect(result).toEqual({ status: 'guided', targetId: 'el_1' });
    expect(harness.session.getState()).toMatchObject({
      pendingAction: { targetId: 'el_1', expectedUserAction: 'click' },
      companionState: 'waiting',
    });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('waits for companion movement to settle before speaking', async () => {
    const harness = createHarness();
    const events: string[] = [];
    let resolveMovement!: () => void;
    const waitForMovement = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMovement = resolve;
        }),
    );
    harness.companion.setTarget = vi.fn(() => {
      events.push('move');
    });
    harness.speech.say = vi.fn(async () => {
      events.push('speak');
    });
    const controller = createGuideController({
      document,
      registry: harness.registry,
      session: harness.session,
      overlay: harness.overlay,
      companion: harness.companion,
      speech: harness.speech,
      viewport: () => ({ width: 800, height: 600 }),
      waitForLayout: async () => undefined,
      waitForMovement,
    });

    const run = controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Target par click kariye.',
      expectedUserAction: 'click',
      language: 'hi-IN',
    });
    await Promise.resolve();

    expect(waitForMovement).toHaveBeenCalledTimes(1);
    expect(harness.speech.say).not.toHaveBeenCalled();
    resolveMovement();

    await expect(run).resolves.toEqual({ status: 'guided', targetId: 'el_1' });
    expect(events).toEqual(['move', 'speak']);
  });

  it('cancels a pending movement before speech can start', async () => {
    const harness = createHarness();
    let resolveMovement!: () => void;
    const waitForMovement = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMovement = resolve;
        }),
    );
    const controller = createGuideController({
      document,
      registry: harness.registry,
      session: harness.session,
      overlay: harness.overlay,
      companion: harness.companion,
      speech: harness.speech,
      viewport: () => ({ width: 800, height: 600 }),
      waitForLayout: async () => undefined,
      waitForMovement,
    });

    const run = controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Target par click kariye.',
      expectedUserAction: 'click',
      language: 'hi-IN',
    });
    await Promise.resolve();
    controller.cancel();
    resolveMovement();

    await expect(run).resolves.toEqual({ status: 'cancelled' });
    expect(harness.speech.say).not.toHaveBeenCalled();
  });

  it('uses auto scrolling when reduced motion is preferred', async () => {
    const harness = createHarness(rect(900, 940));
    const controller = createGuideController({
      document,
      registry: harness.registry,
      session: harness.session,
      overlay: harness.overlay,
      companion: harness.companion,
      speech: harness.speech,
      viewport: () => ({ width: 800, height: 600 }),
      prefersReducedMotion: () => true,
      waitForLayout: async () => undefined,
      waitForMovement: async () => undefined,
    });

    await controller.run({
      action: 'scroll',
      targetId: 'el_1',
    });

    expect(harness.element.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'center',
      inline: 'nearest',
    });
    expect(harness.overlay.highlight).not.toHaveBeenCalled();
  });

  it('rejects stale targets without speaking or interacting with the page', async () => {
    const harness = createHarness();
    harness.element.remove();
    const missing = vi.fn();
    const controller = createGuideController({
      document,
      registry: harness.registry,
      session: harness.session,
      overlay: harness.overlay,
      companion: harness.companion,
      speech: harness.speech,
      onMissingTarget: missing,
    });

    const result = await controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Click.',
      expectedUserAction: 'click',
      language: 'en-IN',
    });

    expect(result).toEqual({ status: 'stale-target', targetId: 'el_1' });
    expect(missing).toHaveBeenCalledWith('el_1');
    expect(harness.speech.say).not.toHaveBeenCalled();
    expect(harness.overlay.highlight).not.toHaveBeenCalled();
  });

  it('blocks guidance to a disabled target before speaking or creating a pending action', async () => {
    const harness = createHarness(rect(100, 140), true);
    const result = await harness.controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Submit par click kariye.',
      expectedUserAction: 'click',
      language: 'en-IN',
    });

    expect(result).toMatchObject({ status: 'blocked' });
    expect(harness.speech.say).not.toHaveBeenCalled();
    expect(harness.overlay.highlight).not.toHaveBeenCalled();
    expect(harness.session.getState().pendingAction).toBeUndefined();
  });

  it('blocks consequential guidance when no consequence explanation is supplied', async () => {
    const harness = createHarness(rect(100, 140), false, 'Submit Request');
    const result = await harness.controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Submit Request par click kariye.',
      expectedUserAction: 'click',
      language: 'hi-IN',
    });

    expect(result).toMatchObject({ status: 'blocked' });
    expect(harness.speech.say).not.toHaveBeenCalled();
    expect(harness.session.getState().pendingAction).toBeUndefined();
  });

  it('speaks the consequence before the manual consequential action instruction', async () => {
    const harness = createHarness(rect(100, 140), false, 'Submit Request');
    const result = await harness.controller.run({
      action: 'guide',
      targetId: 'el_1',
      consequence: 'Isse aapki claim request submit ho jayegi.',
      spokenInstruction: 'Details sahi hain to Submit Request par khud click kariye.',
      expectedUserAction: 'click',
      language: 'hi-IN',
    });

    expect(result).toEqual({ status: 'guided', targetId: 'el_1' });
    expect(harness.speech.say).toHaveBeenCalledWith(
      'Isse aapki claim request submit ho jayegi. Details sahi hain to Submit Request par khud click kariye.',
      'hi-IN',
    );
    expect(harness.session.getState()).toMatchObject({
      pendingAction: { targetId: 'el_1', expectedUserAction: 'click' },
    });
  });

  it('remeasures the target after a resize while waiting', async () => {
    const harness = createHarness();
    await harness.controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Target par click kariye.',
      expectedUserAction: 'click',
      language: 'hi-IN',
    });

    harness.setRect(rect(220, 260));
    window.dispatchEvent(new Event('resize'));

    expect(harness.overlay.highlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 220, bottom: 260 }),
    );
    expect(harness.overlay.activateFocusMask).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 220, bottom: 260 }),
    );
    expect(harness.companion.setTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 220, bottom: 260 }),
    );
  });

  it('remeasures the target while smooth scrolling settles', async () => {
    const harness = createHarness();
    await harness.controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Target par click kariye.',
      expectedUserAction: 'click',
      language: 'hi-IN',
    });

    harness.setRect(rect(420, 460));
    window.dispatchEvent(new Event('scroll'));

    expect(harness.overlay.highlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 420, bottom: 460 }),
    );
    expect(harness.companion.setTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 420, bottom: 460 }),
    );
  });

  it('preserves pending workflow context for explanation actions', async () => {
    const harness = createHarness();
    harness.session.setPendingAction({
      targetId: 'el_1',
      expectedUserAction: 'input',
    });

    const result = await harness.controller.run({
      action: 'explain',
      targetId: 'el_1',
      spokenInstruction: 'Account identifier aapka member number hota hai.',
      language: 'hi-IN',
    });

    expect(result).toEqual({ status: 'completed', action: 'explain' });
    expect(harness.session.getState()).toMatchObject({
      pendingAction: { targetId: 'el_1', expectedUserAction: 'input' },
      companionState: 'waiting',
    });
    expect(harness.overlay.clear).toHaveBeenCalled();
  });

  it('speaks a general explanation without requiring a target', async () => {
    const harness = createHarness();

    const result = await harness.controller.run({
      action: 'explain',
      spokenInstruction: 'These options differ by eligibility and outcome.',
      language: 'en-IN',
    });

    expect(result).toEqual({ status: 'completed', action: 'explain' });
    expect(harness.speech.say).toHaveBeenCalledWith(
      'These options differ by eligibility and outcome.',
      'en-IN',
    );
    expect(harness.overlay.highlight).not.toHaveBeenCalled();
  });

  it('cancels speech and pending guidance without allowing a late result to enter waiting', async () => {
    let resolveSpeech!: () => void;
    const harness = createHarness();
    harness.speech.say = vi.fn(
      () => new Promise<void>((resolve) => (resolveSpeech = resolve)),
    );

    const run = harness.controller.run({
      action: 'guide',
      targetId: 'el_1',
      spokenInstruction: 'Click.',
      expectedUserAction: 'click',
      language: 'en-IN',
    });
    await vi.waitFor(() => {
      expect(harness.speech.say).toHaveBeenCalledTimes(1);
    });
    harness.controller.cancel();
    resolveSpeech();

    await expect(run).resolves.toEqual({ status: 'cancelled' });
    expect(harness.speech.cancel).toHaveBeenCalled();
    expect(harness.session.getState()).toMatchObject({
      pendingAction: undefined,
      companionState: 'idle',
    });
  });

  it('can cancel an explanation interruption while preserving the current pending action', () => {
    const harness = createHarness();
    harness.session.setPendingAction({
      targetId: 'el_1',
      expectedUserAction: 'click',
    });

    harness.controller.cancel({ preservePendingAction: true });

    expect(harness.session.getState()).toMatchObject({
      pendingAction: { targetId: 'el_1', expectedUserAction: 'click' },
      companionState: 'idle',
    });
  });
});
