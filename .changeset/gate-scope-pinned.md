---
"@kindgi/api": patch
"@kindgi/compliance": patch
---

A gated scope always resolves to a pin: publishing a gate policy for a scope that nothing covering it pins is refused (`409 gate-policy-scope-unpinned`, "pin a version for this scope, or one above it, first"), and so is an unpin that would leave a gated scope on the latest version (`409 gate-policy-needs-pin`), where publishing would go live ungated. A gate policy's `spec.comparison.required` is gone: a promotion must name a comparison exactly when the spec has `comparison`, `evidence`, `metrics` or `replay`. A promotion its gate refused is the audit and evidence kind `agent-promotion-refused`.
