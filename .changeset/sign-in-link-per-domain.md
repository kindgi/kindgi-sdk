---
"@kindgi/api": patch
---

Sign-in options can leave the emailed link out for an email's domain: `createApp`'s `signInEmailLink.allowedFor(emailDomain)`. The runtime uses it where a workspace signs its people in with its own identity provider: on that workspace's domains, a sign-in page offers its identity provider (and the Google or Microsoft accounts the domain manages), not the emailed link.
