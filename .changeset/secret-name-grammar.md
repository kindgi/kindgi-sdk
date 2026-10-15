---
"@kindgi/api": patch
---

**A new secret's name is held to a shared grammar at the API border, before anything is stored.** A name is 1–255 characters of ASCII letters, digits, `.`, `-` and `_`. A fresh create whose name uses any other character, or runs longer, is refused with `400 secret-name-invalid`, and the message says the rule.

- It gates fresh creates only: `POST /v1/secrets` with `writeMode: 'create-new'`, a webhook trigger's `generateSecret` name (`POST /v1/webhooks`), and a new sensitive key on `PATCH /v1/tenant/config`. A name already stored outside the grammar still reads, rotates and takes new versions (`add-version`), so secrets written before this release keep working.
- It is the floor every secret store shares, whichever one a deployment runs. A store may refuse more names of its own (`SecretBinding.nameRefusal`), with its own message and the same `secret-name-invalid` code.
- `secretNameGrammarRefusal(name)`, `SECRET_NAME_ALLOWED` and `SECRET_NAME_MAX_LENGTH` are exported for a custom route or store to apply the same rule.
