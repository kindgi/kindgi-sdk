---
"@kindgi/api": patch
"@kindgi/runtime": patch
---

**A fire's `skipped` outcome covers a tenant suspended or closing as its run starts.** A schedule's or webhook trigger's fire whose run starts as its tenant is suspended or starts closing is recorded `skipped`, with `tenant-suspended` or `tenant-closing` in its `detail`. Like a skip for a project's suspension, it doesn't count toward a schedule's auto-pause and doesn't reset its count of fires in a row that were refused or failed. The descriptions of a schedule's and a webhook trigger's fires, and of `TriggerFire.outcome`, now say so.
