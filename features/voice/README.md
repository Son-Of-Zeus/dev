# Voice

Chrome SpeechRecognition is the default input. It runs in the extension-owned
offscreen document, with standard and webkit-prefixed constructor support.
Chrome may use Google's online service. Audio does not pass through the Modal
speech endpoint in this mode. Recognition failures are reported; they never
silently switch providers.

One activation accepts one turn, with interim text and a final result on end.
Only final results start planning. Capture stops at 30 seconds; Finish recording waits
up to eight seconds for a final response. Stop releases recognition at
once and discards late events. The visible Speech settings page grants microphone
access and chooses English (India), English (US), or Hindi.

Chrome TTS saves a voice name, language, and engine for English and Hindi. The
selection persists across worker and browser restarts. Enumeration order cannot
change a saved selection. If that voice is absent, keep the instruction visible
and ask the user to choose a replacement in extension Options.

The Meta streaming relay is selected at runtime from the companion or Speech
settings. Enable SERVER_STT_PROVIDER=meta and MODEL_API_KEY on the backend first.
The saved provider overrides the build default. Check configuration through
GET /speech/status before capture. Do not silently use Chrome after a Meta error.
Both capture modes still run in the extension-owned offscreen document.
