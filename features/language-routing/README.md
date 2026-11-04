# Language Routing

Chrome recognition uses one language selected in extension Speech settings:
en-IN (default), en-US, or hi-IN. The final text and selected language go to Jev.
Jev chooses en-IN or hi-IN for routine reply templates. Muse chooses the reply
language when it generates a new step or explanation. Reused instructions keep
their original language.

Chrome TTS uses the saved voice and engine for that language family. It does not
silently change a missing saved voice. Instructions remain visible when speech
is unavailable. The optional Meta relay retains its English/Hindi language hints.
