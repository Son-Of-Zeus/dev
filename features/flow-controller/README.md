# Flow Controller

Run voice → safe snapshot → Jev assessment → Muse only when needed → validated
guidance → observed manual action. Requests identify their trigger: user speech,
manual action, page change, or resume. Automatic checks do not replay old speech
as a new command.

Coalesce continuation events and suppress duplicate automatic requests and
repeated guidance for the same pending step. Check changed page evidence while
waiting, including delayed submission results. Do not check automatically during
pending text entry. New speech goes to Jev to classify explicit completion,
questions, or task replacement.

Discard cancelled requests and answers based on old page evidence. Check live
targets before guidance. On success, clear pending guidance, save completed task
status, and speak once. Reload does not resume a completed task. New speech after
completion starts a fresh task; a distinct goal clears old task memory.

Stop makes the task inactive before cancellation and clears its memory. Do not
start observers again until explicit microphone input. Task-bound plan tails can
continue after the first action while later selection requests use fresh evidence.
Use one shared stale-context recovery budget per guidance cycle, including HTTP
409, replaced controls, changed evidence, and stale guide preparation.
