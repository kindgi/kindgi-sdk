---
"@kindgi/api": patch
"@kindgi/specs": patch
"@kindgi/client": patch
---
An agent's approval rules are in the published contract. The wire's `ConversationPolicy` and the agent spec's (agent 1.8.0) declare `hitl`, with its parts as their own schemas: `ConversationHitlPolicy`, `ToolHitlPolicy`, `ToolHitlMode`, `ToolHitlRule` and `SeparateApproverPolicy`. `POST /v1/agents` took `conversationPolicy.hitl` and `GET` answered it back, but the OpenAPI document declared neither, so the typed clients couldn't send it or read it, and the agent spec refused it.
