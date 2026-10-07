# API route conventions — Kindgi platform

**Status:** normative — every `/v1/*` route follows these conventions.
**Related:** [`ADDING-A-ROUTE.md`](./ADDING-A-ROUTE.md) (authoring checklist), `packages/api/openapi.json` (generated from the route registry; exported as `@kindgi/api/openapi.json`).

This document fixes the on-wire conventions — URL shapes, authentication, request and response envelopes, pagination, streaming, signed exports, and error propagation — so the API, the generated OpenAPI document, and client SDKs agree. The OpenAPI document is their executable form; drift tests keep routes, the OpenAPI registry, and the TypeScript client in sync.

---

## 1. URL structure

### 1.1 Base + versioning

- Base path: `/v1/`. All routes are versioned. Breaking changes ship at `/v2/` — never mutate `/v1/` shapes.
- No trailing slash on canonical URLs (e.g. `/v1/runs`, not `/v1/runs/`). Requests with trailing slash 301-redirect to the canonical form.
- Version bump policy: additive changes stay in `/v1/`. Renames, removed fields, or changed semantics require `/v2/`.

### 1.2 Resource layout

Resources are **plural, kebab-case, singular resource ID at the tail**:

- Collection: `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/:runId`, `DELETE /v1/runs/:runId`.
- Sub-collection: `GET /v1/runs/:runId/journal`, `POST /v1/runs/:runId/cancel`.
- Cross-cutting stream: `GET /v1/runs/:runId/stream` (SSE).

Verb suffixes are used sparingly for **non-CRUD actions** where a resource-shaped route would be misleading (e.g. `cancel`, `resume`, `dry-run`). Prefer plain CRUD when possible.

### 1.2.1 Removing catalog resources

Catalog resources (agents, flows, tools, guardrails, policies, schedules, triggers, webhook endpoints, …) are not hard-deleted. They are removed with `POST /v1/<resource>/:id/unregister`:

- the row is kept, marked unregistered, and hidden from every read (a later `GET` answers 404);
- the response is `{ <idField>: string, unregistered: boolean }`, where `unregistered` is `false` when the resource was unknown or already unregistered, so the call is idempotent;
- the runtime removes unregistered rows later, under its retention policy.

### 1.3 Path parameter naming

- `:runId`, `:agentId`, `:flowId`, `:approvalId`, `:conversationId`. Camel-case with `Id` suffix. Matches TypeScript type names one-to-one.
- Always the branded id type on the wire (opaque strings; UUIDs today but the SDK / server never assume format).

---

## 2. Authentication

### 2.1 Bearer token

Every non-public request carries:

```
Authorization: Bearer <api-token>
```

API keys are minted server-side (`POST /v1/tokens`, tenant admins only) and return a plain string, once. A key is a service account in its tenant (`service_account:<tokenId>`) and carries:
- Its tenant.
- A role: `admin` (administers the tenant, manages keys) or `member`.
- Explicit capabilities (`env:write`, `secrets:write`, …): a caller can only grant capabilities it holds.
- An optional project scope and expiration.

`GET /v1/tokens` lists keys and `GET /v1/tokens/{tokenId}` reads one; neither returns a secret. `POST /v1/tokens/{tokenId}/revoke` takes effect on the next request.

The SDK's `AuthConfig` (`sdks/typescript/src/auth.ts`) already emits this header via its `apiToken` mode. No SDK change needed.

### 2.2 Public routes

The only fully-public routes are:
- `GET /health` — liveness. No auth. Returns `{ ok: true }`.
- `GET /v1/openapi.json` — the OpenAPI document.
- Inbound webhook receivers, when a deployment turns them on — authenticated by an HMAC signature header, not a Bearer token. There's no receiver route yet: `/v1/webhooks` only manages the webhook triggers.

### 2.3 Tenant scoping

The server derives `tenantId` from the token; callers never pass it explicitly on requests. Every DB read/write inside a route handler flows through `withTenantConnection(client, tenantId, ...)`.

### 2.4 Failure modes

- Missing/malformed `Authorization` → `401 unauthorized` with error `code: 'auth-missing'`.
- Expired or revoked token → `401 unauthorized` with error `code: 'auth-expired'` or `'auth-revoked'`.
- Valid token, resource is out of scope for its tenant → `404 not-found`, never `403 forbidden` (avoid leaking resource existence across tenants).

---

## 3. Request body shape

