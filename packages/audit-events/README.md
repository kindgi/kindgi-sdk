# `@kindgi/audit-events`

Type contract for the Kindgi audit log. Defines the `AuditEvent` record every subsystem emits (authorization decisions, secret and env changes, run outcomes, guardrail violations, human-in-the-loop decisions) and `AuditEventBinding`, the tenant-scoped append / query / purge interface that storage adapters implement. Types only; this package has no runtime code.

## Purpose

Give the whole system one audit substrate: one record shape, one write surface, one query surface. Compliance evidence is a classification lens over this stream (see [`@kindgi/compliance`](../compliance/)), not a second write path. Common fields (`tenantId`, `projectId`, `timestamp`, `actor`, `correlationId`, `runId`, …) are top-level so they can be indexed; kind-specific data lives in a versioned `payload`. The binding is caller-plugged: [`@kindgi/api`](../api/) takes one as `auditEvents` and mounts the audit routes over it, and the reference in-memory implementation lives in [`@kindgi/audit-events-inmemory`](../audit-events-inmemory/).

## Exports

- **`AuditEvent`** — one audit record:
  - `id` — caller-supplied, unique per tenant.
  - `tenantId`, `projectId?` (absent for tenant-level events), `kind` (open string, e.g. `'authz-decision'`, `'secret-set'`, `'run-outcome'`), `timestamp`.
  - `actor` — `<type>:<id>`, e.g. `user:u-1042`, `agent:support-triage`, `user:system` for framework-internal actions. `onBehalfOf?` names the delegating party.
  - `correlationId?`, `runId?`, `agentId?`, `flowId?`, `outcome?`.
  - `payload` — versioned envelope `{ v: 1, doc: … }`; the `doc` shape depends on `kind`.
- **`AuditEventBinding`** — the adapter interface:
  - `append(events)` — batched write. Duplicate `(tenantId, id)` pairs are ignored, so retries are safe. Fails with `PersistenceError` or `AuditEventValidationError`.
  - `query(input)` — cursor-paginated read ordered by `(timestamp, id)`; the cursor is opaque. Fails with `PersistenceError` or `InvalidCursorError`.
  - `purge(input)` — delete one kind's events older than a cutoff; returns the deleted count.
  - `describe()` — `{ name, version }`.
- **`AuditEventQueryInput`** — `tenantId`, `filter?`, `cursor?`, `limit?`.
- **`AuditEventFilter`** — AND-combined; absent fields match anything. Fields: `id`, `kind`, `kinds` (an empty array matches nothing), `actor`, `onBehalfOf`, `runId`, `agentId`, `flowId`, `correlationId`, `outcome`, `payloadDoc` (every entry must equal the same field of `payload.doc`), and inclusive ISO `from` / `to` bounds.
- **`AuditEventPage`** — `data` plus `nextCursor` (absent on the last page).
- **`AuditEventPurgeInput`** (`tenantId`, `kind`, `olderThan`) and **`AuditEventPurgeResult`** (`deleted`).
- **`AuditEventError`** — union of **`PersistenceError`** (`persistence-error`), **`InvalidCursorError`** (`invalid-cursor`), and **`AuditEventValidationError`** (`invalid-event`, with optional per-path `issues`).

## Example

```ts
import { randomUUID } from 'node:crypto';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { ProjectId, TenantId, Timestamp } from '@kindgi/types';

async function recordDecision(
  audit: AuditEventBinding,
  tenantId: TenantId,
  projectId: ProjectId,
  allowed: boolean,
): Promise<void> {
  const event: AuditEvent = {
    id: randomUUID(), // unique per tenant; re-appending the same id is a no-op
    tenantId,
    projectId,
    kind: 'authz-decision',
    timestamp: new Date().toISOString() as Timestamp,
    actor: 'agent:support-triage',
    onBehalfOf: 'user:u-1042',
    outcome: allowed ? 'allowed' : 'denied',
    payload: { v: 1, doc: { action: 'tool:invoke', resource: 'crm.lookup' } },
  };
  const written = await audit.append([event]);
  if (written.kind === 'err') throw new Error(`${written.error.code}: ${written.error.message}`);
}

// Page through every denial since `from`, oldest first.
async function* denialsSince(
  audit: AuditEventBinding,
  tenantId: TenantId,
  from: string,
): AsyncGenerator<AuditEvent> {
  let cursor: string | undefined;
  do {
    const page = await audit.query({
      tenantId,
      filter: { kind: 'authz-decision', outcome: 'denied', from },
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    if (page.kind === 'err') throw new Error(`${page.error.code}: ${page.error.message}`);
    yield* page.value.data;
    cursor = page.value.nextCursor;
  } while (cursor !== undefined);
}
```

## Non-goals

- **No storage implementation.** Adapters implement `AuditEventBinding`; the in-memory reference is [`@kindgi/audit-events-inmemory`](../audit-events-inmemory/), and durable adapters are supplied by the Kindgi runtime.
- **No signing on the write path.** Records are stored unsigned; signatures are computed over canonical bytes at export time by the compliance layer.
- **No retention policy.** `purge` removes one kind older than a cutoff. Deciding when to call it, and exempting legal-hold kinds, belongs to the caller and the compliance classifier.
- **No closed set of kinds or payload schemas.** `kind` is an open string so packs can add their own; each kind defines its own `payload.doc`.

## Related

- [`@kindgi/audit-events-inmemory`](../audit-events-inmemory/) — reference `AuditEventBinding` for tests and local development.
- [`@kindgi/compliance`](../compliance/) — classifier and signed export over this stream; `auditEventToEvidence` maps an `AuditEvent` to an evidence record.
- [`@kindgi/api`](../api/) — accepts an `AuditEventBinding` as `auditEvents`.
