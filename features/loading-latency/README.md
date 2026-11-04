# Loading Latency

Show immediate listening/thinking state and a delayed slow-work notice. Measure
recognition, Jev assessment, Muse planning, selection, page settling, layout,
movement, and Chrome speech. Use client reasoning wall time in totals and omit its
provider sub-stages so parallel work is not added twice.

The legacy endpoint reports assessment/planning/selection in Server-Timing and
Muse call count/escalation reason in x-reasoning-decision. The streaming endpoint
sends diagnostic and decision events. First-step measures planning start to first
complete record, first-guidance measures request start to validated action, and
plan-completion measures planning start to end of the plan. These markers are
breakdown data, not additional elapsed time. Test with mocked providers only.
