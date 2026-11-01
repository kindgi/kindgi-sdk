---
"@kindgi/api": patch
---

**`GET /v1/projects/{projectId}/pinned-versions` reads its agents' versions once for the page, not once per agent.** It used to read where the page's agents run twice, then, for each agent that more than one project serves, that agent's versions and two authorization checks, one agent after another. It now reads where they run once and all their versions in one read, and its authorization checks are the page's two batches. Who sees which pin, and at which version, is unchanged.

**Breaking for custom item-projects bindings.** `ItemProjectsBinding` gains a required `versionProjectsOfItems`: `versionProjectsOfMany` for a page of one kind's items, in one query. It takes a `VersionProjectsOfItemsInput` (`tenantId`, `kind`, and per item id the versions asked about) and answers, per item id, each asked version's projects. A version missing from an item's map is no version of it. An item with none of the asked versions may be missing from the answer. A host that implements `ItemProjectsBinding` adds the method.
