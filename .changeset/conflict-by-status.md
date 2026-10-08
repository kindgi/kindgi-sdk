---
"@kindgi/client": patch
---

**Every 409 is a conflict, in the TypeScript and Python clients.** A 409 whose code a client didn't list was a server error (`code: 'server'`, Python `ServerError`); now it's a conflict, as a 404 is already a not-found:
- TypeScript: `code: 'conflict'`, with `reason` the server's code;
- Python: `ConflictError`.

That moves 20 codes the API documents: `run-lease-lost`, `duplicate-node-id`, `duplicate-edge-id`, `agent-version-mismatch`, `waitpoint-error`, `reviewer-deactivated`, `approval-terminal`, `invalid-transition`, `signing-key-conflict`, `signing-key-revoked`, `proposal-terminal`, `block-already-registered`, `block-project-mismatch`, `run-not-finished`, `session-revoked`, `tenant-config-revision-conflict`, `secret-write-conflict`, `env-write-conflict`, `trigger-webhook-id-conflict`, `trigger-already-in-state`.

**If you matched one of them by its class** (`err.code === 'server' && err.serverCode === 'run-lease-lost'`, `except ServerError`), match on its code alone: `err.serverCode` / `e.server_code`. Every error carries it, whatever its class.

**Also changed:**
- A TypeScript `ConflictError` now carries the server's details as `fields`, as a `ServerError` does. So `secrets.set`'s version conflict and `env.set`'s revision conflict still read `currentVersion` and `currentRevision`.
- The TypeScript client reads an unlisted 413 as an invalid request, as the Python client does.
- A 422 code a client doesn't list stays a server error (`budget-exceeded`, `output-schema-violation`).
- The CLI's error line is unchanged: it already showed the code (`Error [run-lease-lost]: …`).

A test in each client now checks every code in the API's `x-error-codes` against its HTTP status's family. A code the API adds can't go unclassified.
