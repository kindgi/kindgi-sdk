---
"@kindgi/cli": patch
---

**Five commands' help now says what the code does, and `kindgi adapters prepare --params` reads `@<file>`.**
- `kindgi adapters prepare --params` reads its JSON from a file with `@<file>`, as the usage line always said and as every other `<json-or-@file>` flag does. Malformed JSON is a usage error (exit `2`) and sends nothing.
- `kindgi dev --tenant`: with the bundled Postgres, the default tenant is the project's own, the same one for every pack and restart of the project. Otherwise it's the previous run's, from `.kindgirc.json`, else a new one.
- `kindgi build --signer-key-id`: the default is the env block's `signerKeyId`, else the key file's name. The `<env>-signer` fallback is gone: it was used only when there was no key, and with no key nothing is signed.
- `kindgi sso providers start`: `--kind` is optional. Without it, the kind comes from `--idp`, else from the registered provider. Before a provider is registered, one of the two is required.
- `kindgi schedules update`: the flag descriptions no longer give `create`'s defaults. A flag left out keeps the schedule's value.
