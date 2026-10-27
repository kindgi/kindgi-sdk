---
"@kindgi/platform": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A renamed project keeps its old slugs: no other project of the tenant can take them, in any org.** `Project.formerSlugs` lists them, newest first, and is empty for a project never renamed; a runtime that keeps none leaves it out.
- **Creating a project, or changing one's slug,** to a slug another project had before it was renamed answers `409 slug-conflict` with `details.heldAs: 'old-slug'`. A slug another has now answers `details.heldAs: 'slug'`, as every `slug-conflict` does.
- **A project can take its old slug back,** unless another project also had it before a rename.
- **Deleting a project frees its slugs,** old and current.
- **`ProjectBinding`:** `create` and `update` answer `slug-conflict` with `heldAs: 'old-slug'`, and a binding that keeps old slugs fills `Project.formerSlugs`. The in-memory binding does, and the conformance suite checks it unconditionally.
- **Clients:** `formerSlugs` on a project in the TypeScript client, `former_slugs` in the Python client, and the same field in the Java client.
