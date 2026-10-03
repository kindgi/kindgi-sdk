---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

A run blocked by a guardrail now says which one, and clients get it as a typed error.

- `@kindgi/agents`: the `guardrail-violation` message (and the `turn.failed` event's) names each blocking guardrail with its check's reason — `Turn blocked by guardrail 'no-pii': Response contains an email` — instead of only counting them.
- `@kindgi/client` (re-exported by `@kindgi/sdk`): new `GuardrailViolationError` variant of `KindgiError` (`code: 'guardrail-violation'`, `violations[]` with `guardrailId` / `severity` / `action` / `reason?`, `evaluationErrors[]`). `fromWire()` previously returned it as a generic `ServerError`. Exhaustive `switch (err.code)` statements need the new case.
- `@kindgi/api`: `POST /v1/runs` sends a binding failure's `details` as the wire error's `details`; they were nested under `details.details`, so clients could not read them.
