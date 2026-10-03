// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Fact, MemoryScope, Retention } from '@kindgi/memory';
import type { Scope as PlatformScope } from '@kindgi/platform';
import type { Cursor, FactId, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the memory resource. Same shape as
 * `AgentRegistryBinding` / `ToolRegistryBinding` / `GuardrailRegistryBinding`:
 * the API package does NOT own memory persistence or retrieval logic.
 * Deployments plug in a binding that wraps the memory subsystem (the
 * Kindgi runtime provides one) together with their own
 * `EmbeddingProviderRegistry` and per-type retrieval policies.
 *
 * Every method is tenant-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing the
 * scoping inside the API package.
 *
 * Cursors are opaque — the binding chooses its encoding (page number,
 * ISO timestamp, `id@version`, whatever). The API layer only validates
 * that a cursor round-trips as a string; it never inspects the payload.
 *
 * Supersession, not delete: facts are append-only. `supersedeFact`
 * writes a new revision that supersedes the target; the historical row
 * remains readable until retention sweeps it. There is no hard delete;
 * the retention sweep handles physical removal.
 */
export interface MemoryBinding {
  /**
   * Cursor-paginated list of facts under the tenant. Filters:
   *   - `type` — exact fact-type match.
   *   - `scope` — partial-match filter (see `Scope` in the memory subsystem).
   *
   * Sort order is binding-defined — for example, the latest version
   * per `(type, id)` sorted by `createdAt desc`.
   */
  listFacts(input: MemoryListFactsInput): Promise<MemoryFactPage>;
  /**
   * The fact with the given id, or `null` if unknown. Latest version
   * by default; bindings MAY accept a `version` in the input to select
   * a specific historical revision (not exposed on the route today).
   * The route surfaces `null` as `404 fact-not-found`.
   */
  getFact(input: MemoryGetFactInput): Promise<Fact | null>;
  /**
   * Persist a new fact. The binding validates the write against its
   * retrieval-policy registry (populates keyword / semantic indexes
   * per type) and its embedding registry (for semantic-indexed types).
   *
   * When the fact type declares semantic indexing but no embedding
   * provider is bound, the binding MUST return an `err` result — the
   * route maps that to `400 bad-input`.
   */
  writeFact(input: MemoryWriteFactInput): Promise<MemoryWriteFactOutcome>;
  /**
   * Mark a fact as superseded. The binding writes a superseding
   * revision (or flags the row, depending on its runtime semantics).
   * Idempotent — superseding an already-superseded fact returns
   * `{ superseded: true }` without error. When the fact id is unknown,
   * returns `{ superseded: false }` and the route flips that to `404`.
   */
  supersedeFact(input: MemorySupersedeFactInput): Promise<MemorySupersedeFactOutcome>;
  /**
   * Cross-history retrieval. The `intent` mirrors the shape agents use
   * for declarative retrieval (`packages/agents/src/retrieval.ts`):
   *
   *   - `mode: 'list'`     — plain scoped list, no query needed.
   *   - `mode: 'keyword'`  — full-text keyword search.
   *   - `mode: 'semantic'` — vector cosine similarity. Requires an
   *     embedding registry in the binding; if absent, the binding
   *     MUST return `{ kind: 'embedding-unavailable' }` so the route
   *     can respond `400 bad-input`.
   *   - `mode: 'both'`     — keyword + semantic union, dedup by fact id.
   *
   * Semantic modes MAY accept `embeddingModel` on the intent to select
   * a specific registered provider; omit to fall back to the sole one.
   */
  retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveOutcome>;
}

// -------------------- list --------------------

export interface MemoryListFactsInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Exact match on `Fact.type`. Undefined = no type filter. */
  readonly type?: string;
  /**
   * Partial `MemoryScope` filter from the memory subsystem — the
   * flat-struct memory scope (tenantId + optional userId / orgId /
   * projectId / threadId / sessionId). Every provided key must match.
   */
  readonly scope?: Partial<MemoryScope>;
  /**
   * Narrow the list to a specific scope using the platform-wide
   * discriminated `Scope` primitive from `@kindgi/platform`.
   * Absent = no scope narrow (return every row in the tenant the
   * caller can see — admin/audit default).
   *
   * Content-scoped semantics (this binding — memory facts attribute
   * to the project via `Scope.projectId`):
   * - `{ kind: 'project', projectId }` — rows in that project.
   * - `{ kind: 'org', orgId }` — rows in every project belonging to
   *   that org.
   * - `{ kind: 'tenant', tenantId }` — every row in the tenant.
   *
   * Content rows always belong to a project, so `inherit` has no
   * effect here.
   *
   * The `scope` field above and `platformScope` are additive filters —
   * pass either, or both (AND-composed).
   */
  readonly platformScope?: PlatformScope;
  /**
   * `false` = literal-at-this-scope only (admin/audit view).
   * `true` (default) = inheritance walk (user-facing view).
   * No-op for content-scoped bindings (rows only exist at
   * project-level — there is no upward hierarchy to walk). Kept for
   * uniformity: scope-aware bindings share one filter shape.
   */
  readonly inherit?: boolean;
}

