---
"@kindgi/cli": patch
---

**`kindgi exports create` exports destinations and where results went.** A tenant admin's export holds each destination (`destinations.jsonl`) and its deliveries (`destination-deliveries.jsonl`). Every export holds each schedule's deliveries (`schedule-deliveries.jsonl`). Someone who isn't a tenant admin skips destinations and their deliveries. A destination's `url` isn't exported, since no route returns it. A runtime before Kindgi 0.7.0 doesn't serve these routes, and the manifest marks them skipped.
