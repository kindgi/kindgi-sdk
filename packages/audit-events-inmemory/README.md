# @kindgi/audit-events-inmemory

Reference in-memory implementation of the `AuditEventBinding` contract
from [`@kindgi/audit-events`](../audit-events). Use it in tests and local
development; production deployments plug a durable adapter.

## Purpose

- Give every consumer of `AuditEventBinding` (secrets / env bindings,
  compliance evidence generation, route handlers) a zero-dependency
  adapter to run against without a database.
- Pin down the reference semantics durable adapters must match: the
  cursor shape and ordering below are identical, so swapping adapters
  needs no consumer changes.

## Exports

| Export | Kind | Description |
|---|---|---|
| `createInMemoryAuditEventBinding()` | function | Returns a fresh, isolated `AuditEventBinding` backed by process memory. |

## Semantics

- **append** — validates every event has a non-empty `id` (returns
  `invalid-event` otherwise). Idempotent: a duplicate `id` within a
  tenant is a silent no-op.
- **query** — tenant-scoped; filters on `id`, `kind`, `kinds`, `actor`,
  `onBehalfOf`, `runId`, `agentId`, `flowId`, `correlationId`,
  `outcome`, `payloadDoc` (string equality on `payload.doc` fields), and
  the inclusive `from` / `to` timestamp range. Results are ordered by
  `(timestamp, id)` ascending. `limit` defaults to 50 and is clamped to
  `[1, 500]`. `nextCursor` is base64url JSON `{ timestamp, id }` of the
  last returned event; an undecodable cursor returns `invalid-cursor`.
- **purge** — deletes events of one `kind` in one tenant with
  `timestamp < olderThan`; returns the deleted count.
- **describe** — `{ name: '@kindgi/audit-events-inmemory', version }`.

## Example

```ts
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';

const audit = createInMemoryAuditEventBinding();
await audit.append([
  {
    id: 'evt-1',
    tenantId,
    kind: 'authz-decision',
    timestamp,
    actor: 'user:alice',
    payload: { v: 1, doc: {} },
  },
]);
const page = await audit.query({ tenantId, filter: { kind: 'authz-decision' }, limit: 10 });
```

## Non-goals

- **Durability or cross-process sharing.** State lives in one process
  and is lost on exit.
- **Retention policy.** `purge` is the primitive; scheduling it is the
  caller's job.
- **Scale.** Queries scan and sort the tenant's events on every call.
