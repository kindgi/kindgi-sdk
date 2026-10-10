---
"@kindgi/client": patch
"@kindgi/cli": patch
---

The message for IT that `kindgi sso providers start` prints is now `@kindgi/client/sso-handoff`. It's a new entry with no dependencies, so a browser app (the console) can show the same text. `identityProviderHandoff(urls, preset?)` returns the message, the identity provider's steps and the guide's URL. `IDENTITY_PROVIDER_PRESETS` lists Google Workspace, Microsoft Entra ID, Okta and Keycloak, with the steps in each one's console. The CLI's output doesn't change: snapshot tests of `start` for each provider check it byte for byte.
