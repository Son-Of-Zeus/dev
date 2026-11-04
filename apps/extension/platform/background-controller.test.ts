import { describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
import { installBackground } from './background-controller';
import { safeSession, webOrigin } from './session';

function event() {
  const listeners: Array<(...args: any[]) => any> = [];
  return { listeners, addListener: (listener: (...args: any[]) => any) => listeners.push(listener), emit: (...args: any[]) => listeners.forEach((listener) => listener(...args)) };
}
function harness() {
  const values: Record<string, unknown> = {};
  const documents = new Map<number, string>();
  const api = {
    storage: { local: { get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]))), set: vi.fn(async (entries: object) => { Object.assign(values, structuredClone(entries)); }) }, session: { get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })), set: vi.fn(async (entries: object) => { Object.assign(values, structuredClone(entries)); }), remove: vi.fn(async (key: string) => { delete values[key]; }) } },
    action: { onClicked: event(), setTitle: vi.fn(async () => {}) },
    tabs: { onUpdated: event(), onRemoved: event(), sendMessage: vi.fn(async () => {}), create: vi.fn(async () => {}) },
    scripting: { executeScript: vi.fn(async (options: any) => [{ documentId: documents.get(options.target.tabId) ?? 'doc-1' }]) },
    runtime: { id: 'extension', openOptionsPage: vi.fn(async () => {}), getURL: (path: string) => `chrome-extension://extension${path}`, onMessage: event(), sendMessage: vi.fn(async () => ({ ok: true, data: { transcript: 'Open settings' } })) },
    offscreen: { hasDocument: vi.fn(async () => true), createDocument: vi.fn(async () => {}) },
    tts: { getVoices: vi.fn(async () => []), speak: vi.fn(), stop: vi.fn() },
  };
  installBackground(api as any);
  const sender = (tabId = 1, documentId = documents.get(tabId) ?? 'doc-1', url = 'https://example.com/settings') => ({ id: 'extension', frameId: 0, documentId, tab: { id: tabId }, url });
  const dispatch = (op: string, data: object = {}, source: object = sender()): Promise<any> => new Promise((resolve) => api.runtime.onMessage.listeners[0]!({ target: 'background', op, ...data }, source, resolve));
  const activate = async (tabId = 1) => {
    api.action.onClicked.emit({ id: tabId, url: 'https://example.com/settings' });
    await vi.waitFor(() => expect(values[`companion:tab:${tabId}`]).toBeDefined());
    await dispatch('context', {}, sender(tabId));
  };
  return { api, values, documents, sender, dispatch, activate };
}

