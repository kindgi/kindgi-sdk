---
"@kindgi/api": patch
"@kindgi/cli": patch
---

The default artifact upload cap reads 100 MiB, what it has always been (`100 * 1024 * 1024` bytes), instead of 100 MB: in `POST /v1/artifacts`'s description, `kindgi artifacts upload --help`, and `@kindgi/api`'s README and TSDoc.
