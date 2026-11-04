import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sendMessage: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.sendMessage, onMessage: { addListener: mocks.addListener, removeListener: mocks.removeListener } } } }));
import { createContentBridge } from './content-bridge';

describe('inactive document cleanup', () => {
  it('removes a stale interface once and does not loop on cleanup requests', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, code: 'STALE_DOCUMENT', error: 'The page changed.' });
    const cleanup = vi.fn(); const bridge = createContentBridge(() => {}, cleanup);
    await expect(bridge.speechOutput.speak('Open settings', 'en-IN')).rejects.toThrow('page changed');
    bridge.destroy(); bridge.speechOutput.cancel();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('stream delivery lifetime', () => {
  it('accepts plan updates after the first action but ignores them after Stop', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue({ ok: true, data: { action: { action: 'wait' }, timings: [] } });
    const bridge = createContentBridge();
    const listener = mocks.addListener.mock.calls.at(-1)![0];
    const updates = vi.fn(); bridge.reasoner.subscribePlan!(updates);
    await bridge.reasoner.reason({ userUtterance: 'Open settings', session: { recentActions: [] }, page: { elements: [] } });
    const message = mocks.sendMessage.mock.calls.find(([message]) => message.op === 'reason-stream')![0];
    const plan = { id: 'test-plan', currentStepIndex: 0, complete: false, steps: [{ targetDescription: 'Settings', spokenInstruction: 'Open Settings.', language: 'en-IN', precondition: 'Home is visible.', expectedOutcome: 'Settings is visible.' }] };
    listener({ target: 'content', type: 'reason-event', requestId: message.requestId, event: { type: 'plan', plan } });
    expect(updates).toHaveBeenCalledTimes(1);
    bridge.reasoner.cancelPlans!();
    listener({ target: 'content', type: 'reason-event', requestId: message.requestId, event: { type: 'plan', plan } });
    expect(updates).toHaveBeenCalledTimes(1);
    bridge.destroy();
  });
});
