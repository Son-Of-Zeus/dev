# Development Diagnostics

Runtime diagnostics are opt-in and contain redacted semantic snapshots and numeric target rectangles. Provider keys, raw HTML, editable text, and form values must not be logged. All model tests use synthetic state and mocked responses.

Set MUSE_DEBUG_RESPONSES=1 on the backend to inspect rejected Muse records. This
temporary deployment enables that flag for the reported failure. Each rejection
logs the attempt, commit count, exact allowlisted field/rule, and a bounded,
redacted record summary. Only known plan fields are retained; workflow arrays
show counts and types. URLs, emails, long numbers, credentials, token patterns,
and markup are removed. Requests, reasoning deltas, unknown field names/values,
and unparsed content are never logged. Disable the flag after the fault is traced.
