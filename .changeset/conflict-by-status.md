---
"@kindgi/client": patch
---

**Every 409 is a conflict, in the TypeScript and Python clients.** These 409s are now `ConflictError` in the TypeScript and Python clients; they were `ServerError`. The server still answers them with 409: the clients had misread them as server errors, because they didn't list their codes. A 409 is now read as a conflict, as a 404 is already read as a not-found:
- TypeScript: `code: 'conflict'` (was `code: 'server'`), with `reason` the server's code;
- Python: `ConflictError` (was `ServerError`).

The 20 codes the API documents with 409 that move: `run-lease-lost`, `duplicate-node-id`, `duplicate-edge-id`, `agent-version-mismatch`, `waitpoint-error`, `reviewer-deactivated`, `approval-terminal`, `invalid-transition`, `signing-key-conflict`, `signing-key-revoked`, `proposal-terminal`, `block-already-registered`, `block-project-mismatch`, `run-not-finished`, `session-revoked`, `tenant-config-revision-conflict`, `secret-write-conflict`, `env-write-conflict`, `trigger-webhook-id-conflict`, `trigger-already-in-state`.

**If you matched one of them by its class** (`err.code === 'server' && err.serverCode === 'run-lease-lost'`, `except ServerError`), match on its code alone: `err.serverCode` / `e.server_code`. Every error carries it, whatever its class.

**Also changed:**
- A TypeScript `ConflictError` now carries the server's details as `fields`, as a `ServerError` does. So `secrets.set`'s version conflict and `env.set`'s revision conflict still read `currentVersion` and `currentRevision`.
- The TypeScript client reads an unlisted 413 as an invalid request, as the Python client does.
- A 422 code a client doesn't list stays a server error (`budget-exceeded`, `output-schema-violation`).
- The CLI's error line is unchanged: it already showed the code (`Error [run-lease-lost]: …`).

A test in each client now checks every code in the API's `x-error-codes` against its HTTP status's family. A code the API adds can't go unclassified.
