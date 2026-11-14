---
"@kindgi/handler-runtime": patch
"@kindgi/sdk": patch
---

A TypeScript pack's helper module under a discovery folder, a file whose name starts with `_` (`tools/_shared.ts`, `tools/echo/_format.ts`), is skipped when it defines no primitive, as in a Python pack. Such a file failed the index with `no-default-export` or `ambiguous-kind`. A `_` file that defines a primitive is indexed as before, and one that fails to import still fails. Both errors now say a helper module's name starts with `_`, and the `kindgi-authoring-tools` skill (0.5.7) says it too.
