---
"@kindgi/handler-runtime": patch
"@kindgi/cli": patch
"@kindgi/env-schema": patch
"@kindgi/pack-conformance": patch
---

**Only the names a pack declares reach its code.** Before the pack's code loads, the pack service (TypeScript, Python, Java and Scala) drops from its environment every variable the pack doesn't declare in `env.required` or `env.optional`. A model key or a password in a self-hosted `--env-file`, meant for something else, no longer reaches a tool or a process a tool starts.

- **What stays:** the declared names, `KINDGI_*`, and the platform's: the process's basics, the language runtime's settings, `PORT`, proxies and certificates, and Cloud Run's, AWS's and Azure's workload identity and metadata (`PLATFORM_ENV_NAMES`, `PLATFORM_ENV_PREFIXES`). Static credentials such as `AWS_SECRET_ACCESS_KEY` aren't the platform's: a pack that needs one declares it.
- **What it says:** one `warn` record at start, `env-dropped`, with the names it dropped, never their values. A Python image always names `GPG_KEY`, which its base image sets.
- **The opt-out:** `KINDGI_PACK_ENV_FILTER=off` keeps every variable, as before. `kindgi dev` sets it, since there the pack service gets the app's env files. Any value other than `on` or `off` is a `config-invalid` start.
- **Java and Scala:** a JVM can't drop a variable from its own environment, so the launcher (`kindgi-pack-java`) does, keeping the names in `KINDGI_PACK_ENV_DECLARED`, which `kindgi build` now sets in the image from the pack's index. The service won't start while a variable the pack doesn't declare still reaches it, or when `KINDGI_PACK_ENV_DECLARED` isn't the index's `env`.
- **The conformance suite** checks it for every pack service: an undeclared variable is absent in a tool, the declared ones and the platform's are there, and `off` keeps it.
