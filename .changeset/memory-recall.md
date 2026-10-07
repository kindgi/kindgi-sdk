---
"@kindgi/memory": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/specs": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/testing": patch
---

Agents recall earlier conversations, and a conversation can be unregistered.

- **Recall.** A retrieval intent with `source: 'conversations'` recalls messages of this agent's earlier conversations (a user's message or an agent's answer; tool calls are not indexed). It has no `types`, and its scopes are:
  - `same-user` (the usual choice): this end user's, or this user's, other conversations;
  - `same-conversation`: this conversation's messages older than the history window (`conversationPolicy.historyLimit`);
  - `same-segment`: conversations in the run's segment path (the same customer);
  - `same-project`: the project's conversations.

  `mode` works as for facts: absent (newest first), `keyword`, `semantic` (needs embeddings, else `semantic-unavailable`) or `both` (fused by rank).
- **Other people's conversations.** `same-segment` and `same-project` recall them, in the run's own project only. Publishing such an agent warns `recall-other-people`, and in the prompt each of their messages is marked `anotherPerson`, without saying whose. Recall is always this agent's conversations, within what the run may recall (`isRecallReadableBy` in `@kindgi/memory`: a conversation is always someone's).
- **The prompt.** Recalled messages are quoted in the `<memory>` block after the facts: the date, the message, and the messages either side. They are earlier conversation, never turns. The system message's memory line now names quotes from earlier conversations. **This changes what models see.**
- **The turn.** `AgentTurnResult.recalled` (optional) and the journal keep what was recalled, with each message's ranks. A replay can reuse the past run's (`ReplayBinding.recalled`). The run's provenance has a `retrieval` node per recalled message (`source: conversations`), `retrieved-from` its intent's `search_memory` node.
- **The binding contract** (protocol 16, additive):
  - `MemoryQueryBinding.searchConversations?` (`SearchConversationsInput`, `RecallHit`, `RecalledMessage`). Without it, such an intent recalls nothing, and the journal says so (`degraded: no-recall`). Publishing warns `recall-unavailable` (`MemoryBinding.conversationRecall`).
  - `AppendMessageInput.recall` (the turn's user and segments, for the index).
  - `ReadMessagesInput.beforeSequence`/`last`: a turn now reads only its history window.
- **Unregister.** `POST /v1/conversations/{id}/unregister` tombstones a conversation (`Conversation.unregisteredAt`). From then on no read, list or recall returns it, and it takes no more turns. The retention sweep removes it after the tenant's grace. `ConversationBinding.unregisterConversation?` (501 `conversation-unregister-unsupported` without it). The TS client has `conversations.unregister`, and so do the Python client and `kindgi conversations unregister`. `deleteConversation` is deprecated: it left a conversation's messages behind. It is optional now, and the next release drops it.
- **Specs.** The agent spec (schema-version 1.6.0) has `source` and `same-segment`: an intent over facts needs `types`, one over conversations has none.
