---
"@kindgi/api": patch
---

**A conversation you can't read answers `404 conversation-not-found` wherever a route refuses you, as if it didn't exist.** It's the answer for a conversation that doesn't exist, byte for byte apart from `requestId`, and the refusal is still recorded. A caller who can read the conversation keeps the `403`.
- **`GET /v1/conversations/{conversationId}`** and **`GET /v1/conversations/{conversationId}/messages`**, without `read` on the conversation's project (on its agent, for one from before projects), answer `404` where they answered `403 permission-denied`. That includes a key limited to another project.
- **`POST /v1/conversations/{conversationId}/close`** and **`POST /v1/conversations/{conversationId}/unregister`**, refused, answer `404` to a caller who can't read the conversation. Closing one still doesn't take reading it: `execute` on its agent (or, for an agent more than one project serves, `call` on the conversation's project) closes it. The spec now lists the `403` both answer.
- **`POST /v1/runs`** into a conversation with a participant, refused by the participant rule, answers `404` in place of `403 participant-not-allowed` to a caller who can't read the conversation. A participant the body names, for a conversation with none, keeps its `403`: the caller was already let into the conversation.
- A conversation that doesn't exist is answered in the API's own words on every conversation route (`No conversation with id "<id>"`, with `details.conversationId`), whatever the store's message, so the two answers match.
- **Clients:** a caller who caught the forbidden error on these calls gets the not-found error instead.
