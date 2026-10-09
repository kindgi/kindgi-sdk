# @kindgi/client

TypeScript client for the Kindgi runtime's HTTP API (`/v1`). One typed resource client per API resource, a shared transport with bearer auth, idempotency keys and timeouts, typed errors, and pull-model streaming over SSE with `Last-Event-Id` resume.

> **Preview.** Wire types are generated from the OpenAPI document of [`@kindgi/api`](../../packages/api/) (`openapi.json`). Some SDK methods are not connected to an API route: their JSDoc carries `@unwired` and they throw `KindgiApiError` with code `not-yet-wired`. The table under [Resources](#resources) lists them.

## Usage

```ts
import { KindgiApiError, createClient } from '@kindgi/client';

const client = createClient({
  apiUrl: 'https://api.example.com',
  auth: { kind: 'apiToken', token: process.env.KINDGI_API_TOKEN! },
});

// 1. Register an agent definition (the spec `defineAgent` from @kindgi/agents validates)
//    in a project. Definitions (agents, flows, guardrails) always name their project.
const project = await client.projects.getDefault();
const agentId = await client.agents.define(
  {
    id: 'acme.citation-verifier',
    version: '1.0.0',
    name: 'Citation Verifier',
    instructions: 'Verify every citation in the draft against the source.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [{ id: 'acme.citation-lookup', version: '^1.0.0' }],
    retrieval: [{ types: ['acme.prior-draft'], scope: 'same-conversation', limit: 10 }],
    guardrails: ['acme.must-cite-source'],
  },
  { projectId: project.id },
);

// 2. Preview: a dry run runs only the tools declared read-only (`mutating: false`),
//    stops at the first other one, and returns a run marked `dryRun: true`.
const preview = await client.runs.start({
  agent: agentId,
  projectId: project.id,
  input: { draftId: 'draft_123' },
  options: { dryRun: true },
});
console.log(preview.status);

// 3. Start a run without waiting for it, then follow its events.
const run = await client.runs.start({
  agent: agentId,
  projectId: project.id,
  input: { draftId: 'draft_123' },
  options: { wait: false },
});
for await (const event of client.runs.follow(run.id)) {
  console.log(event.kind, event.payload);
}

// 4. Run a flow every night.
const schedule = await client.schedules.register({
  flowId: 'acme.nightly-citation-check',
  flowVersion: '1.0.0',
  config: { cronExpression: '0 2 * * *', timezone: 'UTC', input: { batch: 'nightly' } },
});
console.log(schedule.nextFireAt);

// Errors are thrown as KindgiApiError; `error.code` discriminates.
try {
  await client.runs.get(run.id);
} catch (e) {
  if (e instanceof KindgiApiError && e.error.code === 'not-found') {
    console.error(`no such ${e.error.resource.kind}: ${e.error.resource.id}`);
  }
}
```

## Exports

- **`createClient(options: ClientOptions)`** — returns a `KindgiClient` with one resource client per property (see [Resources](#resources)). `ClientOptions`: `apiUrl` (no trailing slash), `auth` (`{ kind: 'apiToken', token }` or `{ kind: 'oauth', accessToken, refresh? }`), an optional `fetch`, and an optional `timeoutMs` (below). Creating a client opens no connections.
- **Errors** — every method throws **`KindgiApiError`**, whose `error` is a **`KindgiError`** discriminated on `code`: `network`, `auth`, `rate-limited`, `not-found`, `conflict`, `invalid-request`, `guardrail-violation`, `server`, `not-implemented-in-preview`, `not-yet-wired`. **`fromWire(body)`** maps an API error (`{ code, message, details? }`) onto that union; wire codes it does not recognize become `server`, with the original code in `serverCode`. **`notYetWired`** and **`notImplementedInPreview`** build the two preview variants.
- **Streaming** — **`readSse`** and **`unwrapSseData`** read a `text/event-stream` response as an `AsyncIterable`, reconnecting with exponential backoff and `Last-Event-Id`. `runs.follow`, `evalRuns.events`, `adapters.prepare` and the `secrets` rotation event stream are built on them.
- **Types** — the input, filter, page and record types of every resource; branded ids and `Filter` / `Page` re-exported from [`@kindgi/types`](../../packages/types/); `DefineAgentSpec` and `RunStatus`.
- **`Transport`** / **`TransportRequest`** — the request contract the resource clients call.
- **`@kindgi/client/sso-handoff`** (its own entry, with no dependencies, so a browser app can take it alone) — **`identityProviderHandoff(urls, preset?)`** gives the message an admin sends whoever runs their identity provider: the URLs from `auth.providers.signIn`, what to send back (the secret goes into Kindgi's secrets by name), with `preset` (`google`, `entra`, `okta`, `keycloak`: **`IDENTITY_PROVIDER_PRESETS`**) the clicks in that provider's console, and the guide. `kindgi sso providers start` prints the same text.

The transport makes one attempt per call and does not retry. Mutating calls accept an `idempotencyKey`, sent as the `Idempotency-Key` header, so a caller's own retries are safe (see [`docs/API-ROUTE-CONVENTIONS.md`](../../docs/API-ROUTE-CONVENTIONS.md)).

**Timeouts.** One request may take `timeoutMs` (30 000 ms unless `ClientOptions.timeoutMs` says otherwise); then it fails with a `network` error whose `timeoutMs` is set. Streams aren't bound by it. A waited `runs.start` answers only when the run ends, so it's bound by it too, and takes its own `timeoutMs`. When the timeout runs out there, the run may still be going and its id never arrived. Start a run that can take longer with `options: { wait: false }`, whose answer carries the run's id at once, and follow it with `runs.stream(runId)`.

## JSDoc tags

- `@wire` — the method or type mirrors a route or schema in the API's `openapi.json`.
- `@unwired` — the SDK does not call an API route for this method, or the type has no API schema. Methods marked this way throw `KindgiApiError` with code `not-yet-wired`.

## Resources

| Client | API routes | Methods that throw `not-yet-wired` |
|---|---|---|
| `agents` | `/v1/agents` | — |
| `flows` | `/v1/flows` | `validate` |
| `tools` | `/v1/tools` | `invoke`, `manifests` |
| `guardrails` | `/v1/guardrails` | `versions`, `builtIns`, `evaluate` |
| `runs` | `/v1/runs` | `dryRun` (use `start` with `options.dryRun`) |
| `schedules` | `/v1/schedules` | — |
| `conversations` | `/v1/conversations` | — |
| `memory` | `/v1/memory` | `logs.append`, `logs.list`, `logs.verify` |
| `provenance` | `/v1/provenance` | `verify` |
| `proposals` | `/v1/proposals` | — |
| `supervisor` | — | `define`, `get`, `list`, `versions`, `delete`, and every `proposals.*` method (removed in 0.1.5: use `client.proposals`) |
| `observations` | `/v1/observations` | `recordRun`, `patterns` |
| `approvals` | `/v1/approvals` | `batch`, `assign`, `completeToken`, `reviewers.updateRole`, `audit.get`, `audit.list`, `audit.verify` |
| `tenant` | `/v1/tenant` | — |
| `cost` | `/v1/cost` | `budgets.get`, `budgets.set`, `budgets.getRemaining` |
| `capabilities` | `/v1/capabilities`, `/v1/providers` | `route`, `providers.enable`, `providers.disable` |
| `providers` | `/v1/providers` | — |
| `adapters` | `/v1/adapters` | `candidates`, `configured`, `configure` |
| `policies` | `/v1/policies` | `activate`, `evaluate` |
| `projects` | `/v1/projects` | — |
| `env` | `/v1/env` | — |
| `secrets` | `/v1/secrets` | — |
| `deployments` | `/v1/deployments` | — |
| `compliance` | `/v1/compliance` | — |
| `audit` | `/v1/audit` | — |
| `evalSuites` | `/v1/eval-suites` | — |
| `evalRuns` | `/v1/eval-runs`, `/v1/eval-suites/{suiteId}/runs` | — |
| `users` | `/v1/identity/users` | `create`, `update`, `deactivate`, `sessions.revoke` |
| `identity` | `/v1/identity` | — |
| `auth` | `/v1/auth` | — |
| `teams` | `/v1/teams` | — |
| `orgs` | `/v1/orgs` | — |
| `tokens` | `/v1/tokens` | `list`, `get`, `scopes` |
| `mcp` | `/v1/mcp` | `serverInfo`, `tools`, `agents`, `invokeTool`, `invokeAgent` |
| `events` | — | every method |
| `eventTriggers` | `/v1/event-triggers` | — |
| `artifacts` | `/v1/artifacts` | `put`, `get`, `presign`, `setRetentionLock` |
| `webhooks` | `/v1/webhooks` | — |
| `packs` | — | every method |

`client.providers` and `client.capabilities.providers` both address `/v1/providers`.

## Non-goals

- **No retries.** Retry policy belongs to the caller; idempotency keys make retried mutations safe.
- **No client-side signature verification.** `provenance.verify` and `approvals.audit.verify` throw `not-yet-wired`; exported bundles can be verified with `verifyEd25519` from [`@kindgi/crypto`](../../packages/crypto/).
- **No local execution.** Every method takes ids and JSON and makes at most one HTTP request or opens one SSE stream.

## Related

- [`@kindgi/api`](../../packages/api/) — the HTTP API and its `openapi.json`, from which `src/generated/` is produced (`pnpm --filter @kindgi/client gen`).
- [`@kindgi/types`](../../packages/types/) — branded ids and pagination shapes.
- [`@kindgi/sdk`](../../packages/sdk/) — re-exports this client under `@kindgi/sdk/client`.
