# Stream Muse Steps, Fix Stop, and Recover Stale Targets

## Purpose

Reduce time to first guidance. Muse commits one complete step before it writes
later steps. Jev selects a live control for that step while Muse continues.
The user performs every website action. Stop cancels all work and clears the task.
There are no Reset, Pause, or Resume buttons.

## Stream contract

Keep the initial bundled Jev assessment. A direct request uses Jev and a short
instruction without Muse. When planning is needed, use Baseten streaming with the
existing model, low reasoning effort, and bounded request timeout.

Ask Muse for one JSON record per line. Guide records use these fields:

```json
{"sequence":1,"decision":{"action":"guide","targetDescription":"Settings button in the header","spokenInstruction":"Open Settings.","language":"en-IN","workflow":{"readiness":"ready","requiredInformation":[],"knownInformation":[],"missingInformation":[]}},"precondition":"Home is visible.","expectedOutcome":"Settings is visible."}
```

Each decision uses the existing PlanDecision contract. Require consecutive
sequence numbers starting at 1 and one to three steps. The first non-guide
decision is terminal. All later records must be guide decisions. Every guide step must
include its instruction, prerequisites, expected visible result, and any required
consequence before it is committed. Later steps are provisional, not proof of
unseen controls. Committed steps cannot be revised.

Terminal explanations, clarifications, and waits require sequence and decision.
They can omit precondition and expectedOutcome because they do not enter the
action queue. If supplied, those fields must still have valid types and bounds.
Guide records always require both fields.

Decode provider SSE frames, then assemble answer-content deltas into complete JSON
objects. Track string escapes and nested braces across chunks. Accept valid JSON
with line breaks inside the object and a final object without a trailing newline.
Never repair content by guessing fields or changing the model's decision.
Handle split UTF-8, CRLF, escaped newlines, and several records in one chunk.
Ignore reasoning and role-only deltas. Limits are 1 MiB of provider data, 64 KiB
per SSE frame, 16 KiB per record, and 256 KiB of answer text. Validate every record.
Require a normal provider completion and its completion marker. Emit each complete
validated object immediately, before reading later records in the same chunk. Incomplete
JSON or an interrupted provider stream remains an error.

Keep bounded transport retries and one format repair before the first commit.
After a commit, never replay the stream. A failed tail keeps the current
instruction, discards unissued future steps, and allows later replanning.
Format repair receives a static rejection category. Public errors and backend
logs can include only an allowlisted structural reason, such as step_evidence or
record_json, plus the rejected field and rule. Do not include generated text,
page data, or provider response bodies in public errors.
During an explicitly enabled diagnostic session, rejected records can also be
logged as bounded, redacted summaries. See the development diagnostics note.

Executable-content checks require code syntax, such as a function parameter list
or a variable declaration with assignment. Ordinary descriptions such as
"function header", "function page", and "let me" remain valid. Apply the same
check to backend instructions, extension speech, and stored plan text.

## Reasoning API and memory

POST /reason/stream has the same request and Origin boundary as POST /reason.
It returns SSE JSON envelopes: plan, action, diagnostic, decision, done, or error.
Deliver the validated action before waiting for the plan tail. Stream failures
after response headers use an error envelope with status/code. Keep /reason for
existing callers. Provider keys stay on the server.

The extension background layer relays events only to the bound active main
document. Selection belongs to a request and page revision. After its action is
delivered, the plan tail belongs to the task and plan ID. A normal continuation
must not abort that tail. Stop, replacement, origin change, and teardown cancel it.
Reject cancelled actions and plan events from an old task or generation.

Decision memory contains plan ID, one to three semantic steps, currentStepIndex,
and complete. The index can equal the step count while the tail is still coming.
Wait for a new record or completion event in that case. Keep the current step as
the legacy step mirror. Each step contains targetDescription, spokenInstruction,
language, optional consequence, precondition, and expectedOutcome. Preserve the
semantic awaitingInputCompletion flag across storage. Never persist DOM IDs,
selectors, pending DOM actions, or form values. Validate, redact, and deep-copy
memory. Old saved-step sessions remain supported. On document restore, mark the
old plan tail closed: committed steps remain usable, but no old stream can append
more records. Replan after those steps are exhausted.

