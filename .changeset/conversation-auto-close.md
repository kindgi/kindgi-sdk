---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/specs": patch
---

**An agent's `conversationPolicy.autoCloseAfterInactiveSeconds` now closes its conversations, once nothing has happened in one for that long: no message, no turn in progress or waiting.** Its inactivity runs from the latest of its last message, the last turn posted into it, the end of its last run, and its opening. A run in it that's queued, running or waiting (on an approval, the session gate, or anything else) holds it open however long it takes, so a close by the policy never cancels a wait, and a turn that resumes past the window goes on.
- **A turn posted into one past its window closes it, and is refused** as a turn into a closed conversation is: `POST /v1/runs` answers `409 conversation-closed` before a run is made. With a run in it still in flight, or a message, a turn or a run's end since, it isn't idle, and the turn goes through.
- **The Kindgi runtime closes the rest as it sweeps**, about once a minute, in bounded batches.
- **After the upgrade, its first sweeps close every conversation already past its agent's window** with nothing in flight in it, a batch at a time. Nothing is backfilled: their messages and runs stay as they were. A conversation keeps the policy of the agent version it opened with, so a new agent version doesn't change when its older conversations close.
- **Every close is recorded, with who closed it**, as the audit event `conversation-closed`, now an evidence kind in `@kindgi/compliance`. Its actor is the caller of the close route (such as `user:<id>` or `service_account:<id>`, the actor forms audit records use), or `system:conversation-auto-close` for a close by the policy, which also records since when the conversation was inactive and the window.
- **`ConversationBinding.closeConversation` takes a fourth argument, `close`:** who closes it (`actor`), and for a close by the policy, `afterInactiveSeconds`: the binding closes it only if it's idle by that window, its runs included, checked as it closes, and answers one that isn't as it is, open. Without `close`, a binding that records the close names its actor `unknown`. A conversation closed already is answered as it is, and closed once.
- **`@kindgi/agents` exports the rule:** `autoCloseDue(conversation, policy, now)`, `inactiveSince(conversation)`, with the conversation's runs (`inFlight`, `lastPostedAt`, `lastEndedAt`) when they're known, and `AUTO_CLOSE_ACTOR`.
