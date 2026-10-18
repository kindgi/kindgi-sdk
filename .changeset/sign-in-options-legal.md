---
"@kindgi/api": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
---

**Sign-in options can link the deployment's terms and privacy policy.** `GET /v1/auth/sign-in-options` gains an optional `legal: { termsUrl?, privacyUrl? }` for a sign-in page to link. It has only the ones the operator set, each an absolute https URL, and the answer has no `legal` at all when neither is set. Older servers leave it out too.
- `createApp`'s new `signInLegal` sets them. It throws on anything but an absolute https URL.
- `@kindgi/env-schema` adds `KINDGI_AUTH_TERMS_URL` and `KINDGI_AUTH_PRIVACY_URL`, for a runtime to read them from.
- The TypeScript and Python clients' sign-in options gain `legal`.
