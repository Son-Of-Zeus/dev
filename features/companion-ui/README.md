# Companion UI

The companion starts as a compact 288-pixel pill. Its mic and disclosure button
stay visible. The body expands for instructions, listening, or an error, and can
be collapsed manually. Animate height and opacity with a CSS grid transition.
Respect reduced motion and remove collapsed controls from keyboard navigation.
Only the target cursor moves beside a highlighted control; the panel stays docked.

Errors hide stale instructions and transcripts and use a readable alert. The mic
starts a fresh voice request. Retry repeats the saved request without recording
again. Stop, Finish recording, Speech settings, and a saved Chrome/Meta STT selector are in the
expanded body. Timing details remain inside a closed disclosure.

Use neutral light/dark surfaces, clear contrast, live status, and labelled controls.
