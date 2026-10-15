---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/client": patch
---

**A schedule's or webhook trigger's fire says whether it counted toward the trigger's auto-pause.** `TriggerFire.countsTowardPause`, and `countsTowardPause` on `GET /v1/schedules/{scheduleId}/fires` and `GET /v1/webhooks/{triggerId}/fires`, optional:
- **`false`** for a refusal for a limit, such as the tenant's runs pending (its `detail` starts `rate-limited:`): the limit passes, and the trigger isn't at fault.
- **Absent** from a runtime that doesn't say: `refused` and `failed` fires counted, and the others didn't, as before.
