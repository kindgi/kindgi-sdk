---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

A suspended run says what it's waiting for: `GET /v1/runs/{runId}` has `waitingFor` (`approvals`, `other`). An approval shows its identity and state (`approvalId`, `status`, `requiredRole`, `title`, `createdAt`, `expiresAt`, `subjectKind`) and, for a tool call held for review, `tool: { id, version, callId }`; never the call's arguments or the approval's description, context or decision, which stay on the approval. `other` names child runs, decided approvals and waits no approval is linked to. It's optional (absent from an older runtime, and on the list). `kindgi runs resume` uses it when present, names the held call, and otherwise works the answer out as before.
