---
"@kindgi/api": patch
"@kindgi/client": patch
---

**An app entry says whether a registration names its directory, and what a disconnect withdraws at the app.** `GET /v1/connection-entries` answers two more optional fields for each app. `signIn.tenant` is there when the sign-in happens in a directory of the app's own (Microsoft's tenant): its `default` is the directory a registration that names none signs in at, and Microsoft's has none, so each registration names it in `oauth2.tenant`. `removal` says how a disconnect withdraws access at the app (`revoke`: `oauth2-revoke` or `github-installation-token`), whether that revoke withdraws everything the person granted the registration (`revokeIsGrantWide`, Google's does), and how the app reports a removal made there (`notices`: `google-risc` or `github-webhooks`); each is absent when the app has none, so Microsoft's `removal` is `{}`. `ConnectionEntry` in the OpenAPI document, and the TypeScript and Python clients, have both.