Send optional page.origin only: HTTP/HTTPS scheme, host, and port. The background
layer verifies it against the document binding. Do not send URL credentials,
paths, queries, or fragments. Both models receive the current semantic page
snapshot. Muse receives no registry IDs, HTML, editable text, or form values.

On continuation, bundle Jev questions for current-step completion/applicability,
next-step applicability and target match, errors, and whole-task completion.
Code advances at most one step per request. Applicability, match existence, and
selected-target probabilities must reach 0.7. Entry requires explicit user
completion. Jev decides whole-task completion from page evidence, with the 0.9
completion and 0.3 blocking-error gates. Do not ask the user to decide whether the
whole task is complete. Low evidence returns wait; plan exhaustion and Muse
success are not proof. Remove legacy awaitingConfirmation flags during validation.
The same Jev call receives the existing chronological recentActions list. Ask it
to assess the full goal using those actions, the pending step, and the current
result. No separate planner or completion call is added.

For viewing and navigation goals, the requested destination or content can prove
completion. Include visible selected tabs and current-page labels as redacted
status evidence. A selected tab does not prove a save, payment, or submission.
Automatic evidence checks keep the current UI state instead of flashing Thinking.
Only new user requests show Thinking. Once Jev confirms completion, stop observers
and discard late automatic work as before.

Example: Muse emits Open Settings. Jev selects Settings while Muse emits Choose
Hindi and Save. The user opens Settings. Only then can fresh page evidence support
selection of the Language control. If the saved plan no longer fits, replan;
missing evidence can instead require a rescan, wait, or clarification.

## Stop and recovery

Expose Stop throughout a task, including recording and waiting. The square Stop
button cancels the task. Finish recording is a separate recording-only action
that submits speech for processing.

Stop first invalidates the task generation. Cancel capture without processing
unfinished speech, speech output, selection, Muse streams, timers, observers, and
guidance. Clear task memory, plan queue, history, pending actions, transcripts,
retry state, caches, and highlights. Persist the cleared session. Monotonic session
revisions reject delayed old writes; worker generations reject delayed work.
Clicks, mutations, navigation, and late results cannot restart a stopped task.
The next explicit microphone request starts fresh. Teardown remains separate so
normal same-origin document replacement can retain an active task.

Use one recovery attempt per logical guidance cycle for stale/replaced targets,
changed semantic evidence, missing-target responses, and stale guide preparation.
Cancel stale selection/presentation, wait for settling, rescan, bypass caches,
and ask Jev with the original utterance and trigger. Revalidate before speech.
Do not replace a target by matching its label in code. Repeated failure asks for
clarification or Retry; it must not schedule an unbounded retry loop.

Semantic fingerprints omit DOM IDs, geometry, viewport state, and harmless
control ordering. Keep control states, duplicate counts, and page evidence.
Registry identity still governs request caching and final live checks.
STALE_DOCUMENT stops the old content instance; never replay it on a new document.

## Verification and delivery

Use synthetic state and mocked providers. Test early selection/delivery, arbitrary
stream boundaries, malformed and truncated records, tail failure, queue lifetime,
Stop races, distinct recording completion, session redaction, and stale-target
recovery with a shared retry limit. Retain input, consequence, privacy, and
whole-task completion tests.

Diagnostics report first complete step from planning start, first validated action
from request start, and full plan completion from planning start. Use the existing
client reasoning wall time for totals; do not sum overlapping provider stages.

Run npm run typecheck, npm test, npm run build, and a whitespace diff check. Backend
tests bind local ports. This checkout has no Git metadata; use a saved source
snapshot for the equivalent git diff --no-index --check comparison. Do not run
paid benchmarks, call live providers, or deploy without a separate instruction.

## Safe failure details

Report stable categories for provider configuration, access, rate limits,
availability, timeouts, invalid Muse plans, and invalid Jev decisions. Only static
messages, the provider name, and an allowlisted structural rejection category,
field, and rule can
reach UI or logs. Never expose provider bodies,
request data, generated text, or keys. A streamed HTTP 200 is not proof of model
success: the client must inspect action/error envelopes.
