---
"@kindgi/sdk": patch
---

The guardrails authoring skill (`kindgi-authoring-guardrails` 0.3.7) no longer offers the built-in checks: the runtime doesn't run them yet, so it says to ship your own check with `defineCheck`. A guardrail that names a built-in has no check to run, and a check that can't run never counts as passed: with `halt`, the turn is blocked with `guardrail-violation`; with any other action, the turn goes on and the error is recorded.
