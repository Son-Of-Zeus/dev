# Backend API

GET /health reports startup without provider calls. POST /reason accepts bounded
semantic state and returns a validated GuideAction. Optional trigger identifies
user, manual-action, page-change, or resume; omitted trigger means user.

Page evidence is an optional list of up to 12 {kind, text} items. Kinds are heading,
status, alert, and text. Each text item is at most 240 characters. Optional
session.decisionContext is sent back from the previous response. Optional action
decisionContext carries taskStatus (active/completed), goal, a reusable semantic
step, and a transient inputComplete flag. The legacy awaitingConfirmation flag is
accepted as a boolean and dropped. Jev alone decides whole-task completion from
page evidence; no user confirmation bypass exists. Save no DOM IDs
or transient input completion flags in decision memory.

Server-Timing reports assessment and optional planning/selection duration.
x-reasoning-decision reports Muse call count and escalation reason. Chrome handles
speech by default and sends only final transcripts for assessment.

WS /speech/stream is reserved for the optional Meta relay. Enable it explicitly
with SERVER_STT_PROVIDER=meta and build with WXT_STT_PROVIDER=server. The backend
rejects unapproved origins. Keys remain server-side. See backend/README.md.

POST /speech/status is restricted to allowed origins and reports {available,
message} for Meta STT configuration. It makes no model or speech provider call
and exposes no key. GET /health retains its original response.

POST /reason/stream accepts the same request and returns SSE JSON envelopes for
plan, action, diagnostic, decision, done, and error. Actions arrive before the
plan tail ends. A plan has id, steps, currentStepIndex, and complete; steps add
precondition and expectedOutcome to the existing semantic step. Decision context
also supports awaitingInputCompletion. Optional page.origin is an exact HTTP or
HTTPS origin, verified by the worker. No URL path, query, or fragment is sent.
