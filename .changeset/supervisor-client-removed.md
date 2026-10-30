---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**`client.supervisor` is gone.** Every method on it threw `not-yet-wired`: the API has no supervisor routes, and `client.supervisor.proposals` gave way to `client.proposals`. With it go `SupervisorClient`, `SupervisorProposalsClient` and their input types, `SupervisorSpec`, `Supervisor`, `DryRunCriterion`, and the proposal result types no method returned: `ProposalDryRunResult`, `ProposalDryRunScore`, `DryRunProposalResult`, `SubmitReviewProposalResult`, `ApplyProposalResult`, `RollbackProposalResult` and `ProposalReviewOutcome`. Observations stay on `client.observations`, and proposals on `client.proposals`. The error code `supervisor-header-missing`, which the API never sends, leaves the API's list of codes and the TypeScript, Python and Java clients.
