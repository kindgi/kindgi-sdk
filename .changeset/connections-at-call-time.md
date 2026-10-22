---
"@kindgi/agents": patch
"@kindgi/tools": patch
"@kindgi/api": patch
---

**An agent's tool call gets the connections its tool declares, before it runs.** `InvokeAgentBindings.connections` is where it gets them: a runtime's `ConnectionResolver` and the env it serves.
- **Found once per call, and recorded without a token.** A person's connection that's missing, lacks a permission or needs reconnecting makes a connect request when a person started the run, and the call waits for them to connect (`waitingFor.connections`). In any other run it can't wait, and the call fails.
- **Asked fresh every time the tool runs,** never recorded: the tool reads its tokens in `ctx.connections`. When the app refuses one (`ConnectionRejectedError`, or a pack tool's `connection-rejected`), its token is renewed and the call runs once more.
- **A call its connections stop runs nothing.** It fails with `tool.failed` and a code: `connection-app-missing`, `connection-needs-a-person`, `connection-missing`, `connection-declined`, `connection-timed-out` or `connection-renew-failed`. The model reads why as the call's result, `{ status: 'failed', error: { code, message } }`, and the turn goes on.
- **A call that acts with a person's connection is theirs to approve.** When it asks for an approval, the approval names that person as its only `approver`, with the account it acts as (`connection`). The binding refuses one whose approver has no reviewer seat at the rank it needs, by throwing `approver-not-a-reviewer`, and the call fails with `connection-approver-not-a-reviewer`. Four eyes (`separateApprover`) on such a call can't be met, so it fails with `connection-approval-conflict` before anyone is asked to connect.
- **The approvals routes:** an approval addressed to one member is theirs alone to decide (`POST /v1/approvals/{id}/complete` answers `404 approval-not-found` to anyone else, the tenant's admin included), and among the reviewers only they see it in the list, `GET /v1/approvals/{id}` and its audit bundle. A person who is the tenant's admin still reads it.
- **Without `connections`,** a call to a tool that declares one fails with `connection-app-missing`; no other call changes.
