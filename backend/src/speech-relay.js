import WebSocket from 'ws';

// One turn, 24 kHz, mono signed 16-bit PCM. Provider keys never reach the browser.
export function relaySpeech(client, options = {}) {
  const apiKey = options.apiKey ?? process.env.MODEL_API_KEY;
  if (!apiKey) {
    client.send(JSON.stringify({ type: 'error', message: 'MODEL_API_KEY is not configured.' }));
    client.close(1011);
    return;
  }
  const upstream = (options.connect ?? ((url) => new WebSocket(url)))('wss://api.meta.ai/v1/asr/realtime');
  let ready = false;
  let ended = false;
  let finished = false;
  let bytes = 0;
  let speechEndedAt;
  const send = (value) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
  const endInput = () => {
    if (!ended && ready && upstream.readyState === WebSocket.OPEN) {
      ended = true;
      upstream.send(JSON.stringify({ type: 'endStream' }));
    }
  };
  const cleanup = () => { clearTimeout(timer); clearTimeout(flushTimer); if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream.close(); };
  const fail = (message) => {
    if (finished) return;
    finished = true;
    send({ type: 'error', message });
    client.close(1011);
    cleanup();
  };
  const timer = setTimeout(() => fail('Speech session timed out.'), options.timeoutMs ?? 40_000);
  let flushTimer;
  upstream.on('open', () => upstream.send(JSON.stringify({
    authorization: { accessToken: `Bearer ${apiKey}` },
    model: 'muse-voice-transcribe-1.0', audioEncoding: 'PCM_24KHZ',
    mode: 'ENDPOINTING', partialMode: 'CUMULATIVE',
    languageBias: ['English', 'Hindi'], emitAudioProgress: false,
  })));
  upstream.on('message', (data) => {
    let event;
    try { event = JSON.parse(String(data)); } catch { fail('Invalid speech provider response.'); return; }
    if (!event || typeof event !== 'object') { fail('Invalid speech provider response.'); return; }
    if (!ready && typeof event.sessionId === 'string' && !event.type) { ready = true; send({ type: 'ready' }); return; }
    if (finished) return;
    if (event.type === 'speechEnd') speechEndedAt = Date.now();
    if (event.type === 'transcript' && typeof event.transcript === 'string') send({ type: 'partial', transcript: event.transcript.slice(0, 2000) });
    if (event.type === 'speechComplete' && typeof event.transcript === 'string') {
      const transcript = event.transcript.trim();
      if (!transcript || transcript.length > 2000) { fail('Speech transcript is empty or too long.'); return; }
      finished = true;
      endInput();
      send({ type: 'final', transcript, ...(speechEndedAt !== undefined ? { transcriptionMs: Math.max(0, Date.now() - speechEndedAt) } : {}) });
      clearTimeout(timer);
      clearTimeout(flushTimer);
      client.close(1000);
      // Give Meta time to drain its response after endStream.
      flushTimer = setTimeout(cleanup, 1000);
    }
    if (event.type === 'error') fail('Meta speech transcription failed.');
  });
  client.on('message', (data, binary) => {
    if (finished) return;
    if (binary) {
      if (!ready || ended || data.length % 2 !== 0) { fail('Invalid audio stream state.'); return; }
      bytes += data.length;
      if (bytes > 24_000 * 2 * 30) { fail('Recording exceeded 30 seconds.'); return; }
      // Reject an upload sent substantially faster than realtime.
      if (bytes > (Date.now() - connectedAt + 5000) * 48) { fail('Audio must be paced in realtime.'); return; }
      upstream.send(data, { binary: true });
    } else {
      let event;
      try { event = JSON.parse(String(data)); } catch { fail('Invalid speech command.'); return; }
      if (event?.type === 'stop') {
        if (!ready) { fail('Speech connection is not ready.'); return; }
        speechEndedAt ??= Date.now();
        endInput();
        flushTimer ??= setTimeout(() => fail('No final speech transcript was received.'), 8000);
      } else if (event?.type === 'cancel') { finished = true; client.close(1000); cleanup(); }
      else fail('Unsupported speech command.');
    }
  });
  const connectedAt = Date.now();
  upstream.on('error', () => fail('Unable to connect to Meta speech.'));
  upstream.on('close', () => { if (!finished) fail('Speech stream ended before its final transcript.'); });
  client.on('close', cleanup);
  client.on('error', cleanup);
}
