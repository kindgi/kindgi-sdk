---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**`GET /v1/conversations` lists the most recently active first, where it listed the most recently opened first: by `lastActivityAt desc, id desc`.** A conversation's last activity is when anything last happened in it: its opening, a message, a turn posted into it or ended, an approval on one of its turns opened, or decided, escalated, expired or withdrawn, or its close. Each conversation in the answers carries it as `lastActivityAt`.
- **A conversation something happens in while you page moves to the top:** that pass doesn't show it, and none shows twice.
- **A cursor from the other sort is refused** with `400 bad-input` and a message that says to start again without it: one handed out before the runtime sorted by last activity, or one from a runtime that does, given to one that doesn't.
- **An older runtime keeps sorting by opening** and answers no `lastActivityAt`.
- **`@kindgi/agents`:**
  - **`Conversation.lastActivityAt` and the `last_activity_at` column.** The column is nullable and isn't backfilled: a conversation nothing has happened in since the upgrade reads as its last message, else its opening.
  - **A binding that sorts by last activity says so** with its page's `order: 'last-activity'`, pages by `beforeActivity` / `nextByActivity` (`ConversationActivityCursor`), and ignores `before`.
  - **The rule is exported** as `lastActivityAt(conversation)`: `inactiveSince`, or later, by its approvals (`approvals.lastOpenedAt`, `lastDecidedAt`) and its close.
- **`@kindgi/client`, the Python client and the CLI:** `Conversation.lastActivityAt`, and `kindgi conversations list` says "most recently active first".
