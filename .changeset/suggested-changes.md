---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
"@kindgi/types": patch
---

**Proposals are now suggested changes.** This is a breaking rename, and no old name is kept.

- **Routes.** `/v1/proposals` is `/v1/suggested-changes`, with `{suggestedChangeId}` in its paths; `evaluate`, `rescore` and `withdraw` keep their sub-paths. `.../request` is `.../pin`. `.../rollback` is removed: going back is putting the agent's earlier version back in use. Improve's `/v1/proposals/improve` and `/v1/proposals/improve/estimate` stay where they are for now.
- **Fields and values.**
  - `proposalId` is `suggestedChangeId` everywhere it names a suggested change: on a version's `derivedFrom`, on an Improve outcome, and in a refused gate's `details`.
  - A suggested change's status `promoted` is `pinned`.
  - The header `X-Proposal-Deduped` is `X-Suggested-Change-Deduped`.
- **Errors.** Codes starting `proposal-` start `suggested-change-`.
- **Schemas and types.** `Proposal*` and `FixProposal*` names are `SuggestedChange*`; the block edit a suggested change carries is `SuggestedChangeBlockEdit`, and `FixProposalId` is `SuggestedChangeId`.
- **TypeScript client.** `client.suggestedChanges` holds suggested changes, and its `request` is `pin`; `client.proposals` keeps only `improve` and `improveEstimate`. The supervisor client's `proposals`, deprecated since 0.1.5, is removed with its types.
- **CLI.** `kindgi suggested-changes` holds suggested changes, with the same verbs, and `draft --judgment` is `draft --correction`; `kindgi proposals` keeps only `improve` and Improve's passes. `kindgi exports create` writes them as `suggested-changes`.
