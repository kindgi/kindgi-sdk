---
"@kindgi/connections": patch
---

**Microsoft (Outlook):** the `microsoft` entry at `@kindgi/connections/microsoft`, and three tools at `@kindgi/connections/microsoft/tools`, each included under the id its pack names: `outlookSend` (plain-text mail as the person, each send in a run no person started waiting for their yes), `outlookMessagesList` (newest first, or a search, in one folder) and `outlookMessageGet` (one message, its body as plain text).
- An `oauth2` sign-in can name the app's own directory in its URLs (`{tenant}`, once in the authorize and token URLs and at most once in the revoke URL, filled from the registration's `oauth2.tenant`, else `signIn.tenant.default`; Microsoft's entry has no default, so each registration names it), ask for `signIn.scopes` at every sign-in (Microsoft's `offline_access`), and say which resource its granted scopes may be named with (`signIn.scopeResource`, ending in `/`), so they're compared without it, in any case.
- A new account lookup, `profile`: a GET with the new access token, its id and label read from named fields (Microsoft Graph's `/me`).
- A rate limit's cost may be 0: that call isn't counted in that limit (Exchange's limit on sends, which reads don't use).
