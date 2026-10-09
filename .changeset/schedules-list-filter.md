---
"@kindgi/api": patch
---

The schedules list (`GET /v1/schedules`) holds only the schedules in projects the caller may read, as reading one schedule needs; a tenant admin sees all. A page can hold fewer rows than `limit` and still have more: keep paging with the cursor.
