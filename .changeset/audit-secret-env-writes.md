---
"@kindgi/api": patch
"@kindgi/compliance": patch
---

Every secret and env write through the API is recorded in the audit log. Before, nothing was: a binding could emit these events only for one fixed tenant and project.
- **`/v1/secrets`:**
  - a set → `secret-set` (`writeMode`, the new version, and `revokedValuesPurged: true` when the backend dropped a revoked secret's values to set it again);
  - a rotation → `secret-rotated` (new and previous version), `secret-rotation-started` (asynchronous, with its `rotationId`) or `secret-rotation-failed`;
  - a revoke → `secret-revoked` / `secret-hard-revoked` (with its `reason`).
- **`/v1/env`:** a set → `env-set` (its revision); a delete → `env-deleted`.
- **Each record:**
  - `actor` is the caller (`user:…`, `service_account:…`, else the session, else `token:` and 16 hex of the credential's sha256);
  - `correlationId` is the request;
  - `projectId` is set for a project-scoped value;
  - a refused write is recorded too, `failed`, with the code the client was answered.
- **Never a value,** nor anything derived from one.
- **Not recorded:** a revoke or delete that changed nothing.
- **Best effort:** a failing audit log never fails the write.
- **`emitLifecycleEvent`:** gains optional `actor`, `correlationId`, `writeMode`, `rotationId` and `revokedValuesPurged`, and `projectId` becomes optional.
