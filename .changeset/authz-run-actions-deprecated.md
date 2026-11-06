---
"@kindgi/authz": patch
---

The `run` object type and its actions (`read`, `cancel` and `delete` in `OBJECT_ACTIONS.run`) are deprecated, with `runObject` and the `run` entity of `tuplesForCreate` and `tuplesForDelete`. Nothing writes a run's tuple, so FGA denies a check of one of them on `run:<id>` for everyone. A run is checked on its project instead: reading one takes `read` there, and cancelling or resuming one takes `write`. They are removed in the next minor release.
