---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/specs": patch
---

**An agent's `conversationPolicy.autoCloseAfterInactiveSeconds` now closes its conversations.** One that nothing has been said in for that long, since its last message or since it opened when it has none, is closed as `POST /v1/conversations/{id}/close` closes it: its runs' pending waits are cancelled with it, approvals waiting on a person included.
- **A turn into one closes it, and is refused** as a turn into a closed conversation is: `POST /v1/runs` answers `409 conversation-closed` before a run is made, and a turn's own setup, as it starts or resumes, fails with `conversation-closed`. One a message reached since it was read stays open, and the turn goes on.
- **The Kindgi runtime closes the rest as it sweeps**, about once a minute, in bounded batches.
- **After the upgrade, its first sweeps close every conversation already past its agent's window**, a batch at a time, and cancel those conversations' pending waits. Nothing is backfilled: their messages and runs stay as they were. A conversation keeps the policy of the agent version it opened with, so a new agent version doesn't change when its older conversations close.
- **Every close is recorded, with who closed it**, as the audit event `conversation-closed`, now an evidence kind in `@kindgi/compliance`. Its actor is the caller of the close route (`user:<id>`, `service_account:<id>`, and the other actor forms audit records use), or `system:conversation-auto-close` for a close by the policy, which also records since when the conversation was inactive and the window.
- **`ConversationBinding.closeConversation` takes a fourth argument, `close`:** who closes it (`actor`), and for a close by the policy, `afterInactiveSeconds`, which the binding checks again as it closes, so that a message that just reached the conversation keeps it open. Without it, a binding that records the close names its actor `unknown`. A conversation closed already is answered as it is, and closed once.
- **`@kindgi/agents` exports the rule each of these applies:** `autoCloseDue(conversation, policy, now)`, `inactiveSince(conversation)`, and `AUTO_CLOSE_ACTOR`.
