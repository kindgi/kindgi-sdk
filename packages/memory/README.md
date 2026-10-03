# `@kindgi/memory`

Type contract for Kindgi memory: typed, versioned facts, the hash-chained run log, retrieval hits, and `MemoryQueryBinding`, the interface for querying facts and appending to the run log. The package holds no state and ships no storage; its only runtime export is the `LOG_KINDS` constant. A runtime adapter implements the binding (the Kindgi runtime provides a Postgres-backed one), and any object that satisfies the interface can stand in for it.

## Purpose

Give agent code, tools, and storage backends one shared vocabulary for memory, so that code that reads facts (for example the retrieval step in [`@kindgi/agents`](../agents/)) depends only on an interface and never on a database client. Every operation is tenant-scoped: callers pass `tenantId` on each call, and the binding implementation enforces isolation.

## Exports

- **Facts**
  - **`Fact<TContent>`** — a typed, versioned record: `id`, `type`, `scope`, `version` (monotonic within `(scope, id)`), `createdAt`, and optional `updatedAt`, `content`, `contentRef` (`blob://<provider>/<bucket>/<key>` for payloads stored externally), `contentHash`, `size`, `embeddingModel`, `retention`, `source`, `causedByLogId`, `supersedes`. A fact without `source` is immutable output ("Kind A"); a fact with `source` is a cached view of external state ("Kind B").
  - **`MemoryScope`** — where a fact or log entry lives: `tenantId` plus optional `userId`, `orgId`, `projectId`, `threadId`, `sessionId`.
  - **`Retention`** — fact-level override of the tenant's retention defaults: `keepUntil`, `keepDays`, `legalHold`.
  - **`Source`**, **`SourceFreshness`**, **`SourceRefresh`** — external-source metadata for Kind B facts: the source `kind` (`http-api`, `blob`, `mcp-tool`, `external-db`, `user-input`) and `uri`, freshness data (`ttlSeconds`, `lastVerifiedAt`, `etag`, `sourceVersion`), and the refresh `strategy` (`on-read`, `background`, `manual`) with an optional registered `handler` id.
- **Log**
  - **`LogEntry`** — one immutable entry in a run's append-only log, ordered by `sequence` within `(tenantId, runId)`. Each entry stores `prevHash` and `entryHash`, so changing an earlier entry breaks every later link in the chain.
  - **`LOG_KINDS`** / **`LogKind`** — the closed set of entry kinds (`user-message`, `agent-message`, `system-message`, `tool-call`, `tool-result`, `internal-thought`, `retrieval`, `artifact-produced`, `event-emitted`, `event-received`, `guardrail-triggered`, `wait-suspended`, `wait-resumed`), matching the enum in `memory.schema.json` from [`@kindgi/specs`](../specs/).
- **`RetrievalHit<TContent>`** — a `fact` plus a numeric `score`. Keyword scores are unbounded positive ranks; semantic scores are cosine similarity in [-1, 1]. Higher is better in both cases.
- **`MemoryQueryBinding`** — the data-access interface, implemented by a runtime adapter. Every method returns `Promise<Result<…, MemoryError>>`.
  - `listFacts(input: ListFactsInput)` — facts filtered by `type` and a partial `scope`, capped by `limit`; `latestOnly` selects the latest version of each fact.
  - `searchByKeyword(input: SearchByKeywordInput)` — full-text search over facts, returning up to `topK` hits.
  - `searchBySemantic(input: SearchBySemanticInput)` — embeds `query` through the caller-supplied `embeddingRegistry` from [`@kindgi/embedding`](../embedding/) (pinned to `embeddingModel`, or the registry's only provider when omitted) and runs a vector search.
  - `appendLog(input: AppendLogInput)` — appends one entry. The implementation assigns `sequence` and the hash chain and returns the stored `LogEntry`.
  - `readLog(input: ReadLogInput)` — the entries for `(tenantId, runId)` in order, optionally narrowed with `sinceSequence`.
- **Errors** — **`MemoryError`**, a union of `InvalidLogEntryError`, `InvalidFactError`, `FactNotFoundError`, `LogNotFoundError`, `RefreshHandlerMissingError`, `RetentionViolationError` (`reason`: `legal-hold`, `keep-until` or `keep-days`), `PersistenceError`, and the `EmbeddingError` variants from `@kindgi/embedding`. Every variant carries a `code` for matching.

## Example

```ts
import type { Fact, MemoryQueryBinding } from '@kindgi/memory';
import type { ProjectId, RunId, TenantId } from '@kindgi/types';

interface Clause {
  readonly heading: string;
  readonly text: string;
}

/** True when a cached-view (Kind B) fact is older than its source's TTL. */
function isStale(fact: Fact, now = Date.now()): boolean {
  const freshness = fact.source?.freshness;
  if (freshness?.ttlSeconds === undefined || freshness.lastVerifiedAt === undefined) return false;
  return now - Date.parse(freshness.lastVerifiedAt) > freshness.ttlSeconds * 1000;
}

export async function findClauses(
  memory: MemoryQueryBinding,
  tenantId: TenantId,
  projectId: ProjectId,
  runId: RunId,
  query: string,
): Promise<readonly Clause[]> {
  const hits = await memory.searchByKeyword<Clause>({
    tenantId,
    query,
    type: 'acme.clause',
    scope: { projectId },
    topK: 5,
  });
  if (hits.kind === 'err') {
    console.error(`clause search failed: ${hits.error.code}`, hits.error.message);
    return [];
  }

  // Record the lookup in the run's hash-chained log.
  const logged = await memory.appendLog({
    tenantId,
    runId,
    kind: 'retrieval',
    scope: { tenantId, projectId },
    actor: 'acme.clause-finder',
    payload: { query, factIds: hits.value.map((hit) => hit.fact.id) },
  });
  if (logged.kind === 'err') console.error('log append failed', logged.error.message);

  return hits.value
    .filter((hit) => !isStale(hit.fact))
    .flatMap((hit) => (hit.fact.content === undefined ? [] : [hit.fact.content]));
}
```

## Non-goals

- **No implementation.** Storage, full-text and vector indexes, embedding calls, refresh handlers, and retention sweeps belong to the binding implementation. This package defines shapes only.
- **No provenance on the interface.** An implementation may record provenance internally, but `MemoryQueryBinding` never accepts or returns a provenance builder.
- **No per-fact retrieval hints.** Which indexes a fact type populates is configured once per type in the memory implementation, not on individual facts.
- **No pagination cursor.** `listFacts` takes a `limit` only.

## Related

- [`@kindgi/agents`](../agents/) — takes a `MemoryQueryBinding` and uses it for the retrieval step of each agent turn.
- [`@kindgi/embedding`](../embedding/) — the embedding provider registry used by `searchBySemantic`.
- [`@kindgi/specs`](../specs/) — `memory.schema.json`, the wire schema for facts and log entries.
- [`@kindgi/types`](../types/) — branded ids (`FactId`, `LogEntryId`, `RunId`, …) and `Result`.
