import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionRuntime } from './extension-runtime';
import { createCompanionUiStore } from '../companion/companion-ui';
import { createElementRegistry } from '../registry/element-registry';
import type { Reasoner, GuideAction, ReasonRequest } from '../reasoning/reasoning';
import type { SpeechInput, SpeechOutput } from '../voice/voice';

const running: Array<ReturnType<typeof createExtensionRuntime>> = [];
afterEach(() => { for (const runtime of running.splice(0)) runtime.stop(); });
beforeEach(() => { document.body.innerHTML = ''; });
function harness(reasoner: Reasoner, transcripts = ['Help me with this task', 'I am done'], initialSession?: import('../session/session-state').SessionState) {
  document.querySelectorAll<HTMLElement>('button,input,select').forEach((node) => {
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 60, left: 20, right: 200, width: 180, height: 40 } as DOMRect);
    node.scrollIntoView = vi.fn();
  });
  const host = document.createElement('div'); host.dataset.voiceCompanionApp = 'true'; document.body.append(host);
  const companion = createCompanionUiStore(host);
  const input: SpeechInput = { listen: vi.fn(async () => ({ transcript: transcripts.shift() ?? 'I am done', language: 'en-IN' })), stop: vi.fn(), cancel: vi.fn() };
  const output: SpeechOutput = { speak: vi.fn(async () => ({})), cancel: vi.fn() };
  const changed = vi.fn();
  const runtime = createExtensionRuntime({ document, companion, reasoner, initialSession, speechInput: input, speechOutput: output, onSessionChange: changed, viewport: () => ({ width: 800, height: 600 }), waitForLayout: async () => {}, waitForMovement: async () => {}, waitForPageSettled: async () => {}, latency: { logger: vi.fn() } });
  running.push(runtime); runtime.start();
  return { runtime, companion, input, output, changed };
}
function guide(targetId: string, expectedUserAction: 'click' | 'input' | 'select', spokenInstruction = 'Use this control.'): GuideAction {
  return { action: 'guide', targetId, expectedUserAction, spokenInstruction, language: 'en-IN' };
}

