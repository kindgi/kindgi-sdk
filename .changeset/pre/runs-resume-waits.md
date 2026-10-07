---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

`kindgi runs resume <run-id>` says what a run waits for before it resumes, with an exit code per answer:
- **0:** the run isn't waiting (running, or finished).
- **3:** it waits for an approval. The command names the approval and the command that decides it (`kindgi approvals complete <id> --decision=approve` or `--decision=reject`).
- **4:** it waits on the runtime: a queued start, a child run, a scheduled retry and when, or a lease another run holds. A wait no approval matches is also 4, with a line pointing to `kindgi approvals list --status=pending`.
- **5:** reserved for a held run.

It reads the run, its journal's open waits, and the approvals linked to them. The never-wired `--waitpoint` and `--value` flags are gone.

`GET /v1/approvals` takes `waitTokenId`, repeatable and at most 50: only approvals linked to those run waits. `ListApprovalsBindingInput.waitTokenIds` carries it to the binding. The TypeScript client's `approvals.list({ waitTokenIds })` and the Python client's `approvals.list(wait_token_id=[…])` send it.
