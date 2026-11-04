# Error Recovery

Clear the old instruction and highlight when guidance fails. Show the current
error with a separate retry control. Retry reuses the saved transcript; the mic
captures a new request. Keep unfinished text entry pending across recoverable
errors and clarification.

A tab loading event does not prove that its document changed. Keep the document
binding when Chrome reports the same main-document ID. Recover a missing binding
only after verifying the current document through scripting. Reject inactive or
old documents with STALE_DOCUMENT. The stale content bridge removes its UI once
and stops sending cleanup requests. Never retry old guidance on another document.

For a same-document stale target, automatically settle, rescan, and ask Jev again
once before showing Retry. Share this budget with missing-target recovery and
page-evidence changes. Never remap a target by label. Stop cancels recovery.

Model errors use static, validated failure codes. Distinguish invalid Muse plans
from provider access, overload, availability, and timeout failures. Server logs
record only those safe categories and the provider name. Do not show raw provider
error bodies. A complete final JSON step may end at normal provider completion
without a final newline.
