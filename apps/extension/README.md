# Chrome Extension

The extension runs only after a toolbar-icon click. WXT builds the background
worker, runtime-injected content script, offscreen microphone document, and
visible microphone permission page.

The content script owns semantic extraction, the registry, the floating Shadow
DOM companion, guidance, and user-action observation. It has no provider keys
and performs no backend fetches. A restricted message bridge sends reasoning and
speech commands to the worker.

The worker owns same-origin tab sessions, the backend HTTP connection, offscreen
capture coordination, and Chrome TTS. Sessions are stored in `storage.session`,
with eight recent actions and bounded redacted planning memory. Pending target
IDs are never persisted. Document IDs reject stale messages after navigation.

The offscreen document streams 24 kHz mono PCM over the Modal backend WebSocket. Its
AudioWorklet resamples across buffer boundaries. Partial transcripts update the
companion; only a final transcript starts reasoning. All microphone tracks close
on stop, cancellation, failure, or navigation.

Set `WXT_BACKEND_URL` to the deployed HTTPS backend origin before building.
There is no localhost fallback. The build
requests host access to that origin only, plus `activeTab`, `scripting`, `storage`,
`offscreen`, and `tts`. CSS is bundled directly into the content script; no broad
web-accessible resource permission is required.

```sh
npm install
npm run typecheck
npm test
npm run build
```

Load `.output/chrome-mv3` as an unpacked extension. See the root README for server
keys, origin configuration, supported controls, and Modal setup.
