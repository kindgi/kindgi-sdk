---
"@kindgi/api": patch
"@kindgi/client": patch
---

**The connections API for an app that connects through Kindgi's own app.** Everything is new and optional, and a server with no such app sends none of it:

- A connection entry's `signIn.kind` can be `kindgi-app`: the app connects through Kindgi's own app, by Kindgi's connect step, with no client to register.
- A registration (`ConnectionApp`) can carry `via: 'kindgi'`: the server made it itself for such an app, and it has no `oauth2` or `githubApp`. `POST /v1/connection-apps` doesn't register such an app (`connection-app-invalid`, `app`), and `PATCH` changes only its label and projects.
- When the business shared several accounts that fit the app and none was picked, the finish answers `kind: 'pick-account'`, and the request, still `pending`, lists them in `accounts` (`{ id, label }` each). The person picks one and starts the request again with `accountId`, which can't go with `installationId` or `newInstallation`.
- The finish takes what Kindgi's connect step sends back: `state`, with `error` when the connect didn't happen, and never a `code`.

The TypeScript client's types and the Python client's models gain the same fields.
