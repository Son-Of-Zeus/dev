# Dev - Voice Companion

A general Chrome Manifest V3 extension for voice and visual website guidance.
The user performs every website action. The companion scans, highlights, scrolls,
explains, and observes.

## Voice and model flow

1. Activate the extension with its toolbar icon and tap the floating microphone.
2. Chrome SpeechRecognition transcribes one request and shows interim text.
3. After the final transcript, Jev checks progress and selects clear control requests.
4. Muse Spark Open on Baseten plans only new steps and requested explanations.
5. The extension validates the live control, highlights it, and speaks with Chrome TTS.
6. Perform the action yourself. Explicitly confirm text entry when finished.

| Role | Provider | Model or API |
| --- | --- | --- |
| Speech input | Chrome | SpeechRecognition / webkitSpeechRecognition |
| Step planning | Baseten | `meta-models/muse-spark-open-1026`, low reasoning effort |
| DOM selection | TypeSafe | `jev-1.14.0` |
| Spoken instructions | Chrome TTS | Saved voice name and engine for each language |
| Optional server speech | Meta Model API | `muse-voice-transcribe-1.0` |

Chrome recognition may use Google's online speech service. It is not guaranteed
to work offline. Audio does not go to Modal in the default Chrome mode; the final
transcript goes to Modal for planning. Recognition failures produce an error and
do not silently switch to a server provider.

SAM is not required. Control geometry comes from the live DOM. No local backend
or downloaded speech model is required on the user's computer.

## Speech settings

Expand the companion and choose Speech settings, or open Options from the Chrome extension menu. Set the recognition
language to English (India), English (US), or Hindi. Chrome recognizes one selected
language per turn. The default is English (India).

Choose an English and Hindi output voice, then save. Voice choices persist in
extension storage. If a saved voice becomes unavailable, the companion keeps the
instruction visible and asks you to choose a new voice instead of changing it.

## Deploy and connect Chrome

Follow [backend/deploy/README.md](backend/deploy/README.md) for manual deployment.
The Modal image contains the Node API only. It uses one CPU, 512 MiB memory, no
minimum warm containers, and a 30-second idle scale-down window. The next request
can have a cold-start delay after the app scales to zero.

Set the public origin printed by `modal deploy` in `apps/extension/.env`:

```dotenv
WXT_BACKEND_URL=https://YOUR_MODAL_HOST
WXT_STT_PROVIDER=chrome
```

Run `npm run build` and reload the unpacked extension at
`apps/extension/.output/chrome-mv3`. Chrome 116+ and Node 22.15+ are required.
Missing or non-HTTPS backend settings stop the build with an error. The installed
Chrome must provide SpeechRecognition. Provider keys never belong in the extension.

The Meta streaming adapter remains available. To use it explicitly, set
`SERVER_STT_PROVIDER=meta` and `MODEL_API_KEY` in the Modal Secret, then redeploy.
Choose Meta STT in the expanded companion or Speech settings. Provider changes apply to the next recording and do not need another build. The build setting only supplies the default when no provider is saved.

## Behaviour and limits

- Activation and task context are scoped to one tab and origin. Reloads and same-origin navigation retain bounded task memory. A new origin requires another icon click.
- Stop cancels all work, stops observers, and clears task memory. It does not change the website.
- Native controls, accessible custom controls, SPA navigation, and open Shadow DOM are supported.
- Iframe controls, closed Shadow DOM, canvas controls, browser pages, and the Chrome Web Store are unsupported.
- Snapshots are limited to 1,000 controls and 512 KiB. Open a relevant section or a simpler page if either limit is exceeded.
- Capture is explicit, one turn at a time, and limited to 30 seconds. Stop and cancellation release the microphone.
- Page text is untrusted data. No raw HTML or editable field contents are sent for planning or selection. Sensitive text patterns are redacted before requests and persistence.
- Model failures produce errors. Jev ambiguity produces clarification. A missing target causes one rescan, then clarification. There is no heuristic target fallback.

## Development

After setting the hosted URL and installing dependencies:

```sh
npm run dev
npm run typecheck
npm test
npm run build
```

Automated tests use synthetic DOM fixtures and mocked providers and browser speech
APIs. Backend tests bind temporary test ports. No local production backend, demo
website, embedded runtime, or database is included. See [SETUP.md](SETUP.md).