describe('general task integration', () => {
  it('guides a search field and waits for explicit input completion', async () => {
    document.body.innerHTML = '<label>Search catalog<input aria-label="Search catalog"></label><button>Search</button>';
    const reasoner: Reasoner = { reason: vi.fn(async (request: ReasonRequest): Promise<GuideAction> => {
      const completed = request.userUtterance === 'I am done';
      const target = request.page.elements.find((element) => element.role === (completed ? 'button' : 'textbox'))!;
      return guide(target.id, completed ? 'click' : 'input');
    }) };
    const h = harness(reasoner);
    const button = document.querySelector('button')!; const clicked = vi.fn(); button.addEventListener('click', clicked);
    await h.runtime.flow.requestVoice();
    const input = document.querySelector('input')!; input.value = 'synthetic catalog term'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 270));
    expect(reasoner.reason).toHaveBeenCalledTimes(1);
    expect(h.runtime.session.getState().pendingAction?.expectedUserAction).toBe('input');
    await h.runtime.flow.requestVoice();
    expect(h.runtime.session.getState().pendingAction?.expectedUserAction).toBe('click');
    expect(JSON.stringify(vi.mocked(reasoner.reason).mock.calls)).not.toContain('synthetic catalog term');
    expect(clicked).not.toHaveBeenCalled(); expect(h.companion.getSnapshot().instruction).toBe('Use this control.');
  });
  it('guides settings and observes only manual navigation', async () => {
    document.body.innerHTML = '<button>Settings</button>';
    const reasoner: Reasoner = { reason: vi.fn(async (request: ReasonRequest): Promise<GuideAction> => request.session.recentActions.length ? { action: 'wait' } : guide(request.page.elements[0]!.id, 'click')) };
    const h = harness(reasoner); const button = document.querySelector('button')!; const click = vi.fn(); button.addEventListener('click', click);
    await h.runtime.flow.requestVoice(); expect(click).not.toHaveBeenCalled();
    button.click(); await vi.waitFor(() => expect(reasoner.reason).toHaveBeenCalledTimes(2));
    expect(click).toHaveBeenCalledTimes(1); expect(h.runtime.session.getState().recentActions[0]?.label).toBe('Settings');
  });
  it('guides a select and preserves visible guidance if no speech voice is installed', async () => {
    document.body.innerHTML = '<label>Display theme<select><option value="light">Light</option><option value="dark">Dark</option></select></label>';
    const reasoner: Reasoner = { reason: vi.fn(async (request: ReasonRequest): Promise<GuideAction> => request.session.recentActions.length ? { action: 'wait' } : guide(request.page.elements[0]!.id, 'select')) };
    const h = harness(reasoner); h.output.speak = async () => ({ warning: 'No English voice is available.' });
    await h.runtime.flow.requestVoice(); expect(h.companion.getSnapshot().notice).toContain('No English voice');
    const select = document.querySelector('select')!; expect(select.value).toBe('light'); select.value = 'dark'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(reasoner.reason).toHaveBeenCalledTimes(2));
  });
  it('discards in-flight guidance after task reset', async () => {
    document.body.innerHTML = '<button>Settings</button>';
    let finish!: (value: GuideAction) => void;
    const h = harness({ reason: () => new Promise((resolve) => { finish = resolve; }) });
    const pending = h.runtime.flow.requestVoice(); await vi.waitFor(() => expect(finish).toBeDefined());
    h.companion.stopTask(); finish(guide('el_1', 'click')); expect(await pending).toEqual({ status: 'cancelled' });
    expect(h.output.speak).not.toHaveBeenCalled(); expect(h.runtime.session.getState().goal).toBeUndefined();
  });
  it('rejects a control disabled while planning is pending', async () => {
    document.body.innerHTML = '<button>Settings</button>';
    let finish!: (value: GuideAction) => void;
    const reason = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(guide('el_1', 'click'));
    const h = harness({ reason });
    const pending = h.runtime.flow.requestVoice(); await vi.waitFor(() => expect(finish).toBeDefined());
    document.querySelector('button')!.disabled = true; finish(guide('el_1', 'click'));
    expect((await pending).status).toBe('error'); expect(h.output.speak).not.toHaveBeenCalled();
  });
});

