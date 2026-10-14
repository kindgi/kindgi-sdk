---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

The default artifact upload cap reads 100 MiB, what it has always been (`100 * 1024 * 1024` bytes), instead of 100 MB: in `POST /v1/artifacts`'s description, `kindgi artifacts upload --help`, `@kindgi/api`'s README and TSDoc, and `@kindgi/client`'s `artifacts.upload` TSDoc.
