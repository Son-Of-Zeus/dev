# Speech setup

Chrome recognition is the default. Expand the companion to change Speech input
or open Speech settings. Provider changes save immediately and apply to the next
recording. Recognition language and fixed English/Hindi voices have a separate
Save voice settings button. Allow microphone access from the settings page once.

## Meta STT

1. Set SERVER_STT_PROVIDER=meta in backend/.env. Supply MODEL_API_KEY on the server.
2. Upload the complete backend settings to the Modal secret and deploy the backend,
   as described in backend/deploy/README.md.
3. Reload the rebuilt extension in chrome://extensions, then choose Meta STT in
   the expanded companion or Speech settings.

POST /speech/status checks configuration without calling a paid provider. The UI
shows setup help when Meta is disabled, the key is missing, or the deployed
backend predates the status endpoint. It does not silently fall back to Chrome.
Speech output continues to use the selected Chrome voice.

The extension uses the deployed HTTPS backend. No local production backend is
required. Provider keys remain server-side. Changes in this checkout do not
change the deployed backend until a separate deployment is authorized.

## Verification

Run root typecheck, tests, and build. Tests use synthetic data and mocked speech
and model calls. Backend HTTP and WebSocket tests need local port access. Live
microphone accuracy and animation rendering need separate browser checks.
