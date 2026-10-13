---
"@kindgi/api": patch
---

- Fixed: an artifact upload with an API key limited to a project works, and the artifact stays in the key's project. An upload naming no project lands there, and one naming another project, or an owner run in one, is refused with `403 key-project-mismatch`.
- An artifact upload is read once, under its size limit, so the server holds it in memory fewer times while it's stored.
