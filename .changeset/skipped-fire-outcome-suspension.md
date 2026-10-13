---
"@kindgi/api": patch
"@kindgi/runtime": patch
---

**A fire's `skipped` outcome names a suspension too.** The descriptions of a schedule's and a webhook trigger's fires, and of `TriggerFire.outcome`, now say every reason a fire is `skipped`:
- The target's project is suspended (`project-suspended` in `detail`): no run or pass starts. A schedule's fires are recorded `skipped`, don't count toward its auto-pause and don't reset its count of fires in a row that were refused or failed, so the schedule stays on and fires again once the project is restored.
- Its run hadn't started when its tenant was suspended (`tenant-suspended`): the restore concludes it `skipped`, and its event is dropped.
- A tenant's suspension isn't caught up, whatever a schedule's `catchUp`: once the tenant is restored, a schedule that's on fires next at its first occurrence after the restore.

The suspend routes for a tenant and for a project say the same, and a webhook trigger's `detail` lists `project-suspended` and `tenant-suspended`.
