# Repository Guidelines

Explain changes in plain, direct language, using approximately 80% ASD-STE 100 style.

## Structure

- `apps/extension/`: WXT, React, TypeScript, Chrome Manifest V3.
- `backend/`: Node reasoning API, Meta streaming speech relay, and Modal deployment definition.
- `features/`: focused architecture notes.

The product is a general Chrome extension. Do not add a demonstration website,
site-specific selectors, page hooks, or an embedded runtime.

## Commands

From the root, use `npm run typecheck`, `npm test`, and `npm run build`.
Use the Modal deployment in `backend/deploy/` for the server. Do not add a local backend requirement.
Set `WXT_BACKEND_URL` to the deployed HTTPS origin. Use `npm run dev` for WXT development.
Install dependencies in both package directories. Backend tests need local port access.

## Boundaries

- The extension may scan, scroll, highlight, speak, and observe. The user performs every website action.
- Text input remains pending until explicit user completion. A click on Submit is not proof of success.
- Keep provider keys server-side. Browser messages and WebSocket origins must be validated.
- Do not send raw HTML, editable text, or form values for planning or selection. Redact sensitive patterns before persistence.
- Validate every target against the live registry. Discard cancelled or outdated guidance.
- Muse describes the step. Jev selects the control with typed Choice and Noul questions. Code applies the thresholds. Do not add heuristic target fallbacks.
- Use only mocked provider calls for tests. Do not call paid APIs or deploy without a new user instruction.

## Code and tests

Use two-space indentation in TypeScript and JavaScript. Use small, explicit interfaces
and colocated `*.test.ts`/`*.test.tsx` tests. Backend tests use Node's test runner.
Update the relevant feature note when a contract changes. Use synthetic data only.
Use `rg` for file searches and `git diff --check` before delivery.
