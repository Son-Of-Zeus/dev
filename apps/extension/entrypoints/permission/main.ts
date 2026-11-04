import './style.css';
import { browser } from 'wxt/browser';
import { backgroundRequest } from '../../platform/content-bridge';
import { SPEECH_LANGUAGE_KEY, speechLanguage, voiceKey, type SpeechPreferences, type MetaSpeechStatus } from '../../platform/speech-settings';
import { pickDefaultVoice, savedVoice, voiceId, type SavedVoice, type SpeechVoice } from '../../platform/tts';

const microphone = document.querySelector<HTMLButtonElement>('#allow')!;
const language = document.querySelector<HTMLSelectElement>('#language')!;
const provider = document.querySelector<HTMLSelectElement>('#provider')!;
const providerStatus = document.querySelector<HTMLElement>('#provider-status')!;
const settingsStatus = document.querySelector('#settings-status')!;
let meta: MetaSpeechStatus | undefined;

function showProvider() {
  const isMeta = provider.value === 'meta';
  document.querySelector('#provider-help')!.textContent = isMeta
    ? 'Microphone audio streams through your backend to Meta for transcription. Spoken replies still use your Chrome voices.'
    : 'Chrome may send audio to Google. The final text goes to your guidance backend.';
  providerStatus.textContent = isMeta ? meta?.message ?? 'Checking Meta STT…' : 'Chrome speech recognition selected.';
  providerStatus.dataset.tone = isMeta && meta && !meta.available ? 'error' : 'ready';
  document.querySelector<HTMLElement>('#meta-setup')!.hidden = !isMeta || Boolean(meta?.available);
}
provider.onchange = async () => {
  provider.disabled = true;
  try {
    const result: SpeechPreferences = await backgroundRequest('set-speech-provider', { provider: provider.value, checkMeta: provider.value === 'meta' });
    provider.value = result.provider; meta = result.meta;
    showProvider();
  } catch (error) {
    providerStatus.textContent = error instanceof Error ? error.message : 'Provider could not be saved.';
    providerStatus.dataset.tone = 'error';
    const result: SpeechPreferences = await backgroundRequest('get-speech-settings').catch(() => ({ provider: 'chrome', language: 'en-IN' }));
    provider.value = result.provider;
  } finally { provider.disabled = false; }
};
provider.disabled = true;
void backgroundRequest('get-speech-settings', { checkMeta: true }).then((result: SpeechPreferences) => {
  provider.value = result.provider; meta = result.meta; showProvider();
}).catch(() => { providerStatus.textContent = 'Speech settings could not be loaded. Reopen this page.'; providerStatus.dataset.tone = 'error'; }).finally(() => { provider.disabled = false; });

microphone.onclick = async () => {
  const status = document.querySelector('#status')!;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    status.textContent = 'Microphone allowed. Return to your website and tap the mic.';
  } catch { status.textContent = 'Microphone access was denied. Allow it in Chrome settings, then try again.'; }
};
const scope = window as typeof window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
document.querySelector('#recognition-support')!.textContent = scope.SpeechRecognition || scope.webkitSpeechRecognition
  ? 'Chrome recognition is available in this browser.' : 'Chrome recognition is unavailable. You can use Meta STT after backend setup.';
const choices = new Map<string, SavedVoice>();
let languageLoaded = false;
async function loadVoices() {
  const settings = await browser.storage.local.get([SPEECH_LANGUAGE_KEY, voiceKey('en'), voiceKey('hi')]);
  if (!languageLoaded) { language.value = speechLanguage(settings[SPEECH_LANGUAGE_KEY]); languageLoaded = true; }
  const voices: SpeechVoice[] = await browser.tts.getVoices(); choices.clear();
  for (const [family, selector, requested] of [['en', '#english-voice', 'en-IN'], ['hi', '#hindi-voice', 'hi-IN']]) {
    const select = document.querySelector<HTMLSelectElement>(selector!)!; select.replaceChildren();
    const selected = savedVoice(settings[voiceKey(family!)]) ?? pickDefaultVoice(voices, requested!);
    const candidates = voices.filter((voice) => savedVoice(voice) && voice.lang?.replaceAll('_', '-').split('-')[0] === family).sort((a, b) => voiceId(a).localeCompare(voiceId(b), 'en'));
    for (const candidate of candidates) {
      const value = savedVoice(candidate)!; const id = voiceId(value); choices.set(id, value);
      const option = new Option(`${value.voiceName} (${value.lang})`, id); option.selected = id === (selected ? voiceId(selected) : ''); select.add(option);
    }
    if (selected && !choices.has(voiceId(selected))) {
      const option = new Option(`${selected.voiceName} — unavailable`, voiceId(selected)); option.selected = true; select.add(option);
    }
    if (!select.options.length) { select.add(new Option('No voice available', '')); select.disabled = true; } else select.disabled = false;
  }
}
document.querySelector<HTMLButtonElement>('#save')!.onclick = async () => {
  const settings: Record<string, unknown> = { [SPEECH_LANGUAGE_KEY]: speechLanguage(language.value) };
  for (const [family, selector] of [['en', '#english-voice'], ['hi', '#hindi-voice']]) {
    const value = choices.get(document.querySelector<HTMLSelectElement>(selector!)!.value);
    if (value) settings[voiceKey(family!)] = value;
  }
  try { await browser.storage.local.set(settings); settingsStatus.textContent = 'Saved. Return to your website to use voice guidance.'; }
  catch { settingsStatus.textContent = 'Voice settings could not be saved. Try again.'; }
};
void loadVoices().catch(() => { settingsStatus.textContent = 'Voice choices could not be loaded. Reopen this page.'; });
browser.tts.onVoicesChanged.addListener(() => { void loadVoices().catch(() => {}); });
