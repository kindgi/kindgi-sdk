---
"@kindgi/api": patch
---

**A new secret's name is held to a shared grammar at the API border, before anything is stored.** A new name is 1 to 255 ASCII letters, digits, `.`, `-` and `_`, and starts with a letter, digit or `_`. A name that breaks the rule is refused with `400 secret-name-invalid`, and the message says the rule.

- It applies wherever a secret is **created**: `POST /v1/secrets`, a new sensitive key on `PATCH /v1/tenant/config`, a deploy's inline `{ name, value }` secrets, and a webhook trigger's `generateSecret` name (`POST /v1/webhooks`). It gates both `create-new` and an `add-version` that creates — a name not yet stored — so no write slips the rule. A name already stored is left as it is: it still reads, rotates and takes new versions. So the border doesn't stop secrets written before this release.
- It is the floor every secret store shares, whichever one a deployment runs. A store may refuse more names of its own (`SecretBinding.nameRefusal`), with its own message and the same `secret-name-invalid` code.
- `secretNameGrammarRefusal(name)`, `SECRET_NAME_ALLOWED` and `SECRET_NAME_MAX_LENGTH` are exported for a custom route or store to apply the same floor.
