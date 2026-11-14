---
"@kindgi/api": patch
---

The API reference says a tenant purge's `leftBecause` also names a secret its secret manager didn't erase, and that `purge-setting-missing` also covers secrets a secret manager may still hold (`KINDGI_SECRETS_MANAGER`). The answer's fields and the error's code don't change.
