# @kindgi/audit-events

## 0.1.1

### Patch Changes

- @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- aec851d: Wire-contract fixes in the API routes and their OpenAPI document.
  
  - **`StartRunBody`**: the agent variant declares the optional `projectId` (UUID) that `POST /v1/runs` already accepts for agent runs. Clients that validate against the schema (it sets `additionalProperties: false`) no longer reject a valid request. Both variants now describe `projectId`: omitted, the run goes to the tenant's Default project.
  - **`PublishAgentBody`, `PublishFlowBody`, `RegisterToolBody`, `RegisterGuardrailBody`, `PublishEvalSuiteBody`, `StartEvalRunBody`**: declare the `projectId` (UUID) their routes already require — `POST /v1/agents`, `/v1/flows`, `/v1/tools`, `/v1/guardrails`, `/v1/eval-suites` and `/v1/eval-suites/:suiteId/runs` answer `400 bad-input` when it is missing or isn't a project of the caller's tenant. It is now listed in `required`, so the documented bodies are the ones the routes accept; before, a schema-validating client rejected every valid request.
  - **`WhoamiResult`**: declares `user` (a `UserRecord`), which `GET /v1/identity/whoami` returns when the deployment wires an identity directory that knows the caller's `userId`.
  - **`GET /v1/audit/authz`**: `?onBehalfOf=`, `?action=` and `?resource=` are now applied in the audit query rather than to the returned page, so a page is full while matching decisions remain and `nextCursor` / `hasMore` are exact. Previously a page could come back short, or empty, with `hasMore: true`. To support this, `AuditEventFilter` (`@kindgi/audit-events`) gains `onBehalfOf` (matches `AuditEvent.onBehalfOf`) and `payloadDoc` (every entry must equal the same field of `payload.doc`); the in-memory binding implements both. A binding that doesn't implement them yet still returns only matching decisions, because the route re-checks the three filters on each page.
  - **`GET /v1/tenant/config`**: now cursor-paginated across the env and secrets bindings. The list is the env entries (in the env binding's order) followed by the secret entries (in the secrets binding's order); a page holds at most `limit` entries, and `nextCursor` / `hasMore` are set when more remain. Previously each binding returned up to `limit` entries (up to twice `limit` in all, sorted by `updatedAt`), `?cursor=` was passed to both bindings unchanged, and `hasMore` was always `false`, so entries past the first page were unreachable. A malformed cursor, or one pointing into a binding the current `?kind=` excludes, returns `400 bad-input`.
  - **`GET /v1/runs/:runId/stream`**: when an event bus is wired but subscribing fails, the stream now falls back to polling the journal as documented. Previously it ended right after the backfill, before the run's later events.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
