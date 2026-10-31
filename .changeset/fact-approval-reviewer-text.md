---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/memory": patch
"@kindgi/agents": patch
---

A reviewer can approve a fact an agent wants to remember with their own text. `POST /v1/approvals/{approvalId}/complete` takes `factText`, only with `decision: approve` on an approval whose `subjectKind` is `fact`: the approved fact holds that text in place of the agent's, and the approval keeps the agent's as its `description`. Any other decision or approval refuses it (400 `bad-input`). It's checked as the agent's own text is: not empty or only spaces, and at most 2,000 characters (`MAX_REMEMBERED_TEXT`, `rememberedTextProblem` in `@kindgi/memory`). The decision it answers and the approval read back carry it as `decision.factText`. In the TypeScript client, `approvals.decide` takes `factText`. The `remember` tool no longer stores a text of only spaces: it answers "Not remembered". A remembered fact's approval is `fact` on the API, where it read `memory-fact`.
