---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/cli": patch
---

A removed schedule, webhook trigger or mail trigger can be read. `GET …/{triggerId}/versions/{version}` answers a removed trigger's version, with `unregisteredAt` saying when the trigger was removed, so a run's `trigger.version` resolves whatever became of its trigger. Before, it was `404 trigger-not-found`. The trigger itself, its versions and its fires read with `?includeUnregistered=true`, and so do the lists; `?status=` matches the status a removed trigger had. Changing a removed trigger is still `404`. `TriggerRegistryBinding`'s reads take an optional `includeUnregistered`, and its records and versions carry an optional `unregisteredAt`: a registry that ignores the input answers as before. The in-memory registry (`@kindgi/api/testing`) keeps a removed trigger and answers it when asked. `kindgi exports create` asks for removed triggers too, with their versions and fires, so a run's `trigger.version` resolves inside the export as well.
