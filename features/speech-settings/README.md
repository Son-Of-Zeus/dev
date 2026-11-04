# Speech Settings

Save the recognition provider as companion:speech-provider (chrome or meta) in
storage.local. A missing preference uses the build default: WXT_STT_PROVIDER=chrome
or the legacy server default. Select the provider in the expanded companion or
Speech settings. Changes apply to the next recording. Keep language and output
voice preferences separate. Block provider changes during an active recording.

Meta requires SERVER_STT_PROVIDER=meta and MODEL_API_KEY in the deployed backend.
POST /speech/status checks configuration only, requires an allowed extension
origin, exposes no key, and makes no provider call. Check this status before Meta
capture. Show disabled, unreachable, and older-backend setup states explicitly.
Never silently switch to Chrome when Meta is selected but unavailable.

The visible settings page grants microphone permission, explains audio routing,
and contains server setup instructions when required. Provider changes save
immediately. Language and fixed English/Hindi Chrome voices use Save voice settings.

The status request uses POST with a small JSON body. Chrome can omit Origin on
privileged GET requests; the server still requires the exact allowed Origin.
Keep GET for older callers with an explicit valid Origin. Coalesce concurrent
checks. Allow 30 seconds for a cold start. Report HTTP rejection, timeout, invalid
JSON, and connection failure separately. A configured status does not verify the
key with Meta. No raw provider errors or keys are returned to the extension.
