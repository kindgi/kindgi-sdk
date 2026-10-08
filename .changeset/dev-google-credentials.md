---
"@kindgi/cli": patch
---

**`kindgi dev` gives the runtime Google credentials only when `KINDGI_DEV_GOOGLE_CREDENTIALS` names them.** Set it in the pack's `.env` or the shell:
- `adc` is your gcloud application-default login;
- an absolute path is that credentials file;
- `off`, or leaving it unset, gives none.

When it mounts a file, `kindgi dev` names the file and whose it is: the service account, "your gcloud application-default login (a user account)", or the impersonated account. It reads that from the file and never reads a token. When a Vertex AI provider (the `gemini` preset) has no credentials, `kindgi dev` says so before the start for a provider the config declares, and after boot for one registered by hand. `kindgi doctor`'s provider check says the same.

**Behaviour change:** `kindgi dev` used to mount this machine's application-default login, or the file a shell's `GOOGLE_APPLICATION_CREDENTIALS` named, into every runtime it started, for every project. It no longer does. A project that uses Vertex AI in `kindgi dev` adds `KINDGI_DEV_GOOGLE_CREDENTIALS=adc` to its `.env` once.
