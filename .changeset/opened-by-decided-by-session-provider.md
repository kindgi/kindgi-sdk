---
'@kindgi/agents': patch
'@kindgi/api': patch
'@kindgi/client': patch
'@kindgi/cli': patch
---

**Who opened a conversation, the approvals you decided, and the session a decision was made in.**

- **`openedBy` on a conversation:** the caller who opened it (`user:<id>` or `service_account:<id>`), set by the server and never from the body.
  - `GET /v1/conversations?openedBy=me` lists only the caller's own (`conversations.list({ openedBy: 'me' })`, `kindgi conversations list --opened-by=me`).
  - The conversations table gains a nullable `opened_by` column and an index (migration `0006`). Nothing is backfilled, so earlier conversations record no opener and aren't listed by it.
  - A binding that ignores `ListConversationsPageInput.openedBy` lists more, and the route keeps only the caller's.
- **`?decidedBy=me` on approvals:** only the approvals the caller's own reviewer row decided (`approvals.list({ decidedBy: 'me' })`, `kindgi approvals list --decided-by=me`). `ListApprovalsBindingInput` gains `decidedBy`; a binding that ignores it lists more, and the route keeps only those.
- **Every page of a filtered list says so,** an empty one too: `openedBy: "me"` and `decidedBy: "me"` (`ConversationPage.openedBy` and `ApprovalPage.decidedBy` in the TypeScript client, `opened_by` and `decided_by` on the Python pages). A runtime from before these filters ignores them and lists them all, with neither on its pages, so `kindgi conversations list --opened-by=me` and `kindgi approvals list --decided-by=me` stop there, naming the release the runtime needs.
- **A decision's session:**
  - **`sessionProvider`:** an approval's `decision` gains it. It's the provider of the session the reviewer decided with: `site:<id>` for a site's sign-in, or an identity provider's id. An API key has none. `SubmitReviewBindingInput` gains it, and the complete route passes it.
  - **`deciderName`:** the decision also gains the reviewer's name when they decided.
  - Both are optional: a decision an older runtime recorded has neither.