describe('icon activation and session boundary', () => {
  it('injects only on request and toggles off without duplicate active sessions', async () => {
    const h = harness(); expect(h.api.scripting.executeScript).not.toHaveBeenCalled(); await h.activate();
    expect(h.api.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ files: ['/content-scripts/content.js'] }));
    h.api.action.onClicked.emit({ id: 1, url: 'https://example.com/settings' });
    await vi.waitFor(() => expect(h.values['companion:tab:1']).toBeUndefined());
    expect(h.api.tabs.sendMessage).toHaveBeenCalledWith(1, { target: 'content', type: 'shutdown' });
  });
  it('restores safe task state after reload and rejects the old document', async () => {
    const h = harness(); await h.activate();
    await h.dispatch('save-session', { state: { goal: 'Find settings', recentActions: [], pendingAction: { targetId: 'el_1' } } });
    h.documents.set(1, 'doc-2');
    h.api.tabs.onUpdated.emit(1, { status: 'loading' }, { url: 'https://example.com/next' });
    await vi.waitFor(() => expect((h.values['companion:tab:1'] as any).documentId).toBeUndefined());
    expect((await h.dispatch('save-session', { state: { goal: 'stale' } }, h.sender(1, 'doc-1'))).ok).toBe(false);
    const restored = await h.dispatch('context', {}, h.sender());
    expect(restored.data.goal).toBe('Find settings'); expect(restored.data.pendingAction).toBeUndefined();
    h.api.tabs.onUpdated.emit(1, { status: 'complete' }, { url: 'https://example.com/next' });
    await vi.waitFor(() => expect(h.api.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ files: ['/content-scripts/content.js'] })));
  });
  it('clears context across origins and on tab close, with per-tab isolation', async () => {
    const h = harness(); await h.activate(1); await h.activate(2);
    h.api.tabs.onUpdated.emit(1, { url: 'https://another.example/' }, { url: 'https://another.example/' });
    await vi.waitFor(() => expect(h.values['companion:tab:1']).toBeUndefined());
    expect(h.values['companion:tab:2']).toBeDefined();
    h.api.tabs.onRemoved.emit(2);
    await vi.waitFor(() => expect(h.values['companion:tab:2']).toBeUndefined());
  });
  it('blocks restricted pages, subframes, stale documents and arbitrary operations', async () => {
    const h = harness(); h.api.action.onClicked.emit({ id: 1, url: 'chrome://settings' });
    await vi.waitFor(() => expect(h.api.action.setTitle).toHaveBeenCalled()); expect(h.api.scripting.executeScript).not.toHaveBeenCalled();
    await h.activate();
    expect((await h.dispatch('fetch-url', { url: 'https://unapproved.example' })).ok).toBe(false);
    expect((await h.dispatch('context', {}, { ...h.sender(), frameId: 1 })).ok).toBe(false);
    expect((await h.dispatch('speak', { text: 'stale', language: 'en-IN' }, h.sender(1, 'old-doc'))).ok).toBe(false);
    expect((await h.dispatch('context', {}, h.sender(1, 'doc-1', 'https://unapproved.example'))).ok).toBe(false);
  });
  it('routes speech through the offscreen page and opens a permission page when needed', async () => {
    const h = harness(); await h.activate();
    h.api.offscreen.hasDocument.mockResolvedValue(false);
    h.api.runtime.sendMessage.mockResolvedValue({ ok: false, error: 'NEED_MIC_PERMISSION' } as any);
    const result = await h.dispatch('speech-start', { requestId: 'voice-1' });
    expect(result.ok).toBe(false); expect(result.error).toContain('Allow microphone');
    expect(h.api.offscreen.createDocument).toHaveBeenCalled();
    expect(h.api.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://extension/permission.html' });
  });
  it('returns Chrome voice notices without exposing a provider key', async () => {
    const h = harness(); await h.activate();
    const result = await h.dispatch('speak', { text: 'Open settings', language: 'en-IN' });
    expect(result.ok).toBe(true); expect(result.data.warning).toContain('No English voice');
  });
});

describe('safe session data', () => {
  it('retains only bounded redacted task memory and clears DOM references', () => {
    const result = safeSession({ goal: 'Email person@example.com', recentActions: Array.from({length:20}, () => ({ type: 'click', label: 'person@example.com', timestamp: 1 })), pendingAction: { targetId: 'el_10' } });
    expect(JSON.stringify(result)).not.toContain('person@example.com'); expect(result.recentActions).toHaveLength(8); expect(result.pendingAction).toBeUndefined();
  });
  it('recognizes supported web origins only', () => {
    expect(webOrigin('https://example.com/path')).toBe('https://example.com');
    for (const url of ['chrome://settings', 'file:///tmp/a', 'https://chromewebstore.google.com', 'invalid']) expect(webOrigin(url)).toBeUndefined();
  });
});

describe('Chrome async injection bootstrap', () => {
  it('does not hold the storage queue while injected code requests its context', async () => {
    const h = harness();
    let bootstrapped = false;
    h.api.scripting.executeScript.mockImplementation(async (options: any) => {
      if (options.files) {
        const result = await h.dispatch('context');
        bootstrapped = result.ok;
      }
      return [{ documentId: 'doc-1' }];
    });
    h.api.action.onClicked.emit({ id: 1, url: 'https://example.com/settings' });
    await vi.waitFor(() => expect(bootstrapped).toBe(true));
    expect((h.values['companion:tab:1'] as any).documentId).toBe('doc-1');
  });
});

