---
"@kindgi/pack-conformance": patch
---

The fixture pack has a guardrail that names a built-in check, `conformance.no-guarantees`, in every language. The suite checks that its index entry is the same in each (`checkBuiltIn: true`, its `at` and config, no `configSchema`), that the service lists no check for it, and that a `check-invoke` naming it answers `check-not-in-pack`.