- All bodies are JSON. `Content-Type: application/json; charset=utf-8` is required on POST/PUT/PATCH.
- Empty body accepted where semantically appropriate (`POST /v1/runs/:runId/cancel` takes no body).
- Field names are camelCase, matching the SDK's TypeScript types verbatim. No wire-format renames.
- Unknown top-level fields → `400 bad-request` with error `code: 'unknown-field'`. Strict validation on the request; permissive on the response (for forward compatibility).

### 3.1 Idempotency

Any mutating request may include:

```
Idempotency-Key: <caller-supplied-uuid>
```

Semantics:
- Server stores `(tenantId, route, key) → response` for 24h.
- Retries with the same key return the original response byte-identical (including status code).
- Retries with the same key but a different body → `409 conflict` with error `code: 'idempotency-key-body-mismatch'`.
- Applies to `POST`, `PUT`, `PATCH`, `DELETE`.

`@kindgi/client` sends the `Idempotency-Key` header on mutating calls when the caller passes `idempotencyKey`.

---

## 4. Response shape

### 4.1 Success

`2xx` status codes carry the resource / operation result as the JSON body directly. No wrapper envelope for success.

```json
{
  "id": "run-abc123",
  "status": "running",
  "flowId": "agent.turn",
  "flowVersion": "1.0.0",
  "startedAt": "2026-09-18T12:34:56.789Z"
}
```

### 4.2 Error

`4xx` and `5xx` responses carry a **discriminated error envelope**:

```json
{
  "error": {
    "code": "unresolved-tool",
    "message": "Tool \"acme.citation-lookup\" is not registered for agent \"acme.drafting\"",
    "details": {
      "toolId": "acme.citation-lookup"
    },
    "requestId": "req-01H8XYZ..."
  }
}
```

- `code` is a stable machine-readable discriminant. Values match existing domain error codes (`unresolved-tool`, `guardrail-violation`, `hitl-required`, `agent-turn-aborted`, etc.). New codes only add.
- `message` is human-readable, not part of the API contract.
- `details` is optional, kind-specific.
- `requestId` is server-assigned; always present.

The SDK's `fromWire(json)` (`sdks/typescript/src/errors.ts`) matches on `code`.

### 4.3 Status code mapping

| Domain error `code`                              | HTTP status |
|---                                               |---          |
| `not-found`, `run-not-found`, `agent-not-found`  | 404         |
| `already-terminal`, `run-already-terminal`       | 409         |
| `idempotency-key-body-mismatch`                  | 409         |
| `duplicate-*`                                    | 409         |
| `slug-conflict`, `project-default-already-exists`| 409         |
| `validation-failed`, `unknown-field`, `bad-input`| 400         |
| `unresolved-tool`, `unresolved-guardrail`        | 400         |
| `hitl-required`                                  | 409         |
| `guardrail-violation`                            | 422         |
| `agent-turn-aborted`, `budget-exceeded`          | 422         |
| `flow-unbound`, `flow-runs-not-supported`, `flow-resume-not-supported` | 422 |
| `auth-missing`, `auth-expired`, `auth-revoked`   | 401         |
| `permission-denied`                              | 403         |
| `rate-limit-exceeded`                            | 429         |
| Anything else server-caused                      | 500         |

---

## 5. Pagination

Every list endpoint accepts:

- `?limit=<int>` — 1..100, default 25.
- `?cursor=<opaque-string>` — server-issued from a prior response.

Response body:

```json
{
  "data": [ ... ],
  "nextCursor": "cursor-abc123",
  "hasMore": true
}
```

- `nextCursor` is absent when `hasMore: false`.
- Cursors are opaque — SDKs treat them as strings. Server encodes whatever it needs (page number, last-id, whatever).
- Filters go as query params: `?status=running&agentId=...`.
- Sort order is fixed per endpoint (documented per route); no `?sort=` unless explicitly supported.

Matches the SDK's `Filter<TStatus>` + `Cursor` types verbatim.

---

## 6. Streaming (SSE)

`GET /v1/runs/:runId/stream` returns Server-Sent Events. Each event is one `RunEvent` (the union defined by `@kindgi/specs/run-event.schema.json`).

### 6.1 Event format

```
id: <eventId>
event: run.step-completed
data: {"eventId":"...","runId":"...","tenantId":"...","kind":"run.step-completed",...}

```

- `id` line: monotonic per run, used as `Last-Event-Id` on reconnect.
- `event` line: the `RunEvent.kind` value.
- `data` line: the full serialized `RunEvent` JSON. Callers using EventSource-compatible parsers can ignore the `event` line and switch on `data.kind`.

### 6.2 Reconnection

The SDK's `readSse<T>()` sends `Last-Event-Id: <lastSeenEventId>` on reconnect. Server resumes from that id + 1 exclusive; missed events are replayed from the journal.

