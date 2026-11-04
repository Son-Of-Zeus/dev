import { browser } from 'wxt/browser';
import { SPEECH_URL } from '../../platform/config';
import { startChromeRecognition, type RecognitionConstructor } from '../../voice/chrome-recognition';
import { speechLanguage } from '../../platform/speech-settings';

type Capture = { id: string; stop(): void; cancel(): void };
let active: Capture | undefined;

async function captureServer(id: string) {
  if (active) throw new Error('The microphone is already in use by another tab.');
  const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
  if (permission.state !== 'granted') throw new Error('NEED_MIC_PERMISSION');
  return new Promise<{ transcript: string; transcriptionMs?: number; language?: string }>((resolve, reject) => {
    const socket = new WebSocket(SPEECH_URL);
    let stream: MediaStream | undefined;
    let audio: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let processor: AudioWorkletNode | undefined;
    let settled = false;
    let stopping = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = setInterval(() => { void browser.runtime.sendMessage({ target: 'background', op: 'speech-heartbeat', requestId: id }).catch(() => {}); }, 15_000);
    let deadline = setTimeout(() => fail('Speech service did not become ready.'), 35_000);
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(deadline); clearInterval(heartbeat);
      processor?.disconnect(); source?.disconnect(); stream?.getTracks().forEach((track) => track.stop());
      void audio?.close().catch(() => {});
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      if (active?.id === id) active = undefined;
    };
    const fail = (message: string) => { if (settled) return; settled = true; cleanup(); reject(new Error(message)); };
    const finishStop = () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
      stream?.getTracks().forEach((track) => track.stop()); source?.disconnect(); processor?.disconnect();
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      if (!ready) { fail('Speech connection was stopped before it was ready.'); return; }
      if (processor) processor.port.postMessage('flush'); else finishStop();
    };
    active = { id, stop, cancel: () => fail('Speech capture cancelled.') };
    socket.onmessage = async (message) => {
      let event;
      try { event = JSON.parse(String(message.data)); } catch { fail('Invalid speech response.'); return; }
      if (!event || typeof event !== 'object') { fail('Invalid speech response.'); return; }
      if (event.type === 'ready' && !ready) {
        ready = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => fail('Speech recognition timed out.'), 45_000);
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
          if (settled || stopping) { stream.getTracks().forEach((track) => track.stop()); return; }
          audio = new AudioContext();
          await audio.audioWorklet.addModule(browser.runtime.getURL('/pcm-worklet.js'));
          if (settled || stopping) { void audio.close(); return; }
          source = audio.createMediaStreamSource(stream);
          processor = new AudioWorkletNode(audio, 'pcm-capture');
          processor.port.onmessage = (packet) => {
            if (settled) return;
            if (packet.data === 'flushed') { finishStop(); return; }
            if (packet.data instanceof ArrayBuffer && socket.readyState === WebSocket.OPEN) {
              if (socket.bufferedAmount > 240_000) { fail('Audio connection is too slow. Try again.'); return; }
              socket.send(packet.data);
            }
          };
          source.connect(processor); processor.connect(audio.destination);
          await audio.resume();
          if (!settled && !stopping) timer = setTimeout(() => stop(), 30_000);
        } catch { fail('Unable to capture microphone audio. Check microphone access.'); }
      }
      if (event.type === 'endpoint') stop();
      if (event.type === 'partial' && typeof event.transcript === 'string') {
        void browser.runtime.sendMessage({ target: 'background', op: 'speech-event', requestId: id, transcript: event.transcript }).catch(() => {});
      }
      if (event.type === 'final' && typeof event.transcript === 'string' && !settled) { settled = true; cleanup(); resolve({ transcript: event.transcript, ...(['en-IN', 'hi-IN'].includes(event.language) ? { language: event.language } : {}), ...(typeof event.transcriptionMs === 'number' && Number.isFinite(event.transcriptionMs) ? { transcriptionMs: event.transcriptionMs } : {}) }); }
      if (event.type === 'error') fail(typeof event.message === 'string' ? event.message : 'Speech recognition failed.');
    };
    socket.onerror = () => fail('Cannot connect to the speech backend.');
    socket.onclose = () => { if (!settled) fail('Speech connection closed before the final transcript.'); };
  });
}
async function captureChrome(id: string, language: unknown) {
  if (active) throw new Error('The microphone is already in use by another tab.');
  const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
  if (permission.state !== 'granted') throw new Error('NEED_MIC_PERMISSION');
  const scope = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  const capture = startChromeRecognition(scope.SpeechRecognition ?? scope.webkitSpeechRecognition, speechLanguage(language), (transcript) => {
    void browser.runtime.sendMessage({ target: 'background', op: 'speech-event', requestId: id, transcript }).catch(() => {});
  });
  active = { id, stop: capture.stop, cancel: capture.cancel };
  const heartbeat = setInterval(() => { void browser.runtime.sendMessage({ target: 'background', op: 'speech-heartbeat', requestId: id }).catch(() => {}); }, 15_000);
  try { return await capture.result; }
  finally { clearInterval(heartbeat); if (active?.id === id) active = undefined; }
}
browser.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id || sender.tab || message?.target !== 'offscreen') return;
  if (message.op === 'capture' && typeof message.requestId === 'string') {
    if (!['server', 'chrome'].includes(message.provider)) { sendResponse({ ok: false, error: 'Choose a supported speech provider.' }); return; }
    const capture = message.provider === 'server' ? captureServer(message.requestId) : captureChrome(message.requestId, message.language);
    capture.then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: error.message })); return true;
  }
  if (message.requestId === active?.id) {
    if (message.op === 'stop') active?.stop();
    if (message.op === 'cancel') active?.cancel();
  }
  sendResponse({ ok: true });
});
