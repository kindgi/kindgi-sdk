---
"@kindgi/api": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
---

**Sign-in options can link the deployment's own sign-up page.** `GET /v1/auth/sign-in-options` gains an optional `signUpUrl`, for a sign-in page to link as "No account yet? Sign up". It's an absolute https URL with no username or password, as a browser reads it, the same with or without an email. The answer has no `signUpUrl` when the operator set none; older servers leave it out too.
- `createApp`'s new `signUpUrl` sets it. It throws on anything but an absolute https URL with no username or password.
- `@kindgi/env-schema` adds `KINDGI_AUTH_SIGN_UP_URL`, for a runtime to read it from.
- The TypeScript and Python clients' sign-in options gain `signUpUrl`.
