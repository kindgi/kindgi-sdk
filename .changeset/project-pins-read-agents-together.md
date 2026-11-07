---
"@kindgi/api": patch
---

**`GET /v1/projects/{projectId}/pinned-versions` asks where its agents run once for the page, and reads the versions of those more than one project serves together.** It asked the item-projects binding where the page's agents run twice: once to check each pin's agent, then again to find the agents more than one project serves. Then it read those agents' versions one agent after another. A request now asks the binding for an item's projects once, whether alone or in a page, and the version reads run together, so a page waits only as long as the slowest one. Who sees which pin, at which version, and the page's order are unchanged.
