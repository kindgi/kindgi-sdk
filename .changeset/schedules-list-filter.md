---
"@kindgi/api": patch
---

The schedules list (`GET /v1/schedules`) holds only the schedules whose project the caller may read, as reading one schedule already required. Before, any signed-in principal in the tenant saw every project's schedules, with their input.
