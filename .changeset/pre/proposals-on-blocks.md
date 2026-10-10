---
"@kindgi/api": patch
"@kindgi/types": patch
"@kindgi/client": patch
---

Improvement proposals change data blocks. A proposal is new settings values or a new prompt template for one block an agent version pins, for one live scope:
- `POST /v1/proposals` drafts one. The content is checked as publishing that block version would be, and refused when it equals the pinned content. The same change from the same version for the same scope is one proposal.
- `POST /v1/proposals/{id}/evaluate` publishes the block version, derives the agent version (`derivedFrom.proposalId`) and compares it on a test set. Neither serves any scope until promoted. Without a live version of the agent for the whole tenant, it answers `409 proposal-needs-pin`. Under `kindgi dev`, where the agent registry takes no writes, it answers `409 registry-read-only`.
- `POST /v1/proposals/{id}/request` promotes the candidate for the scope through its gate, as `POST /v1/agents/{agentId}/promotions` does. It's allowed whether or not the candidate measured better: the gate decides.
- `POST /v1/proposals/{id}/rollback` puts the scope back.
- `POST /v1/proposals/{id}/withdraw` closes the proposal.
- `GET /v1/proposals` filters by agent, tier, status, and the live scope a proposal is for (`scopeKind`, `scopeId`, `segment`).
- `status` is derived from the comparison and the promotion: `draft`, `evaluating`, `evaluated`, `not-better`, `evaluation-failed`, `in-review`, `promoted`, `refused`, `rejected`, `expired`, `superseded`, `rolled-back` or `withdrawn`.
- Proposals are authorized on their agent: `read` to see one; `publish` to draft, evaluate or withdraw; `promote` to request or roll back. `X-Supervisor-Id` is no longer needed.

The instruction-string tiers (`prompt`, `retrieval`, `tool-config`) and the `dry-run`, `submit-review` and `apply` routes are gone.

The TypeScript client has `client.proposals` (`list`, `get`, `create`, `evaluate`, `request`, `rollback`, `withdraw`). Every `client.supervisor.proposals` method now throws `not-yet-wired`, naming its replacement, until 0.2. The Python client's `proposals` resource has the new calls. `draft`, `dry_run`, `submit_review` and `apply` raise `InvalidRequestError`, naming their replacement.

`SupervisorBinding` stores proposals (`listProposals`, `getProposal`, `createProposal`, and `recordProposal`, a compare-and-set on `revision`). The API package runs the lifecycle from the agent, block, eval-run and promotion bindings.
