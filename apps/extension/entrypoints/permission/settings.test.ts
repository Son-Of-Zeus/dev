import { beforeEach, describe, expect, it, vi } from 'vitest';
import settingsHtml from './index.html?raw';
const mock = vi.hoisted(() => ({ send: vi.fn(), get: vi.fn(), set: vi.fn(), voices: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { sendMessage: mock.send }, storage: { local: { get: mock.get, set: mock.set } },
  tts: { getVoices: mock.voices, onVoicesChanged: { addListener: vi.fn() } },
} }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  document.body.innerHTML = settingsHtml;
  mock.get.mockResolvedValue({ 'companion:speech-language': 'hi-IN' });
  mock.set.mockResolvedValue(undefined); mock.voices.mockResolvedValue([]);
  mock.send.mockImplementation(async (request) => ({ ok: true, data: { provider: request.provider ?? 'chrome', language: 'hi-IN', meta: { available: false, message: 'Enable Meta STT on the backend.' } } }));
});
describe('speech settings screen', () => {
  it('saves a Meta selection immediately and shows setup instructions', async () => {
    await import('./main');
    await vi.waitFor(() => expect(document.querySelector('#provider-status')?.textContent).toContain('Chrome'));
    const select = document.querySelector<HTMLSelectElement>('#provider')!;
    select.value = 'meta'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(mock.send).toHaveBeenCalledWith(expect.objectContaining({ op: 'set-speech-provider', provider: 'meta', checkMeta: true })));
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#meta-setup')!.hidden).toBe(false));
    expect(document.querySelector('#provider-status')?.textContent).toContain('Enable Meta');
    expect(document.querySelector('#provider-help')?.textContent).toContain('Meta');
    expect(select.disabled).toBe(false);
  });
  it('keeps voice and language preferences separate from STT provider selection', async () => {
    await import('./main');
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('#language')!.value).toBe('hi-IN'));
    document.querySelector<HTMLSelectElement>('#language')!.value = 'en-US';
    document.querySelector<HTMLButtonElement>('#save')!.click();
    await vi.waitFor(() => expect(mock.set).toHaveBeenCalledWith({ 'companion:speech-language': 'en-US' }));
    expect(document.querySelector('#settings-status')?.textContent).toContain('Saved');
  });
});
