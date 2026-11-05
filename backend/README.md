# Dev - Voice Companion Backend

The Node API runs on Modal. Default speech recognition and speech output run in
Chrome. The server does not load a speech model.

- `GET /health`: startup check; returns status only and calls no provider.
- `POST /reason`: semantic request → Jev assessment → optional Baseten plan → validated GuideAction.
- `WS /speech/stream`: optional Meta transcription relay, disabled by default.

Reasoning and WebSocket requests require an exact allowed extension Origin.
Set comma-separated `ALLOWED_ORIGINS`; an empty list rejects these requests.
The origin allowlist is a browser boundary, not account authentication or a
billing limit. Keep this as a controlled prototype until user access controls
are added.

## Settings

Upload `backend/.env` as the Modal Secret `voice-companion`. Required fields:

- `BASETEN_API_KEY` and `BASETEN_MODEL=meta-models/muse-spark-open-1026`.
- `TYPESAFE_API_KEY` and `TYPESAFE_MODEL=jev-1.14.0`.
- `ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID`.
- `SERVER_STT_PROVIDER=none` for default Chrome recognition.

See [deploy/README.md](deploy/README.md) for manual deployment.
Use Node 22.15+. Run backend mock tests with `npm ci` and `npm test` in this folder.
Tests use ephemeral local ports; no local production server is required.

## Spark speed benchmark

From the repo root, with Node 22.15+, run:

```sh
node --env-file=backend/.env backend/scripts/benchmark-spark.js
```

Set `MODEL_API_KEY` (or `META_API_KEY`) and `BASETEN_API_KEY` in `backend/.env`.
No new package or local server is required. This command makes paid requests:
by default, one warmup and five measured requests to each provider (12 total).
Tests use mocked requests only.

Meta defaults to `muse-spark-1.3`. Baseten uses `BASETEN_MODEL`, with
`meta-models/muse-spark-open-1026` as its default. Spark Open is a separate release;
these defaults compare two model/provider combinations, not the same model on
two hosts. Set `META_MODEL` and `BASETEN_MODEL` to the exact models you want.
Optional base URLs are `META_API_BASE_URL` and `BASETEN_API_BASE_URL`.

```sh
node --env-file=backend/.env backend/scripts/benchmark-spark.js \
  --runs 10 --warmups 1 --max-tokens 1024 --reasoning-effort low \
  --output /tmp/spark-results.json
```

Use `--prompt "..."` to change the synthetic prompt, or `--timeout-ms 60000`
to set a request timeout. Both providers get the same prompt, token limit, and
reasoning effort. Requests run one at a time and alternate provider order.
The report shows p50/p95 time to first visible text and total completion time.
Role-only and reasoning chunks do not count as first text. Token speed is
provider-reported completion tokens divided by total time, including reasoning
and network time; it is not decode speed. If streaming usage is absent, token
speed is `n/a`. Warmups are excluded. Repeated prompts may use provider caches;
the JSON report includes cached-token counts when supplied. Five runs give a
rough speed check; p95 needs more samples for a stable comparison.

Failures are counted, without retries or raw provider error bodies. A measured
failure sets exit code 1. `truncated` counts responses that hit the output limit;
increase `--max-tokens` if needed. The optional JSON report includes each result
and returned model ID, but excludes keys, prompt text, and generated text.

References: [Meta Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions),
[Meta models](https://dev.meta.ai/docs/models),
[Baseten Chat Completions](https://docs.baseten.co/reference/inference-api/chat-completions).

## Reasoning contract

`/reason` accepts `userUtterance`, optional `userLanguage` and `trigger`, bounded `session`
memory, and safe page metadata plus semantic controls. It rejects unknown fields,
duplicate element IDs, more than 1,000 elements, and bodies over 512 KiB.

Jev runs first. It checks goal completion, errors, explicit input completion,
direct requests, reply language, and saved-step validity in one request. Routine
actions use short templates. New steps, explanations, and new consequences use
Muse. Automatic checks do not replay old speech. No-progress checks wait without
Muse. Completion requires page evidence, at least 0.9 completion probability, and
at most 0.3 blocking-error probability. Input completion is a separate transition.
An unclear final result asks one short confirmation question.

Optional `decisionContext` on each action returns task status, goal, a reusable
semantic step, and confirmation state. The extension validates and redacts it,
saves it without DOM IDs, and returns it in `session.decisionContext`. Completed
tasks do not restart after reload. See features/backend-api/README.md for fields.

Muse receives no registry IDs. Its PlanDecision supplies the semantic action,
target description, instruction, consequence, language, and workflow readiness.
Output is validated locally; malformed output gets one repair attempt. Transient
provider failures have bounded retries. No alternate model is substituted.

Jev receives a bundled Choice and match-existence Noul. Both match probability
and the selected option probability must reach 0.7. A match probability at or
below 0.3 produces HTTP 409 (`TARGET_NOT_FOUND`), allowing one rescan. Other
uncertain results produce clarification. Provider failures produce HTTP 502.

The final GuideAction is validated on the server and in the extension. A guide's
expected action follows the selected role. Consequential steps require an
explanation. `Server-Timing` reports assessment and optional planning and selection durations.
`x-reasoning-decision` reports Muse call count and the escalation reason. Muse
cannot bypass the completion gate. Normal speech is one short instruction; longer
explanations need an explicit user request.

## Optional Meta speech

To enable server transcription, set `SERVER_STT_PROVIDER=meta` and
`MODEL_API_KEY` in the Modal Secret. Redeploy, then choose Meta STT in the
companion or Speech settings. The extension uses `POST /speech/status` before
capture; this check reads configuration only. It validates the allowed Origin
and does not contact Meta. GET remains available for older callers that send a
valid Origin. The default `none` mode returns a clear error to any
speech WebSocket request and does not construct a provider client.

The Meta adapter uses `muse-voice-transcribe-1.0`, `ENDPOINTING`, `PCM_24KHZ`,
cumulative partials, and English/Hindi hints. It accepts paced 24 kHz signed
16-bit little-endian mono PCM after its ready event. Only Meta speechComplete
produces a final transcript. Stop sends endStream; cancellation closes the stream.
Audio is capped at 30 seconds, packets at 16 KiB, and sessions at 40 seconds.
Provider keys and raw provider error bodies never reach the extension.

## Streamed guidance

POST /reason/stream uses SSE to deliver the first Jev-validated action while Muse
continues emitting later semantic steps. Keep /reason for legacy callers. See
[workflow specification](../features/reasoning-workflow/README.md) for contracts,
Stop behavior, and bounded stale-target recovery. All tests use mocked providers.
