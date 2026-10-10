---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

A proposal can be rescored. After people judge its comparison's new answers on the replay runs, `POST /v1/proposals/{proposalId}/rescore` rescores the proposal's latest evaluation, as `POST /v1/eval-runs/{runId}/rescore` does. The CLI is `kindgi proposals evaluate <proposal-id> --rescore [--wait]`, and the client is `proposals.rescore`.
- **What it does:** the new run scores the same replays again, with the same test set version and settings, and replays nothing. It becomes the proposal's evaluation, so the proposal is `evaluating`, then `evaluated` or `not-better` as the rescore says. The run rescored stays as it was.
- **Rules:** it needs `publish` on the agent, as evaluating does, and takes no body fields. It's allowed from `evaluated`, `not-better`, `refused`, `superseded` and `expired`. A latest evaluation that isn't a completed comparison is `409 eval-run-not-rescorable`. With `--rescore`, the CLI refuses the comparison flags.
