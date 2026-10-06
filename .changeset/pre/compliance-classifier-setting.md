---
"@kindgi/env-schema": patch
"@kindgi/audit-events": patch
"@kindgi/audit-events-inmemory": patch
---

**`KINDGI_COMPLIANCE_CLASSIFIER` turns on the audit trail's compliance features**, off by default. Set it to `shipped` (the classifier the runtime ships) or to the absolute path of your own classifier JSON. When set, the runtime serves `/v1/compliance/*` and **purges audit events by kind, as the classifier says**.

With `shipped`:

| Audit events | Purged after |
|---|---|
| Authorization decisions | 90 days |
| Authorization denials | 365 days |
| Run outcomes and guardrail violations | 730 days |
| Secret changes and approval decisions | never (legal hold) |
| Kinds the classifier doesn't list | never |

Unset: no `/v1/compliance/*`, and no audit event is ever purged.

`AuditEventPurgeInput` gains optional `outcome` / `exceptOutcome`, so a kind's denials can be kept longer than the rest (a classifier's `onDenyDays`). The in-memory binding honors both.
