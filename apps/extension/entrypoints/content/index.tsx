import ReactDOM from 'react-dom/client';
import { browser } from 'wxt/browser';
import styles from './style.css?inline';
import { createCompanionUiStore } from '../../companion/companion-ui';
import { createExtensionRuntime } from '../../runtime/extension-runtime';
import { backgroundRequest, createContentBridge } from '../../platform/content-bridge';
import type { SessionState } from '../../session/session-state';
import App from './App';

export default defineContentScript({
  matches: [], registration: 'runtime', runAt: 'document_idle', cssInjectionMode: 'manual',
  async main(ctx) {
    const scope = globalThis as typeof globalThis & { __voiceCompanionMounted?: boolean };
    if (scope.__voiceCompanionMounted) return;
    scope.__voiceCompanionMounted = true;
    let initialSession: SessionState;
    try { initialSession = await backgroundRequest('context'); } catch { scope.__voiceCompanionMounted = false; return; }
    const ui = await createShadowRootUi(ctx, {
      name: 'voice-companion-root', css: styles.replaceAll(':root', ':host'), position: 'overlay', anchor: 'body',
      onMount(container) {
        const app = document.createElement('div'); app.dataset.voiceCompanionApp = 'true'; container.append(app);
        const store = createCompanionUiStore(app);
        const bridge = createContentBridge((metric) => store.recordLatency(metric), () => shutdown());
        let sessionRevision = initialSession.storageRevision ?? 0;
        const runtime = createExtensionRuntime({ companion: store, ...bridge, initialSession,
          onSessionChange: (state) => { void backgroundRequest('save-session', { state, revision: ++sessionRevision }).catch(() => {}); },
        });
        store.setSettingsHandler(() => { void backgroundRequest('open-speech-settings').catch((error) => store.setNotice(error.message)); });
        store.setProviderHandler(async (provider) => {
          const preferences = await backgroundRequest('set-speech-provider', { provider, checkMeta: provider === 'meta' });
          store.setSpeechPreferences(preferences);
        });
        const refreshSpeech = () => { void backgroundRequest('get-speech-settings').then((preferences) => store.setSpeechPreferences(preferences)).catch(() => {}); };
        const settingsChanged = (changes: Record<string, unknown>, area: string) => {
          if (area === 'local' && ('companion:speech-provider' in changes || 'companion:speech-language' in changes)) refreshSpeech();
        };
        browser.storage.onChanged.addListener(settingsChanged);
        refreshSpeech();
        runtime.start();
        if (!runtime.registry.snapshot().length) store.setNotice('No supported controls are visible. Frames, closed Shadow DOM, and canvas controls cannot be guided.');
        else if (document.querySelector('iframe, canvas')) store.setNotice('Controls inside frames or canvases are not supported.');
        const reactMount = document.createElement('div'); app.append(reactMount);
        const root = ReactDOM.createRoot(reactMount); root.render(<App store={store} />);
        return { root, store, runtime, bridge, settingsChanged };
      },
      onRemove(mounted) {
        if (mounted) browser.storage.onChanged.removeListener(mounted.settingsChanged);
        mounted?.runtime.stop(); mounted?.bridge.destroy(); mounted?.root.unmount(); mounted?.store.destroy(); scope.__voiceCompanionMounted = false;
      },
    });
    const listener = (message: any) => { if (message?.target === 'content' && message.type === 'shutdown') shutdown(); };
    browser.runtime.onMessage.addListener(listener);
    const shutdown = () => { ui.remove(); browser.runtime.onMessage.removeListener(listener); };
    ctx.addEventListener(window, 'pagehide', shutdown);
    ctx.onInvalidated(shutdown);
    ui.mount();
  },
});
