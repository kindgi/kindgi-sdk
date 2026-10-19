---
"@kindgi/api": patch
---

**`POST /v1/runs` refuses a run naming a closed conversation (`input.conversationId`, for an agent or a flow) before a run is made.** It answers `409 conversation-closed`, `Conversation "<id>" is closed`, with `details.conversationId`. With `options.wait: false` too: that used to answer `202`, and its run then failed at turn setup. Waiting, the answer was already that `409`, but a failed run was made for it, with `details.runId`. Now no run is made. Who may add the turn is checked first, as before: a caller who can't read the conversation still gets `404 conversation-not-found`, a viewer the `403`, and for a conversation with a participant, the participant rule's `403`.
