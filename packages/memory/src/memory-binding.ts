// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EmbeddingProviderRegistry } from '@kindgi/embedding';
import type {
  Fact,
  LogEntry,
  LogKind,
  MemoryError,
  MemoryReaders,
  MemoryScope,
  RetrievalHit,
} from '@kindgi/memory';
import type { Result, RunId, TenantId } from '@kindgi/types';
import type { RecallHit, SearchConversationsInput } from './recall.js';

/**
 * Caller-plugged data-access surface for the memory subsystem. Agent
 * code routes its memory reads through this binding — @kindgi/agents
 * never touches a database client directly.
 *
 * The Kindgi runtime supplies a Postgres-backed implementation; any
 * object satisfying the interface works (tests, other stores). Agents
 * receive it as `InvokeAgentBindings.memoryBinding`.
 *
 * Contract notes:
 *   - Every method is tenant-scoped via `input.tenantId`. The binding
 *     implementation enforces tenant isolation; callers just supply the
 *     tenant id.
 *   - Provenance emission is internal to the implementation — the
 *     binding may record provenance events, but the public interface
 *     never accepts or returns a `ProvenanceBuilder`.
 */
export interface MemoryQueryBinding {
  /**
   * List facts filtered by tenant, type, and scope, capped by `limit`
   * (no pagination cursor): each fact's current revision, never one
   * pending review, and only what `readers` may see (the guard, applied
   * in the query before the limit).
   */
  listFacts<TContent = unknown>(
    input: ListFactsInput,
  ): Promise<Result<readonly Fact<TContent>[], MemoryError>>;

  /**
   * Full-text keyword search over facts. Tokenizer and ranking are
   * implementation-defined; the Kindgi runtime's Postgres implementation
   * ranks with `ts_rank_cd` and tokenizes English.
   */
  searchByKeyword<TContent = unknown>(
    input: SearchByKeywordInput,
  ): Promise<Result<readonly RetrievalHit<TContent>[], MemoryError>>;

  /**
   * Semantic-search facts via a caller-supplied `EmbeddingProviderRegistry`.
   * The registry resolves a provider (by model name or default) that
   * embeds the query; the impl runs the vector search.
   */
  searchBySemantic<TContent = unknown>(
    input: SearchBySemanticInput,
  ): Promise<Result<readonly RetrievalHit<TContent>[], MemoryError>>;

  /**
   * Recall messages of earlier conversations (a retrieval intent with
   * `source: 'conversations'`): what `readers` may recall
   * (`isRecallReadableBy`), narrowed by `selections`, newest first
   * (`list`), by full-text rank (`keyword`) or by meaning (`semantic`).
   * Never a comparison's replay conversation (an eval run's replay turn
   * opens one): its messages are no one's earlier conversation.
   * Optional: without it, such an intent recalls nothing and its turn
   * journals why. `semantic` without embeddings answers
   * `embedding-unavailable`, as fact search does.
   */
  searchConversations?(
    input: SearchConversationsInput,
  ): Promise<Result<readonly RecallHit[], MemoryError>>;

  /**
   * Append one entry to the run's hash-chained log. The implementation
   * assigns `sequence` and `prevHash` / `entryHash` atomically; the
   * returned `LogEntry` is the entry as stored.
   */
  appendLog(input: AppendLogInput): Promise<Result<LogEntry, MemoryError>>;

  /**
   * Read the log entries for `(tenantId, runId)` in `(sequence, timestamp)`
   * order. `sinceSequence` is an inclusive lower bound (entries with
   * `sequence >= sinceSequence`); to resume after a checkpoint, pass the
   * last seen sequence + 1.
   */
  readLog(input: ReadLogInput): Promise<Result<readonly LogEntry[], MemoryError>>;
}

export interface ListFactsInput {
  readonly tenantId: TenantId;
  readonly type?: string;
  /** Narrows within what `readers` may see: every given key must match. */
  readonly scope?: Partial<MemoryScope>;
  /**
   * What the reader may see (the scope guard), applied inside the query
   * before any limit. Absent: only tenant-wide facts.
   */
  readonly readers?: MemoryReaders;
  readonly limit?: number;
  /** Ignored: a list holds each fact's current revision. */
  readonly latestOnly?: boolean;
}

export interface SearchByKeywordInput {
  readonly tenantId: TenantId;
  readonly query: string;
  readonly type?: string;
  readonly scope?: Partial<MemoryScope>;
  /**
   * What the reader may see (the scope guard), applied inside the query
   * before any limit. Absent: only tenant-wide facts.
   */
  readonly readers?: MemoryReaders;
  readonly topK?: number;
}

export interface SearchBySemanticInput {
  readonly tenantId: TenantId;
  readonly query: string;
  readonly embeddingRegistry: EmbeddingProviderRegistry;
  /**
   * Which registered embedding model to use. Omit to fall back to the
   * registry's sole registered provider (errors if zero or ambiguous).
   */
  readonly embeddingModel?: string;
  readonly type?: string;
  readonly scope?: Partial<MemoryScope>;
  /**
   * What the reader may see (the scope guard), applied inside the query
   * before any limit. Absent: only tenant-wide facts.
   */
  readonly readers?: MemoryReaders;
  readonly topK?: number;
}

export interface AppendLogInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly kind: LogKind;
  readonly scope: MemoryScope;
  readonly actor?: string;
  readonly payload?: unknown;
  readonly causedByLogId?: string;
}

export interface ReadLogInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly sinceSequence?: number;
}