describe('Jev diagnostics transport', () => {
  it('returns assessment timing, call count, and escalation reason with action metadata', async () => {
    const h = harness(); await h.activate();
    const action = { action: 'wait', decisionContext: { taskStatus: 'active', goal: 'Open settings' } };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(action), { headers: {
      'server-timing': 'assessment;dur=8.5',
      'x-reasoning-decision': JSON.stringify({ museCalls: 0, escalationReason: 'none' }),
    } }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = await h.dispatch('reason', { requestId: 'reason-1', request: {
        trigger: 'page-change', userUtterance: 'Open settings', session: { recentActions: [], decisionContext: { taskStatus: 'active' } },
        page: { elements: [], evidence: [{ kind: 'status', text: 'Loading' }] },
      } });
      expect(result.ok).toBe(true);
      expect(result.data.action).toEqual(action);
      expect(result.data.timings).toEqual([{ stage: 'assessment', durationMs: 8.5, museCalls: 0, escalationReason: 'none' }]);
      expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).trigger).toBe('page-change');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('document lifecycle recovery', () => {
  it('keeps the active document bound through same-document loading events', async () => {
    const h = harness(); await h.activate();
    await h.dispatch('save-session', { state: { goal: 'Open settings', recentActions: [] } });
    h.api.tabs.onUpdated.emit(1, { status: 'loading' }, { url: 'https://example.com/settings' });
    await vi.waitFor(() => expect(h.api.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ func: expect.any(Function) })));
    const result = await h.dispatch('save-session', { state: { goal: 'Open history', recentActions: [] } });
    expect(result.ok).toBe(true); expect((h.values['companion:tab:1'] as any).documentId).toBe('doc-1');
    expect((h.values['companion:tab:1'] as any).state.goal).toBe('Open history');
  });
  it('reclaims a missing document binding without accepting an old document', async () => {
    const h = harness(); await h.activate();
    (h.values['companion:tab:1'] as any).documentId = undefined;
    expect((await h.dispatch('get-speech-settings')).ok).toBe(true);
    expect((h.values['companion:tab:1'] as any).documentId).toBe('doc-1');
    h.documents.set(1, 'doc-2');
    await h.dispatch('context', {}, h.sender());
    const stale = await h.dispatch('get-speech-settings', {}, h.sender(1, 'doc-1'));
    expect(stale.ok).toBe(false); expect(stale.code).toBe('STALE_DOCUMENT');
    expect((h.values['companion:tab:1'] as any).documentId).toBe('doc-2');
  });
  it('rejects inactive lifecycle senders without changing the active binding', async () => {
    const h = harness(); await h.activate();
    const result = await h.dispatch('save-session', { state: { goal: 'stale' } }, { ...h.sender(), documentLifecycle: 'cached' });
    expect(result.code).toBe('STALE_DOCUMENT');
    expect((h.values['companion:tab:1'] as any).state.goal).toBeUndefined();
  });
});

