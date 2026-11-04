# Reasoning

Jev runs first. One request bundles progress, completion, language, input completion,
direct control selection, and saved-step checks. Code applies the decisions.
Routine instructions use short English or Hindi templates. Muse Spark Open on
Baseten supplies new steps, explanations, and new consequence descriptions.
Muse receives no registry IDs and cannot authorize task success.

Keep assessment questions and thresholds in backend/src/assessment-questions.js.
Completion needs a probability of at least 0.9 and blocking-error probability of
at most 0.3, with current page evidence. Explicit input completion unlocks the
next step; it does not complete the whole task. Jev alone decides whole-task
completion from visible evidence. Uncertain evidence waits for a page change;
there is no question asking the user to confirm whole-task completion.
The same bundled assessment sends session.recentActions in chronological order.
Completion questions explicitly use that performed-action history with the goal,
pending step, and current result. Input events do not confirm finished entry, and
a Submit click does not prove server acceptance. No extra model call is needed.
Jev receives only goal, recent actions, pending action/input flag, and the current
page/candidates. Send current and next saved steps once. Omit full plan memory,
unused workflow metadata, and retired confirmation fields from its state.
Navigation and viewing goals can finish when their requested destination or
content is visible. Changes and submissions still require final result evidence.

Keep target questions in backend/src/target-questions.js. Jev selects each target
with a Choice and match-existence Noul. Both probabilities must reach 0.7. A
missing target permits one rescan. Ambiguity asks the user. Provider failures
remain errors. There is no heuristic target fallback.

Streaming planning uses complete newline-delimited decisions. Start first-target
selection at the first valid record while Muse emits later steps. Retain up to
three semantic steps. Jev checks current/next steps against fresh evidence; code
advances at most one step per request. An unfinished plan tail can be awaited
without another Muse request. Preserve the input-completion lock across storage.
See features/reasoning-workflow/README.md for framing, lifetime, and failure rules.
