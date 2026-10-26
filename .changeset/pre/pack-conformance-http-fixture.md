---
"@kindgi/pack-conformance": patch
---

The conformance fixture pack gains a declarative HTTP tool, `conformance.http`, in all four languages. The suite now checks that every SDK indexes the same HTTP spec for it — the guarantee `pack-index` can't make, since it types a tool's `spec` as an open object.