describe('runtime speech provider selection', () => {
  it('saves Meta from the settings page and uses it for the next capture', async () => {
    const h = harness(); await h.activate();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, message: 'Meta STT is ready.' }))));
    try {
      const settingsSender = { id: 'extension', url: 'chrome-extension://extension/permission.html' };
      const settings = await h.dispatch('set-speech-provider', { provider: 'meta', checkMeta: true }, settingsSender);
      expect(settings.data.provider).toBe('meta'); expect(settings.data.meta.available).toBe(true);
      await h.dispatch('speech-start', { requestId: 'meta-turn' });
      expect(h.api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture', provider: 'server' }));
      await h.dispatch('set-speech-provider', { provider: 'chrome' });
      await h.dispatch('speech-start', { requestId: 'chrome-turn' });
      expect(h.api.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'capture', provider: 'chrome' }));
    } finally { vi.unstubAllGlobals(); }
  });
  it('shows unavailable Meta setup without silently using Chrome', async () => {
    const h = harness(); await h.activate();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: false, message: 'Enable Meta STT on the backend.' }))));
    try {
      await h.dispatch('set-speech-provider', { provider: 'meta' });
      const result = await h.dispatch('speech-start', { requestId: 'unavailable' });
      expect(result.ok).toBe(false); expect(result.error).toContain('Enable Meta');
      expect(h.api.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'capture' }));
      expect(h.values['companion:speech-provider']).toBe('meta');
    } finally { vi.unstubAllGlobals(); }
  });
  it('handles an older backend and rejects invalid provider or untrusted settings access', async () => {
    const h = harness(); await h.activate();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    try {
      const status = await h.dispatch('get-speech-settings', { checkMeta: true });
      expect(status.data.meta.message).toContain('Update the backend');
      expect((await h.dispatch('set-speech-provider', { provider: 'invalid' })).ok).toBe(false);
      expect((await h.dispatch('set-speech-provider', { provider: 'meta' }, { id: 'extension', url: 'https://unapproved.example/permission.html' })).ok).toBe(false);
      await h.dispatch('open-speech-settings'); expect(h.api.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('cancelled speech preflight', () => {
  it('does not open a microphone after the user stops during the Meta readiness check', async () => {
    const h = harness(); await h.activate(); await h.dispatch('set-speech-provider', { provider: 'meta' });
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    try {
      const pending = h.dispatch('speech-start', { requestId: 'slow-check' });
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect((await h.dispatch('set-speech-provider', { provider: 'chrome' })).ok).toBe(false);
      await h.dispatch('speech-stop', { requestId: 'slow-check' });
      finish(new Response(JSON.stringify({ available: true, message: 'Meta STT is ready.' })));
      expect((await pending).ok).toBe(false);
      expect(h.api.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'capture' }));
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('Meta status request coalescing', () => {
  it('shares concurrent status checks without issuing duplicate requests', async () => {
    const h = harness(); await h.activate();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const first = h.dispatch('get-speech-settings', { checkMeta: true });
      const second = h.dispatch('get-speech-settings', { checkMeta: true });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      finish(new Response(JSON.stringify({ available: true, message: 'Meta STT is configured.' })));
      expect((await first).data.meta.available).toBe(true);
      expect((await second).data.meta.available).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('streaming reasoning and Stop barriers', () => {
  const request = { userUtterance: 'Open settings', session: { recentActions: [] }, page: { elements: [] } };
  it('delivers an action before stream completion and keeps its tail alive during continuation', async () => {
    const h = harness(); await h.activate();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (!url.endsWith('/stream')) return new Response(JSON.stringify({ action: 'wait' }));
      signal = init.signal!;
      signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const pending = h.dispatch('reason-stream', { requestId: 'stream-1', request });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
      stream.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'action', action: { action: 'wait' } }) + '\n\n'));
      const first = await pending;
      expect(first).toMatchObject({ ok: true, data: { action: { action: 'wait' } } });
      expect(signal.aborted).toBe(false);
      await h.dispatch('reason', { requestId: 'next-page', request });
      expect(signal.aborted).toBe(false);
      await h.dispatch('cancel-plans');
      expect(signal.aborted).toBe(true);
      expect(JSON.parse(fetcher.mock.calls[0]![1].body as string).page.origin).toBe('https://example.com');
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects delayed work and old session saves after Stop', async () => {
    const h = harness(); await h.activate();
    await h.dispatch('save-session', { revision: 1, state: { goal: 'Old task', recentActions: [] } });
    await h.dispatch('stop-work', { clientId: 'synthetic-client', workEpoch: 1 });
    await h.dispatch('save-session', { revision: 3, state: { recentActions: [] } });
    await h.dispatch('save-session', { revision: 2, state: { goal: 'Old task', recentActions: [] } });
    const stale = await h.dispatch('speak', { clientId: 'synthetic-client', workEpoch: 0, text: 'Do not say this', language: 'en-IN' });
    expect(stale.ok).toBe(false); expect(stale.error).toContain('cancelled');
    expect(h.api.tts.speak).not.toHaveBeenCalled();
    const context = await h.dispatch('context');
    expect(context.data.goal).toBeUndefined(); expect(context.data.storageRevision).toBe(3);
  });
});

describe('safe model error transport', () => {
  it('preserves a safe provider category when assessment fails before SSE headers', async () => {
    const h = harness(); await h.activate();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'PROVIDER_AUTH', message: 'Synthetic private provider body' }), { status: 502, headers: { 'content-type': 'application/json' } })));
    try {
      const result = await h.dispatch('reason-stream', { requestId: 'failure-test', request: { userUtterance: 'Open settings', session: { recentActions: [] }, page: { elements: [] } } });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('PROVIDER_AUTH');
      expect(result.error).toContain('Model access was rejected');
      expect(result.error).not.toContain('Synthetic private');
    } finally { vi.unstubAllGlobals(); }
  });
});
