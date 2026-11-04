# Session State

Store a bounded redacted goal, workflow readiness, decision context, and up to
eight recent semantic actions in storage.session per tab and origin. Decision
context contains active/completed task status, the goal, an optional semantic
step. Discard old whole-task confirmation flags during validation. The semantic step has a
target description, short instruction, reply language, and optional consequence.

Never persist DOM IDs, pending DOM actions, or the transient inputComplete flag.
Validate and redact context before storage. Older sessions without decision
context remain active. Same-origin reloads rebuild the registry and resume active
tasks only. Completed tasks remain stopped. Origin changes, tab close, task reset,
and a new task clear prior context.

Plans contain one to three redacted semantic steps, currentStepIndex, id, and
complete. Deep-copy nested steps. Keep awaitingInputCompletion; drop transient
inputComplete. Stop clears this memory. Monotonic worker session revisions prevent
a delayed save from restoring a cleared task.

On document restore, close the old plan tail (complete=true). Retain committed
steps, recheck them with Jev, and replan when they are exhausted. Never wait for
records from the old document.
