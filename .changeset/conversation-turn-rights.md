---
"@kindgi/api": patch
---

**A conversation belongs to one project, and adding a turn to it takes its opener or `write` on its project.** A turn reads the conversation's history and appends to it.
- **`POST /v1/runs`** naming a `projectId` other than its `input.conversationId`'s answers `409 conversation-project-mismatch`, with `details.conversationId`, `details.projectId` (the one named) and `details.conversationProjectId`. Name the conversation's project, or omit `projectId`. A conversation from before projects isn't compared.
- A turn into a conversation with no participant takes having opened it (the caller `?openedBy=me` names), or `write` on its project (on its agent, for a conversation from before projects). Read isn't enough. Anyone else gets `403 permission-denied`, with `details.resource` the conversation. With a participant, the participant rule decides, as before.
- A turn into a conversation that doesn't exist answers `404 conversation-not-found` before any turn starts, with `options.wait: false` too. It used to answer `202`, and its run failed. A caller who can't read the conversation gets the same `404`, byte for byte, in place of the `409` or the `403`.
- **`POST /v1/conversations`** naming a `projectId` takes `write` on that project, as a run naming one does. Omitted, it opens in the agent's own project with `execute` alone, as before.
