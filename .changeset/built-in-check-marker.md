---
"@kindgi/handler-runtime": patch
"@kindgi/guardrails": patch
"@kindgi/specs": patch
"@kindgi/api": patch
---

**A guardrail that only names a built-in check is marked.** The CLI's indexer sets `checkBuiltIn: true` on a pack index guardrail whose check is a built-in's (`must-cite`, …), and a deployment keeps it on the guardrail (`Guardrail.checkBuiltIn`, in both specs). From runtime 0.1.6, a guardrail that names a built-in, comes with its pack's code, and lacks the mark gets one warning in the runtime's log each time the runtime loads it. Such a pack was built with a CLI from before 0.1.5, and may ship its own check under the built-in's id, which the built-in replaces. Nothing is refused, and the built-in still runs. Rebuilding with a current CLI silences the warning. An older runtime ignores the mark.

`POST /v1/guardrails`' `guardrail-config-invalid` now says it covers the config of any check the guardrail names, a pack check's or a built-in's.
