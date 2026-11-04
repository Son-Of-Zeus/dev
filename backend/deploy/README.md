# Manual Modal deployment

The image contains the Node reasoning API and an optional Meta speech relay.
Chrome handles speech recognition and spoken output by default. No speech model
or compiler toolchain is installed in the container.

Run commands from the project root. The Modal CLI is already in
`backend/.venv-modal` on this Mac. On a new machine, create that environment:

```sh
python3.12 -m venv backend/.venv-modal
backend/.venv-modal/bin/python -m pip install -r backend/deploy/requirements.txt
```

Sign in if needed:

```sh
source backend/.venv-modal/bin/activate
modal setup
```

Check `backend/.env`. It must have the Baseten and TypeSafe keys and the exact
extension origin. The current extension ID is `ejmkjigejpjdfpiccbbpdlofgnmdbkhg`.
Keep `SERVER_STT_PROVIDER=none` for Chrome speech. No Meta key is needed in this mode.

Upload the settings and deploy:

```sh
modal secret create voice-companion --from-dotenv backend/.env --force
modal deploy backend/deploy/modal_app.py
```

`--force` replaces the existing secret. These commands are manual; the agent does
not upload settings or deploy as part of the current cleanup.

The deployment uses one CPU, 512 MiB memory, `min_containers=1`,
`buffer_containers=0`, `max_containers=1`, and `scaledown_window=30`. Modal keeps
one container running to avoid idle cold starts. This incurs ongoing charges.
[Modal scaling](https://modal.com/docs/guide/scale)

Verify startup without calling a paid model:

```sh
curl --fail https://YOUR_MODAL_HOST/health
```

Expected response: `{"status":"ok"}`. Set the printed API origin in
`apps/extension/.env`, then build:

```dotenv
WXT_BACKEND_URL=https://YOUR_MODAL_HOST
WXT_STT_PROVIDER=chrome
```

```sh
npm run build
```

Reload Voice Companion in `chrome://extensions`. For a first installation, load
`apps/extension/.output/chrome-mv3` as an unpacked extension. Verify its ID and
update the origin allowlist if needed. Open the extension's Options to choose
recognition language and fixed English/Hindi voices.

The current cloud deployment keeps its previous code and resource settings until
you deploy this version. Old speech settings are not used by the new code.

To stop the deployed app completely:

```sh
modal app stop voice-companion
```

For optional Meta transcription, set `SERVER_STT_PROVIDER=meta` and `MODEL_API_KEY`
in the secret, redeploy, then choose Meta STT in the companion or Speech settings. No further extension build is needed to switch providers. The adapter is
retained. [Modal deployment guide](https://modal.com/docs/guide/webhooks)
