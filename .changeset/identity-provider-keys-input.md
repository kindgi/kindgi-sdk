---
"@kindgi/api": patch
---

**`createApp` takes `identityProviderKeys`:** the secrets a tenant's identity providers reference, as every guard and name check in the app reads them. Without it they're listed from `identityProvider`, as before, so an app without `identityProvider` guards none of them. A deployment that keeps its identity providers while it mounts no sign-in passes its own, so their secrets stay sign-in's only whether or not it mounts sign-in.
