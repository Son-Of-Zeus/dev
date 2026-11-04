import { browser } from 'wxt/browser';
import { BACKEND_URL, STT_PROVIDER } from './config';
import { SPEECH_LANGUAGE_KEY, SPEECH_PROVIDER_KEY, speechLanguage, speechProvider, voiceKey } from './speech-settings';
import { safeSession, webOrigin, type TabSession } from './session';
import { reasoningFailure } from '../reasoning/failure';
import { readReasonEvents } from '../reasoning/stream';
import { sanitizeReasonRequest } from '../reasoning/reasoning';
import { createChromeSpeech } from './tts';
import { readMetaSpeechStatus } from './meta-speech-status';
import type { MetaSpeechStatus } from './speech-settings';

export function installBackground(api = browser) {
  const key = (tabId: number) => `companion:tab:${tabId}`;
  const speech = createChromeSpeech(api.tts, {
    get: async (family) => (await api.storage.local.get(voiceKey(family)))[voiceKey(family)],
    set: async (family, voice) => { await api.storage.local.set({ [voiceKey(family)]: voice }); },
  });
  const aborts = new Map<number, { requestId: string; controller: AbortController }>();
  const workEpochs = new Map<string, number>();
  const planStreams = new Map<number, Map<string, AbortController>>();
  let recording: { tabId: number; documentId: string; requestId: string; stopped?: boolean } | undefined;
  let speechOwner: number | undefined;
  let offscreenCreation: Promise<void> | undefined;
  const queues = new Map<number, Promise<unknown>>();
  const serial = <T>(tabId: number, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(tabId, next);
    void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
    return next;
  };
  const read = async (tabId: number): Promise<TabSession | undefined> => (await api.storage.session.get(key(tabId)))[key(tabId)] as TabSession | undefined;
  const write = (tabId: number, state: TabSession) => api.storage.session.set({ [key(tabId)]: state });
  const activeDocumentId = async (tabId: number) => (await api.scripting.executeScript({ target: { tabId }, func: () => true }))[0]?.documentId;
  const inactiveDocument = () => Object.assign(new Error('The page changed. Reopen voice guidance on the current page.'), { code: 'STALE_DOCUMENT' });
  const cancelWork = (tabId: number) => {
    aborts.get(tabId)?.controller.abort(); aborts.delete(tabId);
    for (const controller of planStreams.get(tabId)?.values() ?? []) controller.abort();
    planStreams.delete(tabId);
    if (speechOwner === tabId) { speech.cancel(); speechOwner = undefined; }
    if (recording?.tabId === tabId) {
      void api.runtime.sendMessage({ target: 'offscreen', op: 'cancel', requestId: recording.requestId }).catch(() => {});
      recording = undefined;
    }
  };
  const inject = async (tabId: number) => { await api.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] }); };
  // Never hold a tab's storage queue while awaiting content-script execution.
  // Chrome can wait for that script's async bootstrap, which calls back here.
  api.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    void (async () => {
      const result = await serial(tabId, async () => {
        const origin = webOrigin(tab.url);
        if (!origin) {
          await api.action.setTitle({ tabId, title: 'Voice Companion cannot access this page.' });
          return { action: 'none' as const };
        }
        const existing = await read(tabId);
        if (existing?.origin === origin) {
          cancelWork(tabId);
          await api.storage.session.remove(key(tabId));
          return { action: 'stop' as const };
        }
        const activationId = crypto.randomUUID();
        await write(tabId, { origin, activationId, state: safeSession(undefined) });
        return { action: 'inject' as const, activationId };
      });
      if (result.action === 'stop') {
        await api.tabs.sendMessage(tabId, { target: 'content', type: 'shutdown' }).catch(() => {});
      }
      if (result.action === 'inject') {
        try { await inject(tabId); }
        catch {
          await serial(tabId, async () => {
            if ((await read(tabId))?.activationId === result.activationId) await api.storage.session.remove(key(tabId));
          });
          await api.action.setTitle({ tabId, title: 'This page does not allow extension access.' });
        }
      }
    })().catch(() => {});
  });
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (!change.url && !change.status) return;
    void (async () => {
      const entry = await serial(tabId, async () => {
        const current = await read(tabId);
        if (!current) return;
        if (webOrigin(tab.url) !== current.origin) {
          cancelWork(tabId);
          await api.storage.session.remove(key(tabId));
          return;
        }
        if (change.status === 'loading') {
          // Loading and URL events can occur without replacing the main document.
          // Keep a live binding; invalidate it only when Chrome reports another ID.
          const activeId = await activeDocumentId(tabId).catch(() => undefined);
          if (activeId && activeId !== current.documentId) {
            cancelWork(tabId);
            await write(tabId, { ...current, documentId: undefined });
          }
        }
        return change.status === 'complete' ? current : undefined;
      });
      if (!entry) return;
      try { await inject(tabId); }
      catch {
        cancelWork(tabId);
        await serial(tabId, async () => {
          if ((await read(tabId))?.activationId === entry.activationId) await api.storage.session.remove(key(tabId));
        });
      }
    })().catch(() => {});
  });
  api.tabs.onRemoved.addListener((tabId) => { cancelWork(tabId); for (const key of workEpochs.keys()) if (key.startsWith(tabId + ':')) workEpochs.delete(key); void serial(tabId, () => api.storage.session.remove(key(tabId))); });

  const ensureOffscreen = async () => {
    if (await api.offscreen.hasDocument()) return;
    offscreenCreation ??= api.offscreen.createDocument({ url: '/offscreen.html', reasons: ['USER_MEDIA'], justification: 'Capture one voice request in a secure extension document.' }).finally(() => { offscreenCreation = undefined; });
    await offscreenCreation;
  };
  const defaultProvider = STT_PROVIDER === 'server' ? 'meta' : 'chrome';
  let pendingMetaStatus: Promise<MetaSpeechStatus> | undefined;
  const metaStatus = () => {
    pendingMetaStatus ??= readMetaSpeechStatus(BACKEND_URL).finally(() => { pendingMetaStatus = undefined; });
    return pendingMetaStatus;
  };
  const speechSettings = async (message: { op: string; provider?: unknown; checkMeta?: boolean }) => {
    if (message.op === 'set-speech-provider') {
      if (!['chrome', 'meta'].includes(message.provider as string)) throw new Error('Choose Chrome or Meta STT.');
      if (recording) throw new Error('Finish the current recording before changing the provider.');
      await api.storage.local.set({ [SPEECH_PROVIDER_KEY]: message.provider });
    }
    const settings = await api.storage.local.get([SPEECH_PROVIDER_KEY, SPEECH_LANGUAGE_KEY]);
    return { provider: speechProvider(settings[SPEECH_PROVIDER_KEY], defaultProvider), language: speechLanguage(settings[SPEECH_LANGUAGE_KEY]),
      ...(message.checkMeta ? { meta: await metaStatus() } : {}),
    };
  };
  api.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (message?.target !== 'background' || sender.id !== api.runtime.id) return;
    const dispatch = async () => {
      if (message.op === 'speech-event' || message.op === 'speech-heartbeat') {
        if (sender.url !== api.runtime.getURL('/offscreen.html') || !recording || message.requestId !== recording.requestId) throw new Error('Invalid speech event.');
        if (message.op === 'speech-heartbeat') return;
        if (typeof message.transcript !== 'string') throw new Error('Invalid transcript.');
        await api.tabs.sendMessage(recording.tabId, { target: 'content', type: 'partial', requestId: recording.requestId, transcript: message.transcript.slice(0, 2000) }, { documentId: recording.documentId });
        return;
      }
      const settingsPage = sender.url === api.runtime.getURL('/permission.html');
      if (settingsPage && ['get-speech-settings', 'set-speech-provider'].includes(message.op)) return speechSettings(message);
      const tabId = sender.tab?.id;
      const documentId = sender.documentId;
      if (tabId === undefined || sender.frameId !== 0 || !documentId) throw new Error('A main-page companion is required.');
      const entry = await read(tabId);
      if (!entry || webOrigin(sender.url) !== entry.origin) throw new Error('Activate the extension on this website first.');
      if (sender.documentLifecycle && sender.documentLifecycle !== 'active') throw inactiveDocument();
      const claimDocument = () => serial(tabId, async () => {
        const latest = await read(tabId);
        if (!latest || latest.origin !== entry.origin || latest.activationId !== entry.activationId) throw inactiveDocument();
        if (await activeDocumentId(tabId) !== documentId) throw inactiveDocument();
        if (latest.documentId !== documentId) cancelWork(tabId);
        await write(tabId, { ...latest, documentId });
        return { ...latest.state, ...(latest.sessionRevision === undefined ? {} : { storageRevision: latest.sessionRevision }) };
      });
      if (message.op === 'context') return claimDocument();
      // Recover a lost binding only after Chrome verifies the current document.
      if (entry.documentId !== documentId) await claimDocument();
      if (message.clientId !== undefined || message.workEpoch !== undefined) {
        if (typeof message.clientId !== 'string' || !message.clientId || message.clientId.length > 80 || !Number.isSafeInteger(message.workEpoch) || message.workEpoch < 0) throw new Error('Invalid work generation.');
        const workKey = tabId + ':' + documentId + ':' + message.clientId;
        const epoch = workEpochs.get(workKey) ?? 0;
        if (message.op === 'stop-work') {
          if (message.workEpoch < epoch) return;
          workEpochs.set(workKey, message.workEpoch); cancelWork(tabId); return;
        }
        if (message.workEpoch !== epoch) throw new Error('Work cancelled.');
        workEpochs.set(workKey, epoch);
      }
      if (message.op === 'get-speech-settings' || message.op === 'set-speech-provider') return speechSettings(message);
      if (message.op === 'open-speech-settings') {
        await api.runtime.openOptionsPage();
        return;
      }
      if (message.op === 'save-session') return serial(tabId, async () => {
        const latest = await read(tabId);
        if (latest?.documentId !== documentId) return;
        const revision = message.revision;
        if (latest.sessionRevision !== undefined && (!Number.isSafeInteger(revision) || revision <= latest.sessionRevision)) return;
        await write(tabId, { ...latest, ...(Number.isSafeInteger(revision) ? { sessionRevision: revision } : {}), state: safeSession(message.state) });
      });
      if (message.op === 'cancel-plan') { planStreams.get(tabId)?.get(message.requestId)?.abort(); planStreams.get(tabId)?.delete(message.requestId); return; }
      if (message.op === 'cancel-plans') {
        for (const controller of planStreams.get(tabId)?.values() ?? []) controller.abort();
        planStreams.delete(tabId); return;
      }
      if (message.op === 'reason-stream') {
        if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 80) throw new Error('Invalid reasoning request ID.');
        const request = sanitizeReasonRequest(message.request);
        if (request.page.origin && request.page.origin !== entry.origin) throw new Error('Invalid page origin.');
        request.page.origin = entry.origin;
        aborts.get(tabId)?.controller.abort();
        const controller = new AbortController();
        aborts.set(tabId, { requestId: message.requestId, controller });
        let resolveFirst!: (value: unknown) => void;
        let rejectFirst!: (error: unknown) => void;
        const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
        const forward = async (event: unknown) => {
          const latest = await read(tabId);
          if (controller.signal.aborted) return;
          if (latest?.documentId !== documentId || latest.activationId !== entry.activationId) throw inactiveDocument();
          await api.tabs.sendMessage(tabId, { target: 'content', type: 'reason-event', requestId: message.requestId, event }, { documentId });
        };
        void (async () => {
          let delivered = false;
          let done = false;
          let plan: unknown;
          const timings: unknown[] = [];
          try {
            const response = await fetch(BACKEND_URL + '/reason/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
            if (!response.ok) {
              const failure = await response.json().catch(() => undefined);
              if (failure && typeof failure.code === 'string') throw reasoningFailure({ code: failure.code, status: response.status });
              throw Object.assign(new Error('Reasoning failed (HTTP ' + response.status + ').'), { status: response.status });
            }
            if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected reasoning stream.');
            for await (const value of readReasonEvents(response.body, controller.signal)) {
              const event = value as { type: string; action?: unknown; plan?: unknown; metric?: unknown; status?: number; code?: unknown; decision?: { museCalls: number; escalationReason: string } };
              if (!event || !['plan', 'action', 'diagnostic', 'decision', 'done', 'error'].includes(event.type)) throw new Error('Invalid reasoning event.');
              if (controller.signal.aborted) throw new Error('Reasoning cancelled.');
              if (event.type === 'error') throw reasoningFailure(event);
              if (event.type === 'action') {
                if (delivered) throw new Error('Duplicate action.');
                const latest = await read(tabId);
                if (controller.signal.aborted) throw new Error('Reasoning cancelled.');
                if (latest?.documentId !== documentId || latest.activationId !== entry.activationId) throw inactiveDocument();
                delivered = true;
                if (aborts.get(tabId)?.controller === controller) aborts.delete(tabId);
                const streams = planStreams.get(tabId) ?? new Map<string, AbortController>();
                streams.set(message.requestId, controller); planStreams.set(tabId, streams);
                resolveFirst({ action: event.action, timings });
              } else if (event.type === 'diagnostic' && !delivered) timings.push(event.metric);
              else if (event.type === 'decision' && !delivered) {
                const decision = event.decision;
                const assessment = timings.find((item) => (item as { stage?: string }).stage === 'assessment');
                if (assessment && decision && [0, 1].includes(decision.museCalls) && ['none', 'new-step', 'explanation', 'consequence'].includes(decision.escalationReason)) Object.assign(assessment, decision);
              }
              else {
                if (event.type === 'plan') plan = event.plan;
                if (event.type === 'done') done = true;
                await forward(event);
              }
            }
            if (!done || !delivered) throw new Error('Incomplete reasoning stream.');
          } catch (error) {
            if (!delivered) rejectFirst(error);
            else if (!controller.signal.aborted) await forward({ type: 'plan-failed', plan }).catch(() => {});
          } finally {
            if (aborts.get(tabId)?.controller === controller) aborts.delete(tabId);
            planStreams.get(tabId)?.delete(message.requestId);
            if (!planStreams.get(tabId)?.size) planStreams.delete(tabId);
          }
        })();
        return first;
      }
      if (message.op === 'reason') {
        if (typeof message.requestId !== 'string' || message.requestId.length > 80) throw new Error('Invalid reasoning request ID.');
        const request = sanitizeReasonRequest(message.request);
        if (request.page.origin && request.page.origin !== entry.origin) throw new Error('Invalid page origin.');
        request.page.origin = entry.origin;
        const body = JSON.stringify(request);
        if (new TextEncoder().encode(body).length > 512 * 1024 || request.page.elements.length > 1000) throw new Error('Page is too large. Narrow the page area.');
        aborts.get(tabId)?.controller.abort();
        const controller = new AbortController(); aborts.set(tabId, { requestId: message.requestId, controller });
        try {
          const response = await fetch(`${BACKEND_URL}/reason`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
          if (!response.ok) { const error = new Error(response.status === 409 ? 'TARGET_NOT_FOUND' : `Reasoning failed (HTTP ${response.status}).`); Object.assign(error, { status: response.status }); throw error; }
          const action = await response.json();
          if ((await read(tabId))?.documentId !== documentId) throw inactiveDocument();
          const timings = (response.headers.get('server-timing') ?? '').split(',').flatMap((part) => { const match = part.trim().match(/^(assessment|planning|selection);dur=([\d.]+)$/); return match ? [{ stage: match[1], durationMs: Number(match[2]) }] : []; });
          try {
            const decision = JSON.parse(response.headers.get('x-reasoning-decision') ?? 'null');
            if (decision && [0, 1].includes(decision.museCalls) && ['none', 'explanation', 'consequence', 'new-step'].includes(decision.escalationReason)) {
              const assessment = timings.find((metric) => metric.stage === 'assessment');
              if (assessment) Object.assign(assessment, decision);
            }
          } catch { /* Optional diagnostics do not affect guidance. */ }
          return { action, timings };
        } finally { if (aborts.get(tabId)?.controller === controller) aborts.delete(tabId); }
      }
      if (message.op === 'speech-start') {
        if (recording || typeof message.requestId !== 'string' || message.requestId.length > 80) throw new Error('A voice request is already active or invalid.');
        const capture = { tabId, documentId, requestId: message.requestId, stopped: false };
        recording = capture;
        try {
          const settings = await api.storage.local.get([SPEECH_LANGUAGE_KEY, SPEECH_PROVIDER_KEY]);
          const selectedProvider = speechProvider(settings[SPEECH_PROVIDER_KEY], defaultProvider);
          if (selectedProvider === 'meta') {
            const status = await metaStatus();
            if (!status.available) throw new Error(status.message);
          }
          if (recording !== capture || capture.stopped) throw new Error('Recording was stopped before it began.');
          await ensureOffscreen();
          if (recording !== capture || capture.stopped) throw new Error('Recording was stopped before it began.');
          const result = await api.runtime.sendMessage({ target: 'offscreen', op: 'capture', provider: selectedProvider === 'meta' ? 'server' : 'chrome', language: speechLanguage(settings[SPEECH_LANGUAGE_KEY]), requestId: message.requestId });
          if (!result?.ok) {
            if (result?.error === 'NEED_MIC_PERMISSION') {
              await api.tabs.create({ url: api.runtime.getURL('/permission.html') });
              throw new Error('Allow microphone access in the extension page, then tap the companion again.');
            }
            throw new Error(result?.error ?? 'Speech capture failed.');
          }
          return result.data;
        } finally { if (recording?.requestId === message.requestId) recording = undefined; }
      }
      if (message.op === 'speech-stop' || message.op === 'speech-cancel') {
        if (recording?.tabId === tabId && recording.requestId === message.requestId) {
          recording.stopped = true;
          if (message.op === 'speech-cancel') recording = undefined;
          await api.runtime.sendMessage({ target: 'offscreen', op: message.op === 'speech-stop' ? 'stop' : 'cancel', requestId: message.requestId });
        }
        return;
      }
      if (message.op === 'speak') {
        if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 3000 || !['en-IN', 'hi-IN'].includes(message.language)) throw new Error('Invalid speech instruction.');
        speechOwner = tabId;
        return speech.speak(message.text, message.language);
      }
      if (message.op === 'cancel-output') { if (speechOwner === tabId) speech.cancel(); return; }
      if (message.op === 'cancel-reason') { if (aborts.get(tabId)?.requestId === message.requestId) aborts.get(tabId)?.controller.abort(); return; }
      throw new Error('Unsupported extension operation.');
    };
    dispatch().then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: error.message ?? 'Extension request failed.', status: error.status, code: error.code }));
    return true;
  });
}
