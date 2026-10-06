# @kindgi/audit-events

## 0.1.4-rc.1

### Patch Changes

- @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
  - @kindgi/types@0.1.2

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
