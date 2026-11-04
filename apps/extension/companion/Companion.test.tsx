import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import Companion, {
  COMPANION_STATUS_ID,
  getCompanionButtonLabel,
} from './Companion';
import { createCompanionUiStore } from './companion-ui';

describe('Companion accessibility', () => {
  it('uses action labels that describe stop, retry, follow-up, and start states', () => {
    expect(getCompanionButtonLabel('idle')).toBe('Start voice guidance');
    expect(getCompanionButtonLabel('listening')).toBe('Stop task');
    expect(getCompanionButtonLabel('thinking')).toBe('Stop task');
    expect(getCompanionButtonLabel('speaking')).toBe('Stop task');
    expect(getCompanionButtonLabel('error')).toBe('Start a new voice guidance request');
    expect(getCompanionButtonLabel('waiting')).toBe('Ask a follow-up question');
    expect(getCompanionButtonLabel('success')).toBe(
      'Start a new voice guidance request',
    );
  });

  it('exposes the current state through region, busy, description, and live-status semantics', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    const reactMount = document.createElement('div');
    host.append(reactMount);
    const root = ReactDOM.createRoot(reactMount);

    await act(async () => {
      root.render(<Companion store={store} />);
    });

    const surface = host.querySelector('[role="region"]') as HTMLElement;
    const button = host.querySelector('.companion-mic') as HTMLButtonElement;
    const status = host.querySelector(`#${COMPANION_STATUS_ID}`) as HTMLElement;
    expect(surface.getAttribute('aria-label')).toBe('Voice companion');
    expect(surface.getAttribute('aria-busy')).toBe('false');
    expect(button.getAttribute('aria-describedby')).toBe(COMPANION_STATUS_ID);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');

    await act(async () => {
      store.setState('thinking');
    });
    expect(surface.getAttribute('aria-busy')).toBe('true');
    expect(surface.className).toContain('companion-surface--docked');
    expect(surface.className).toContain('companion-surface--thinking');
    expect(button.getAttribute('aria-label')).toBe('Stop task');
    expect(status.textContent).toContain('Thinking…');

    await act(async () => {
      store.setLatencyNotice(true);
    });
    expect(surface.getAttribute('data-companion-latency')).toBe('slow');
    expect(status.textContent).toContain('Still working…');

    await act(async () => {
      store.setState('error');
    });
    expect(surface.getAttribute('aria-busy')).toBe('false');
    expect(surface.getAttribute('data-companion-latency')).toBe('normal');
    expect(button.getAttribute('aria-label')).toBe('Start a new voice guidance request');
    expect(status.getAttribute('aria-live')).toBe('assertive');
    expect(status.textContent).toContain('Try again');

    root.unmount();
    store.destroy();
  });

  it('moves only the cursor and flips its tip beside a right-edge target', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    store.setTarget({
      top: 100,
      bottom: 140,
      left: 980,
      right: 1010,
      width: 30,
      height: 40,
      x: 980,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    const reactMount = document.createElement('div');
    host.append(reactMount);
    const root = ReactDOM.createRoot(reactMount);

    await act(async () => {
      root.render(<Companion store={store} />);
    });

    const surface = host.querySelector('[role="region"]') as HTMLElement;
    const pointer = host.querySelector('.companion-button') as HTMLButtonElement;
    const panel = host.querySelector('.companion-panel') as HTMLElement;
    expect(surface.className).toContain(
      'companion-surface--target-left',
    );
    expect(surface.className).not.toContain(
      'companion-surface--docked',
    );
    expect(surface.getAttribute('style')).toBeNull();
    expect(pointer.style.left).not.toBe('');
    expect(pointer.style.top).not.toBe('');
    expect(panel.getAttribute('style')).toBeNull();
    expect(pointer.querySelector('.companion-orb')).toBeNull();

    root.unmount();
    store.destroy();
  });

  it('renders an accessible task-stop control and delegates the action', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    const resetHandler = vi.fn();
    store.setStopHandler(resetHandler);
    store.setTaskActive(true);
    const reactMount = document.createElement('div');
    host.append(reactMount);
    const root = ReactDOM.createRoot(reactMount);

    await act(async () => {
      root.render(<Companion store={store} />);
    });

    const resetButton = host.querySelector(
      'button[aria-label="Stop task"]',
    ) as HTMLButtonElement;
    expect(resetButton.getAttribute('title')).toBe('Stop task');

    await act(async () => {
      resetButton.click();
    });

    expect(resetHandler).toHaveBeenCalledTimes(1);
    root.unmount();
    store.destroy();
  });

  it('shows a compact expandable latency breakdown inside the companion', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createCompanionUiStore(host);
    store.recordLatency({ stage: 'speech-to-text', durationMs: 800 });
    store.recordLatency({ stage: 'reasoning', durationMs: 1_200 });
    const reactMount = document.createElement('div');
    host.append(reactMount);
    const root = ReactDOM.createRoot(reactMount);

    await act(async () => {
      root.render(<Companion store={store} />);
    });

    const details = host.querySelector('.companion-latency') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toContain('2.0s measured');
    expect(details.textContent).toContain('Speech recognition');
    expect(details.textContent).toContain('Reasoning');

    root.unmount();
    store.destroy();
  });
});

