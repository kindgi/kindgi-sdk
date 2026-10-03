// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  FactId,
  OrgId,
  ProjectId,
  SessionId,
  TenantId,
  ThreadId,
  Timestamp,
  UserId,
} from '@kindgi/types';

/**
 * Every memory item is scoped. Reads and writes present a scope; the
 * policy engine denies out-of-scope operations at the boundary.
 *
 * Exported as `MemoryScope` (not `Scope`) to disambiguate from
 * `@kindgi/platform`'s `Scope` — a discriminated union describing org
 * hierarchy position, distinct from memory's user/thread address.
 */
export interface MemoryScope {
  readonly tenantId: TenantId;
  readonly userId?: UserId;
  readonly orgId?: OrgId;
  /**
   * Project scope — whatever unit of work a pack organizes its memory
   * around; the memory layer stays neutral about what it represents.
   */
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly sessionId?: SessionId;
}

/**
 * Retention override at the fact level. Tenant policy sets defaults; a
 * fact-level override wins if present.
 */
export interface Retention {
  readonly keepUntil?: Timestamp;
  readonly keepDays?: number;
  readonly legalHold?: boolean;
}

/**
 * External source of a Kind-B (cached-view) fact. Absent for Kind-A
 * (immutable historical) facts.
 */
export interface Source {
  readonly kind: 'http-api' | 'blob' | 'mcp-tool' | 'external-db' | 'user-input';
  readonly uri?: string;
  readonly freshness: SourceFreshness;
  readonly refresh: SourceRefresh;
}

export interface SourceFreshness {
  readonly ttlSeconds?: number;
  readonly lastVerifiedAt?: Timestamp;
  readonly etag?: string;
  readonly sourceVersion?: string;
}

export interface SourceRefresh {
  /**
   * `on-read` = reader triggers a refresh check before returning stale.
   * `background` = a scheduled run walks stale facts and refreshes them.
   * `manual` = only refresh when explicitly invoked.
   */
  readonly strategy: 'on-read' | 'background' | 'manual';
  /**
   * Registered refresh-handler id, resolved by the memory implementation
   * (`refresh-handler-missing` when it does not resolve).
   */
  readonly handler?: string;
  readonly priority?: number;
}

/**
 * A typed, versioned record. Two flavors expressible via the same shape:
 *   - Kind A (immutable output) — no `source` block.
 *   - Kind B (cached view of external state) — has a `source` block.
 *
 * Retrieval strategy (which indexes populate for this `type`) is
 * configured once per type in the memory implementation. There is no
 * per-fact retrieval hint.
 */
export interface Fact<TContent = unknown> {
  readonly id: FactId;
  /**
   * Fact type identifier. Packs define their own; a few general-purpose
   * names are conventional ('working-memory', 'user-profile', 'summary',
   * 'entity-index').
   */
  readonly type: string;
  readonly scope: MemoryScope;
  /** Monotonic version within `(scope, id)`. Supersession increments. */
  readonly version: number;
  readonly createdAt: Timestamp;
  readonly updatedAt?: Timestamp;
  readonly content?: TContent;
  /**
   * `blob://<provider>/<bucket>/<key>` when the payload is stored externally.
   * `content` may still hold a summary / fingerprint for cheap retrieval scoring.
   */
  readonly contentRef?: string;
  readonly contentHash?: string;
  readonly size?: number;
  readonly embeddingModel?: string;
  readonly retention?: Retention;
  readonly source?: Source;
  readonly causedByLogId?: readonly string[];
  readonly supersedes?: FactId;
}
