---
"@kindgi/agents": patch
---

**An agent turn hands its tools the workspace's time zone.** A turn that offers tools reads the workspace's `time-zone` fact once, in `setup`, and every call it makes gets the zone as `ToolContext.timeZone`. The fact's content is `{ timeZone: 'America/Toronto' }`, scoped to the workspace alone, and the newest one a person or a service wrote counts; an agent's own fact doesn't. The zone is `UTC` when there's none, when the read fails, and when the name isn't one `Intl` knows; the turn goes on either way, except that a tenant budget's refusal is the turn's, as it is elsewhere. `setup` journals the zone, so a turn resumed after an approval keeps it, and a turn that offers no tool doesn't read it.
