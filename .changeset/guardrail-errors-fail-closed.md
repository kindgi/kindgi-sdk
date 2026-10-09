---
"@kindgi/agents": patch
---

A halting guardrail whose check can't run now stops the turn; it used to let it through. A guardrail whose check isn't registered, or can't run for another reason (including when no check registry is bound at all), no longer passes silently. With `halt`, the turn fails with `guardrail-violation`: `violations` is empty, and `evaluationErrors` names the guardrail, the error code and why. With any other action, the turn goes on. In both cases every such error emits a `guardrail.error` turn event, adds the guardrail's provenance node (`evaluated: false`), and is listed under `errors` in the `evaluate-guardrails` step's output. `categorizeOutcomes` takes the guardrails the outcomes came from, so each error carries its guardrail's action and severity (`blockingErrors` holds the `halt` ones), and `describeBlockingViolations` names guardrails that couldn't run.