### 6.3 Termination

Server closes the SSE connection cleanly after emitting `run.completed` / `run.failed` / `run.cancelled` (whichever is the terminal event for that run). Callers observe end-of-stream normally.

---

## 7. Verb → Kernel mapping

For the runs resource specifically (the largest surface):

| Verb + path                          | Kernel op                                  | Notes |
|---                                   |---                                         |---    |
| `POST /v1/runs`                      | `runGraph(...)`                            | Body: `{ agent \| flow, input, options?: { dryRun?: boolean, wait?: boolean } }`. Returns the run row with its `output`: `201` once the run completes, fails or suspends; `202` right away with `wait: false`. |
| `GET /v1/runs/:runId`                | Load row from `kernel_runs`                | Returns the run row, with `output` once completed and `parentRunId` / `parentNodeId` on a child run. |
| `GET /v1/runs`                       | List with pagination                       | Filters: `parentRunId` (a run's children), `topLevel=true`. `include=output` adds each run's output. |
| `POST /v1/runs/:runId/cancel`        | `cancelRun(...)`                           | Empty body. Returns updated `RunResult`. |
| `POST /v1/runs/:runId/resume`        | `completeToken(...)`, then the host's `resumeRun(...)` | Body: `{ waitpointId, value? }`. Ids starting with `child:` are reserved for the runtime. |
| `GET /v1/runs/:runId/journal`        | `readJournal(...)`                         | Paginated: `?since=<sequence>&limit=<int>`. |
| `GET /v1/runs/:runId/stream`         | SSE from journal + in-process bus          | See §6. |

The other resources (`agents`, `flows`, `tools`, `guardrails`, `approvals`, etc.) follow the same shape — CRUD verbs map to package-level functions; non-CRUD actions map to specific ops.

---

## 8. Error propagation across the boundary

Kernel / package-level `Result<T, E>` errors are translated at the route layer:

- Success `ok` → serialize `T` as JSON body with 2xx status.
- Failure `err` → look up the error `code` in the mapping table (§4.3), serialize as `{ error: {...} }` with the mapped HTTP status.

Every `err.code` known to `packages/*` must have a status mapping. New error codes require adding a row to §4.3 (in this doc) + the route layer's mapping table.

Domain errors are the ONLY response body shape for 4xx/5xx. Framework crashes (thrown exceptions, uncaught DB errors) get caught by a top-level middleware that produces `{ error: { code: 'internal-server-error', message: '...', requestId: '...' } }` with 500.

---

## 9. Non-goals

- **GraphQL / gRPC / other transports.** REST + SSE only.
- **Batching endpoints.** No `POST /v1/runs/batch` — clients send N requests.

---

## 10. Signed bundle canonicalization

Signed export routes (`POST /v1/provenance/:runId/export`, `POST /v1/approvals/:approvalId/audit-bundle`, any future signed export) MUST return the same wire envelope so SDK clients can share a single verification helper:

```json
{
  "<resourceId>": "...",           // e.g. "runId" or "approvalId"
  "bundle": "base64-of-canonical-json",
  "bundleSchemaVersion": <version>,  // semver string OR integer; kind-specific
  "algorithm": "ed25519",
  "signingKeyId": "...",
  "signature": "base64-signature-bytes",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "canonicalization": "sorted-key-json",
  "exportedAt": "2026-09-19T12:34:56.789Z"
}
```

Canonicalization algorithm (`canonicalization: "sorted-key-json"`) is provided by `canonicalize` from `@kindgi/schema`: JSON with object keys sorted lexicographically at every level, no whitespace, UTF-8 bytes. Arrays preserve declaration order. This algorithm is stable across resources — provenance and audit bundles share it verbatim so verification code is identical.

Verifier flow (client-side, no server round trip):
1. Base64-decode `bundle` → canonical bytes.
2. Base64-decode `signature` → 64 signature bytes.
3. `parsePublicKeyPem(publicKey)` from `@kindgi/crypto`.
4. `verifyEd25519(publicKey, bundleBytes, signatureBytes)`.
5. If needed, `JSON.parse(bundleBytes.toString('utf8'))` for structured inspection — the canonical form is regular JSON.

Deployments without a `signingKey` binding mounted return `404 signing-not-configured` on every signed-export route; unknown `signingKeyId` returns `404 signing-key-not-found`. Both error codes are shared across resources.

Response envelope shape is guardrail across resources; the bundle *body* schema is per-resource (see `ExportProvenanceResult` / `ExportAuditBundleResult` in the OpenAPI document). New signed exports MUST reuse this envelope.
