---
'@kindgi/api': patch
'@kindgi/cli': patch
'@kindgi/client': patch
---

Judgments can now carry a **correction** — what the agent should have done on the run: the tool calls it should have made (each with the argument fields that matter) and the tools it should not have called at all. A correction is graded deterministically when a candidate version is replayed on the run, so a comparison shows how a new version measures against the expert's fix — refused calls and the first failing repetition named, shown for a promotion gate, not enforced. One correction per run per expert, recorded against the whole output, so saving again replaces it.

Available on the API (`POST /v1/judgments`), the TypeScript and Python clients (`Correction`, `ExpectedCall`), and the CLI (`kindgi judgments add --correction`).
