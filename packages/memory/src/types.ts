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
  /**
   * An app's end user, by the app's own opaque id (as conversations and
   * judgments name them): a fact about or for one person who isn't a
   * Kindgi user. A participant's facts are private to that participant's
   * runs. Needs `projectId`: an app's end users belong to a project.
   */
  readonly participantId?: string;
}

/**
 * Who can see which facts: the containers a reader may read, worked out
 * by the server from the run or the caller (never from a request body),
 * and applied inside every query. A fact is readable when each container
 * its scope names is one the reader has: its project, org, user,
 * participant and thread (a fact naming none of them is tenant-wide, and
 * every reader in the tenant sees it). A missing field grants none.
 */
export interface MemoryReaders {
  /** Every fact in the tenant (a tenant admin). The other fields are then ignored. */
  readonly all?: true;
  /** Projects whose facts it reads. */
  readonly projectIds?: readonly ProjectId[];
  /** Orgs whose org-wide facts (no project) it reads: a run's project's org. */
  readonly orgIds?: readonly OrgId[];
  /** Kindgi users whose personal facts it reads. */
  readonly userIds?: readonly UserId[];
  /** End users (participants) whose facts it reads. */
  readonly participantIds?: readonly string[];
  /** Conversations whose thread facts it reads. */
  readonly threadIds?: readonly ThreadId[];
  /**
   * Projects where it reads every participant's and every thread's facts:
   * an app's own credential, acting for all of its end users.
   */
  readonly onBehalfOfProjectIds?: readonly ProjectId[];
}

/**
 * How far a fact is trusted. `verified`: a person with the right checked
 * it. `asserted`: an app or a person wrote it. `unverified`: an agent
 * remembered it during a conversation.
 */
export type FactTrust = 'verified' | 'asserted' | 'unverified';

/** Whom a fact is about: what access and erasure requests by person find. */
export interface FactSubject {
  readonly kind: 'participant' | 'user' | 'external';
  readonly id: string;
}

/** Who asserted a fact (PROV `wasAttributedTo`), set by the server from the writer. */
export interface FactAttribution {
  readonly kind: 'user' | 'service' | 'agent';
  readonly id: string;
  readonly agentVersion?: string;
}

/** The run step that wrote a fact (PROV `wasGeneratedBy`), for one an agent wrote. */
export interface FactGeneratedBy {
  readonly runId: string;
  readonly stepId?: string;
  readonly toolCallId?: string;
}

/** Why a revision stopped being current. */
export type FactInvalidationReason = 'superseded' | 'deleted' | 'erased' | 'expired';

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
  /**
   * The fact, across its revisions: superseding keeps it. (For a fact that
   * was never superseded it is also its one revision's id.)
   */
  readonly id: FactId;
  /** This revision's own id; absent where it equals `id`. */
  readonly revisionId?: string;
  /**
   * Fact type identifier. Packs define their own; a few general-purpose
   * names are conventional ('working-memory', 'user-profile', 'summary',
   * 'entity-index').
   */
  readonly type: string;
  readonly scope: MemoryScope;
  /** The revision number within the fact: 1, then one more per supersede or verify. */
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
  /** The revision this one replaced (PROV `wasRevisionOf`). */
  readonly supersedes?: FactId;
  /** How far it's trusted. Absent on facts from before trust was recorded: `asserted`. */
  readonly trust?: FactTrust;
  readonly verifiedBy?: string;
  readonly verifiedAt?: Timestamp;
  readonly attributedTo?: FactAttribution;
  readonly generatedBy?: FactGeneratedBy;
  readonly subjects?: readonly FactSubject[];
  /** When the fact is true in the world (application time); absent: always. */
  readonly validFrom?: Timestamp;
  readonly validUntil?: Timestamp;
  /** When it was said or seen. */
  readonly observedAt?: Timestamp;
  /** When this revision stopped being current (record time), by whom, and why; absent: current. */
  readonly invalidatedAt?: Timestamp;
  readonly invalidatedBy?: string;
  readonly invalidationReason?: FactInvalidationReason;
  /** `pending` while a person must approve it: a pending fact is never retrieved. */
  readonly review?: 'pending';
}
