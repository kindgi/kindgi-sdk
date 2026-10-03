---
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/env-schema": minor
---

Public run tokens: a browser can follow a run's progress without a secret API token.

- `@kindgi/api`:
  - `CreateAppInput.publicRunTokens` (`signingKey` + `keyId`, an Ed25519 key; lifetimes; `allowedOrigins`). When set, `POST /v1/runs` returns `publicAccessToken` + `publicAccessTokenExpiresAt` (15 minutes by default), and `POST /v1/tokens/public` mints tokens for up to 50 runs (at most 24 hours).
  - Progress routes: `GET /v1/runs/{runId}/progress` (`RunProgress`: status and timing, no input, output or failure message) and `GET /v1/runs/{runId}/progress/stream` (`RunProgressEvent`: kind, node, sequence, time; no payload). They accept an API token or a public run token. `GET /v1/runs/{runId}` and `/stream` are unchanged and keep requiring an API token.
  - A public run token (`kgi_pt_…`, Ed25519-signed, stateless) is accepted only by the two progress routes (every other route answers 403), for the runs it names and their descendants (others answer 404).
  - The routes a public token may use come from the operation registry (`security: 'bearer-or-public-run'`); the OpenAPI document declares the `publicRunToken` security scheme on them.
  - CORS for `allowedOrigins` on the two progress routes only, ahead of authentication.
  - `mintPublicRunToken` / `verifyPublicRunToken` for deployments that issue tokens themselves.
- `@kindgi/client`:
  - `subscribeToRun({ apiUrl, runId, accessToken, refreshAccessToken })`: follow a run's progress from a browser with a public token, refreshing it when it expires.
  - `runs.progress`, `runs.streamProgress`, `tokens.createPublic`.
  - `runs.stream` now follows the run to its terminal event: when the server ends the stream at its time limit, it reconnects from the last event instead of ending early. `followRun` is the shared loop; `readSse` takes `lastEventId` and per-attempt `headers`, and throws `SseHttpError` (with `status`) on HTTP errors.
- `@kindgi/env-schema`: `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` and `KINDGI_CORS_ORIGINS`.