export interface MemoryFactPage {
  readonly data: readonly Fact[];
  readonly nextCursor?: Cursor;
}

// -------------------- get --------------------

export interface MemoryGetFactInput {
  readonly tenantId: TenantId;
  readonly factId: FactId;
}

// -------------------- write --------------------

export interface MemoryWriteFactInput {
  /**
   * The caller's tenant (from the token) — the tenant the fact is written
   * to. The route rejects a `scope.tenantId` that differs from it, and an
   * implementation must write under `tenantId`, never a tenant taken
   * from `scope`.
   */
  readonly tenantId: TenantId;
  readonly type: string;
  readonly scope: MemoryScope;
  readonly content: unknown;
  readonly retention?: Retention;
  readonly contentHash?: string;
}

export type MemoryWriteFactOutcome =
  | {
      readonly kind: 'ok';
      readonly fact: Fact;
    }
  | {
      /**
       * The type declared semantic indexing but the binding has no
       * embedding registry (or the registry resolves no provider).
       * Route maps to `400 bad-input`.
       */
      readonly kind: 'embedding-unavailable';
      readonly message: string;
    }
  | {
      /** Any other write failure — persistence error, invalid content, etc. */
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
    };

// -------------------- supersede --------------------

export interface MemorySupersedeFactInput {
  readonly tenantId: TenantId;
  readonly factId: FactId;
}

export interface MemorySupersedeFactOutcome {
  readonly superseded: boolean;
}

// -------------------- retrieve --------------------

/**
 * Retrieval intent shape used on the wire. Mirrors the agent-side
 * `RetrievalIntent` in `packages/agents/src/types.ts` but widened to
 * accept explicit filters + limits — the agent path derives filters
 * from `Conversation` context, while the direct-HTTP path takes them
 * verbatim from the request body.
 */
export interface MemoryRetrieveIntent {
  readonly mode: 'list' | 'keyword' | 'semantic' | 'both';
  /**
   * Freeform text query. Required for `keyword` / `semantic` / `both`;
   * ignored for `list`.
   */
  readonly query?: string;
  /**
   * Fact type filter. Passed through to the binding as a single-type
   * lookup; multi-type queries call `retrieve` per type today.
   */
  readonly type?: string;
  /** Partial scope predicate. */
  readonly scope?: Partial<MemoryScope>;
  readonly limit?: number;
  /** Selects a specific embedding provider registered on the binding. */
  readonly embeddingModel?: string;
}

export interface MemoryRetrieveInput {
  readonly tenantId: TenantId;
  readonly intent: MemoryRetrieveIntent;
}

export interface MemoryRetrievalHit {
  readonly fact: Fact;
  readonly score?: number;
}

export type MemoryRetrieveOutcome =
  | {
      readonly kind: 'ok';
      readonly results: readonly MemoryRetrievalHit[];
    }
  | {
      /** Semantic mode requested but no embedding provider bound. */
      readonly kind: 'embedding-unavailable';
      readonly message: string;
    }
  | {
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
    };
