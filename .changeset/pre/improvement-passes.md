---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/schema": patch
"@kindgi/client": patch
---

Improvement passes. `POST /v1/proposals/improve` starts one: the runtime looks for better values for an agent version's tunable settings on a test set, within a budget (default $5 and 30 candidates). It writes its best candidate as an improvement proposal, which waits for a reviewer when requested.
- `GET /v1/improvement-passes` and `/{passId}` read passes back: their status, the candidates compared, the cost, and once one ends, its outcome (`proposed` with the proposal, or `nothing-found` with the hold-out numbers).
- `POST /v1/improvement-passes/{passId}/cancel` stops a pass.
- Without improvement passes in the runtime, these answer `501 improve-unsupported`.
- The TypeScript client has `proposals.improve` and `improvementPasses.{list,get,cancel}`. The Python client has `proposals.improve` and `improvement_passes`.

A settings block's schema marks the keys a pass may tune with `"x-kindgi-tunable": true`: a number or integer with a minimum below its maximum, or an enum. Any other mark is refused at publish, and `tunableKeys(schema)` lists the marked keys.

Comparisons can run unpublished settings values (`overrides.settings`, checked against the blocks the version pins) and part of the test set (`sample: { part, seed, holdOutShare }`, a deterministic search/hold-out split). A promotion gate fails a comparison with overrides (`sameContents`) and one on the search part (`comparison.sample`). A proposal's evaluate takes `sample`.

A replayed tool that reads from nowhere, re-run because the compared version pins other settings, is marked `recomputed: true` and doesn't count as divergence.

A proposal that a drafter wrote (not a person) waits for a reviewer when requested, even where the scope's policy asks for no approval.
