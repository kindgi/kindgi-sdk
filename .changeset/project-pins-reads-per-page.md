---
"@kindgi/api": patch
---

**`GET /v1/projects/{projectId}/pinned-versions` asks where a page's agents and their versions run once for the page, not once per agent.** For each agent on the page that more than one project serves, the route used to read that agent's versions and make two authorization checks, one agent after another. It makes one version read for the whole page, and its authorization checks are the page's two batches. Who sees which pin, and at which version, is unchanged.

**Breaking for custom item-projects bindings.** `ItemProjectsBinding` gains a required `versionProjectsOfItems`: `versionProjectsOfMany` for a page of one kind's items, in one query. It takes a `VersionProjectsOfItemsInput` (`tenantId`, `kind`, and per item id the versions asked about) and answers, per item id, each asked version's projects. A version missing from an item's map is no version of it. A host that implements `ItemProjectsBinding` adds the method.
