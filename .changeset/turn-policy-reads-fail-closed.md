---
"@kindgi/agents": patch
---

**A tenant's `model-routing` or `tool-errors` policy that can't be evaluated fails the turn with `tenant-policy-unavailable` (503), as its `hitl` policy already did.** The error names the policy's kind in `details.policyKind`, and its message says why. Before, the same failure ended the turn as `model-invocation-failed` (422), a client error; the turn still failed.
- A refusal from a budget kept per tenant still fails the turn as `rate-limit-exceeded`.