describe('compact companion controls', () => {
  it('starts collapsed and expands or collapses from the disclosure control', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const store = createCompanionUiStore(host); const root = ReactDOM.createRoot(host);
    await act(async () => { root.render(<Companion store={store} />); });
    const toggle = host.querySelector('.companion-expand-button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.companion-expand')?.hasAttribute('inert')).toBe(true);
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.companion-panel')?.classList.contains('companion-panel--expanded')).toBe(true);
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { root.unmount(); }); store.destroy();
  });
  it('expands for errors and never shows stale guidance as an active instruction', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const store = createCompanionUiStore(host); const root = ReactDOM.createRoot(host);
    store.setInstruction('Old Deployment history guidance.');
    const retry = vi.fn(); const microphone = vi.fn(); const settings = vi.fn();
    store.setRetryHandler(retry); store.setListeningHandler(microphone); store.setSettingsHandler(settings);
    await act(async () => { root.render(<Companion store={store} />); });
    await act(async () => { store.setNotice('The page changed. Reopen voice guidance.'); store.setState('error'); });
    expect(host.textContent).not.toContain('Old Deployment history guidance.');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The page changed');
    expect(host.querySelector('.companion-expand-button')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      (host.querySelector('.companion-retry') as HTMLButtonElement).click();
      (host.querySelector('.companion-mic') as HTMLButtonElement).click();
      (host.querySelector('.companion-footer button') as HTMLButtonElement).click();
    });
    expect(retry).toHaveBeenCalledTimes(1); expect(microphone).toHaveBeenCalledTimes(1); expect(settings).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); }); store.destroy();
  });
  it('saves the selected speech provider and displays its setup status', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const store = createCompanionUiStore(host); const root = ReactDOM.createRoot(host);
    const handler = vi.fn(async () => { store.setSpeechPreferences({ provider: 'meta', language: 'en-IN', meta: { available: false, message: 'Enable Meta STT on the backend.' } }); });
    store.setProviderHandler(handler);
    await act(async () => { root.render(<Companion store={store} />); });
    await act(async () => {
      const select = host.querySelector('select')!; select.value = 'meta'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(handler).toHaveBeenCalledWith('meta');
    expect(host.querySelector('select')?.value).toBe('meta');
    expect(host.querySelector('.companion-provider-notice')?.textContent).toContain('Enable Meta');
    await act(async () => { root.unmount(); }); store.destroy();
  });
});

describe('Stop and Finish recording controls', () => {
  it('has distinct Stop and Finish recording actions with no Reset, Pause, or Resume', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const store = createCompanionUiStore(host);
    const stopped = vi.fn(); const finished = vi.fn();
    store.setStopHandler(stopped); store.setFinishRecordingHandler(finished);
    store.setState('listening'); store.setTaskActive(true);
    const root = ReactDOM.createRoot(host);
    await act(async () => { root.render(<Companion store={store} />); });
    expect(host.textContent).not.toMatch(/Reset|Pause|Resume/);
    await act(async () => { (host.querySelector('.companion-finish') as HTMLButtonElement).click(); });
    expect(finished).toHaveBeenCalledTimes(1); expect(stopped).not.toHaveBeenCalled();
    await act(async () => { (host.querySelector('.companion-stop') as HTMLButtonElement).click(); });
    expect(stopped).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); }); store.destroy(); host.remove();
  });
});
