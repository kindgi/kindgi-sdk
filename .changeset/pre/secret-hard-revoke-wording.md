---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**A hard revoke is described as what it does.** `DELETE /v1/secrets/{name}?hard=true` and `kindgi secrets revoke --hard` were called "cryptographic erasure". They erase the value at Kindgi and hard-delete it in a secret manager, and can't be undone, but backups and a secret manager's own retention may keep copies for a time.
- The API description of `secrets.revoke`, its `hard` parameter and the `secrets` tag say so, in the spec and in the Python client's docstrings.
- `kindgi secrets revoke --hard`'s help no longer says it skips the audit tombstone: a hard revoke keeps one.
- The docs say what each store keeps after a hard revoke (*Keep secrets in your own secret manager*, "Revoking for good").