describe('Stop and stale-page recovery', () => {
  it('Stop clears task memory and ignores clicks, typing, navigation, and mutations', async () => {
    document.body.innerHTML = '<button>Settings</button><input aria-label="Name">';
    const reason = vi.fn(async (request: ReasonRequest) => guide(request.page.elements[0]!.id, 'click'));
    const cancelPlans = vi.fn();
    const h = harness({ reason, cancelPlans });
    await h.runtime.flow.requestVoice();
    h.companion.stopTask();
    const calls = reason.mock.calls.length;
    document.querySelector('button')!.click();
    document.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button')!.textContent = 'Changed';
    window.dispatchEvent(new Event('popstate'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reason).toHaveBeenCalledTimes(calls);
    expect(cancelPlans).toHaveBeenCalled();
    expect(h.runtime.session.getState()).toMatchObject({ goal: undefined, recentActions: [], pendingAction: undefined });
    expect(h.runtime.flow.getSnapshot()).toMatchObject({ phase: 'idle', taskActive: false });
    expect(h.runtime.flow.getSnapshot().lastTranscript).toBeUndefined();
    expect(h.companion.getSnapshot()).toMatchObject({ state: 'idle', instruction: '', transcript: '', targetRect: null });
    expect(h.changed.mock.calls.at(-1)![0].goal).toBeUndefined();
    await h.runtime.flow.requestVoice();
    expect(reason).toHaveBeenCalledTimes(calls + 1);
  });

  it('Stop cancels a recording without processing its late transcript', async () => {
    document.body.innerHTML = '<button>Settings</button>';
    const reason = vi.fn(async () => ({ action: 'wait' as const }));
    const h = harness({ reason });
    let finish!: (value: { transcript: string }) => void;
    h.input.listen = vi.fn(() => new Promise<{ transcript: string }>((resolve) => { finish = resolve; }));
    const pending = h.runtime.flow.requestVoice();
    await vi.waitFor(() => expect(h.runtime.voice.getState()).toBe('listening'));
    h.companion.toggleListening();
    finish({ transcript: 'This must be discarded' });
    expect((await pending).status).toBe('cancelled');
    expect(h.input.stop).not.toHaveBeenCalled();
    expect(h.input.cancel).toHaveBeenCalled();
    expect(reason).not.toHaveBeenCalled();
  });

  it('Finish recording processes the transcript and does not stop the task', async () => {
    document.body.innerHTML = '<button>Settings</button>';
    const reason = vi.fn(async () => ({ action: 'wait' as const }));
    const h = harness({ reason });
    let finish!: (value: { transcript: string }) => void;
    h.input.listen = vi.fn(() => new Promise<{ transcript: string }>((resolve) => { finish = resolve; }));
    const pending = h.runtime.flow.requestVoice();
    h.companion.finishRecording();
    expect(h.input.stop).toHaveBeenCalledTimes(1);
    finish({ transcript: 'Help me with settings' });
    expect((await pending).status).toBe('completed');
    expect(reason).toHaveBeenCalledTimes(1);
    expect(h.runtime.flow.getSnapshot().taskActive).toBe(true);
  });

  it('rescans and asks Jev again when an identical-looking control is replaced', async () => {
    document.body.innerHTML = '<button>Settings</button>';
    let finish!: (value: GuideAction) => void;
    const reason = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockImplementation(async (request: ReasonRequest) => guide(request.page.elements[0]!.id, 'click'));
    const h = harness({ reason });
    const pending = h.runtime.flow.requestVoice();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const replacement = document.createElement('button'); replacement.textContent = 'Settings';
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 60, left: 20, right: 200, width: 180, height: 40 } as DOMRect);
    document.querySelector('button')!.replaceWith(replacement);
    finish(guide('el_1', 'click'));
    expect((await pending).status).toBe('completed');
    expect(reason).toHaveBeenCalledTimes(2);
    expect(reason.mock.calls[1]![0].page.elements[0].id).not.toBe('el_1');
    expect(h.output.speak).toHaveBeenCalledTimes(1);
    expect(h.runtime.flow.getSnapshot().retryTranscript).toBeUndefined();
  });
});

describe('document restore', () => {
  it('does not wait for an unfinished stream from the previous document', async () => {
    document.body.innerHTML = '<button>Language</button>';
    const step = { targetDescription: 'Settings button', spokenInstruction: 'Open Settings.', language: 'en-IN' as const, precondition: 'Home is visible.', expectedOutcome: 'Settings is visible.' };
    const reason = vi.fn(async (request: ReasonRequest) => {
      expect(request.session.decisionContext?.plan?.complete).toBe(true);
      return { action: 'wait' as const };
    });
    const h = harness({ reason }, [], { goal: 'Change the website language', companionState: 'idle', recentActions: [], decisionContext: { taskStatus: 'active', plan: { id: 'old-document-plan', steps: [step], currentStepIndex: 1, complete: false } } });
    await vi.waitFor(() => expect(reason).toHaveBeenCalledTimes(1));
    expect(h.runtime.session.getState().decisionContext?.plan?.complete).toBe(true);
  });

  it('does not resume a task after its cleared Stop state is restored', async () => {
    document.body.innerHTML = '<button>Settings</button>';
    const h = harness({ reason: vi.fn(async () => ({ action: 'wait' as const })) });
    await h.runtime.flow.requestVoice();
    h.companion.stopTask();
    const saved = h.changed.mock.calls.at(-1)![0];
    h.runtime.stop();
    const reason = vi.fn(async () => ({ action: 'wait' as const }));
    const restored = harness({ reason }, [], saved);
    document.querySelector('button')!.click();
    expect(restored.runtime.flow.getSnapshot()).toMatchObject({ phase: 'idle', taskActive: false });
    expect(reason).not.toHaveBeenCalled();
  });
});
