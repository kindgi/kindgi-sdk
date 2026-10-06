---
"@kindgi/api": patch
"@kindgi/client": patch
---

An error code a client doesn't list is read by its HTTP status. Until now any newer code, such as a 404 `org-not-found`, became a server error. Now, in the TypeScript and Python clients:
- 404 and 410 are a not-found (the resource's kind comes from the code: `org` for `org-not-found`);
- 401 and 403 are an auth error (unauthenticated or forbidden);
- 429 is rate-limited;
- 400 is an invalid request.

Codes the clients list keep their class; the list now also has the 409 codes of the already-registered family (`eval-suite-already-registered`, `policy-already-registered`, `mcp-endpoint-already-registered`, `identity-provider-already-registered`, `version-already-exists`, `eval-run-already-terminal`, `approval-already-decided`, `judge-class-name-taken`), conflicts like their listed siblings, and the TypeScript client now also lists `policy-scope-taken` and `policy-scope-changed`, as the Python client did. 409 and 422 codes they don't list stay server errors, matched by their code, as the docs show (`budget-exceeded`, `agent-version-mismatch`). In TypeScript, every error from the server now carries the wire code as `serverCode`, whatever its family (Python's `server_code` already did). `@kindgi/api`'s OpenAPI document lists every error code and its status as `WireError['x-error-codes']`, and the clients' tests check against it.
