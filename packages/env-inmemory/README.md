# `@kindgi/env-inmemory`

Reference in-memory implementation of the `EnvBinding` contract from [`@kindgi/api`](../api/): the store for non-sensitive, per-environment configuration values keyed by `(scope, envName, name)`. Use it in tests and local development. It refuses to start under `NODE_ENV=production`; deployed environments use a durable `EnvBinding` implemented by the Kindgi runtime.

## Purpose

Give every consumer of `EnvBinding` a store that needs no database but keeps the contract's semantics: values are partitioned by `envName` (a `staging` write is invisible to `production` reads), every write bumps a revision counter that supports optimistic concurrency, and `resolve` walks from the most specific scope to the tenant. With an `AuditEventBinding` attached it also emits the `env-*` audit events, so evidence trails can be exercised end to end in tests.

## Exports

- **`createInMemoryEnvBinding(options?)`** — returns a fresh, isolated `EnvBinding` backed by process memory. Throws at construction when `process.env.NODE_ENV === 'production'` and `productionSafe` is not `true`. The returned binding:
  - `resolve` — checks the requested scope, then the tenant scope (`project → tenant`, `org → tenant`). Returns `{ kind: 'ok', value: { name, value, revision } }` or an `env-not-found` error.
  - `get` / `list` — exact scope only, no walk. `list` filters by `namePrefix` and `tagFilter` (every pair must match; untagged entries never match), sorts by name and returns at most `limit` entries. `cursor` is ignored and `nextCursor` is never set.
  - `set` — creates or overwrites; `revision` starts at `1` and increments on every write. A mismatched `ifRevision` returns `{ kind: 'revision-conflict', currentRevision }` (`0` for a name that does not exist). `enqueueTuples` is required by the contract but not called.
  - `delete` — removes the entry and returns `{ deleted }`; a later `resolve` at that scope falls through to the tenant value.
- **`InMemoryEnvBindingOptions`**:
  - `productionSafe?: boolean` — default `false`. Allows construction under `NODE_ENV=production`, for example in a parity-test container.
  - `now?: () => number` — clock used for `createdAt` / `updatedAt`; defaults to `Date.now`.
  - `auditEvents?: AuditEventBinding`, `tenantId?: TenantId`, `projectId?: ProjectId` — audit emission is enabled only when all three are set. `set` emits `env-set` (outcome `failed` with `env-write-conflict` on a revision conflict), `resolve` emits `env-resolved`, and a `delete` that removed something emits `env-deleted`. Every event is recorded under the configured `tenantId` / `projectId`, and payloads never contain the value. Emission is awaited, but a failing audit sink is logged with `console.warn` and does not fail the operation.

## Example

```ts
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import { createInMemoryEnvBinding } from '@kindgi/env-inmemory';
import type { Scope } from '@kindgi/platform';
import { makeEnvName, type ProjectId, type TenantId } from '@kindgi/types';

const tenantId = 'acme' as TenantId;
const projectId = 'acme-support' as ProjectId;
const staging = makeEnvName('staging');
if (staging === null) throw new Error('invalid env name');

const tenant: Scope = { kind: 'tenant', tenantId };
const project: Scope = { kind: 'project', tenantId, projectId };

const audit = createInMemoryAuditEventBinding();
const env = createInMemoryEnvBinding({ auditEvents: audit, tenantId, projectId });

const kbUrl = { envName: staging, name: 'KB_URL' } as const;
await env.set({ scope: tenant, ...kbUrl, value: 'https://kb.acme.test', enqueueTuples: () => [] });

// The project has no value of its own, so resolution falls back to the tenant.
const resolved = await env.resolve({
  scope: project,
  ...kbUrl,
  resolveContext: { caller: 'dispatch', runId: 'run-1' },
});
if (resolved.kind === 'ok') console.log(resolved.value.value, resolved.value.revision); // https://kb.acme.test 1

// Optimistic concurrency: this write applies only while the tenant value is at revision 1.
const updated = await env.set({
  scope: tenant,
  ...kbUrl,
  value: 'https://kb-v2.acme.test',
  ifRevision: 1,
  enqueueTuples: () => [],
});
if (updated.kind === 'revision-conflict') console.warn('stale write', updated.currentRevision);

const events = await audit.query({ tenantId }); // env-set, env-resolved, env-set
```

## Non-goals

- **Durability or cross-process sharing.** State lives in one process and is lost on exit.
- **Org-level resolution for project scopes.** The in-memory store has no project → org relation, so a project scope falls back straight to the tenant. Durable implementations walk `project → org → tenant`.
- **Secrets.** Values are stored and returned in plaintext; sensitive values belong in a `SecretBinding`.
- **Soft delete.** `delete` removes the entry; the contract defines env as a plain overwrite-shaped store.

## Related

- [`@kindgi/api`](../api/) — the `EnvBinding` contract and `ResolveContext`.
- [`@kindgi/platform`](../platform/) — the `Scope` union.
- [`@kindgi/types`](../types/) — `EnvName` and the `makeEnvName` validator.
- [`@kindgi/audit-events-inmemory`](../audit-events-inmemory/) — in-memory `AuditEventBinding` for the emitted events.
