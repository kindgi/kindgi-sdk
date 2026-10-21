---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/specs": patch
---

An agent's `conversationPolicy.autoCloseAfterInactiveSeconds` is refused. It was accepted and never acted on: a conversation never closes by itself, only when someone closes it. `defineAgent` (and an agent registered through `POST /v1/agents`, which answers `400 validation-failed`) now refuses any value at `/conversationPolicy/autoCloseAfterInactiveSeconds`, saying so: `autoCloseAfterInactiveSeconds isn't supported: a conversation never closes by itself. It closes when someone closes it: Close in the console, kindgi conversations close, or POST /v1/conversations/{id}/close. Leave it out.` The field leaves the `ConversationPolicy` type, `agent.schema.json` and the API's `ConversationPolicy` schema. `pack-index.schema.json` refuses it on an agent, so a Java, Scala or Python pack that sets it fails to build. An agent stored before it was refused keeps working: a pack already built still deploys, nothing reads the setting, and agent answers (`GET /v1/agents`, `/v1/agents/{id}`, `/versions`, `/versions/{version}`) leave it out of `conversationPolicy`.
