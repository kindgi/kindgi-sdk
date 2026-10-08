// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EmbeddingProviderRegistry } from '@kindgi/embedding';
import type { Fact, MemoryQueryBinding, MemoryReaders, RetrievalHit } from '@kindgi/memory';
import type { OrgId, ProjectId, Result, TenantId, ThreadId, UserId } from '@kindgi/types';

import type { AgentError, PersistenceError } from './errors.js';
import type {
  Agent,
  Conversation,
  ConversationId,
  RetrievalIntent,
  RetrievedFact,
} from './types.js';

/** Bindings the retrieval flow consumes. `memory` is required; the
 * rest are optional — without an embedding registry, the semantic
 * part of an intent is silently skipped. `embeddingModel` picks a
 * specific registered provider; omit to fall back to the registry's
 * sole provider. */
export interface RetrievalBindings {
  /**
   * Caller-plugged data-access surface for memory reads. Every listFacts /
   * searchByKeyword / searchBySemantic call inside `runRetrievals` routes
   * through this binding — the runtime never touches a database client directly.
   */
  readonly memory: MemoryQueryBinding;
  readonly embeddingRegistry?: EmbeddingProviderRegistry;
  readonly embeddingModel?: string;
}

/**
 * Who a turn runs as, for what its retrievals may see. Absent fields come
 * from the conversation (its project, end user and scope).
 */
export interface RetrievalRun {
  /** The run's project. */
  readonly projectId?: ProjectId;
  /** The org of the run's project. */
  readonly orgId?: OrgId;
  /** The Kindgi user the run acts for, when it acts for one. */
  readonly userId?: UserId;
  /** The turn's end user (the app's own id for them), when the conversation names none. */
  readonly participantId?: string;
}

/**
 * What a turn may see in memory (the scope guard), from the run, never
 * from the model or the intent: tenant-wide facts, its project's and its
 * org's, the user it acts for, its conversation's end user, and its own
 * conversation. Another conversation's or another end user's facts are
 * never visible, whatever an intent asks for.
 */
export function runMemoryReaders(
  conversation: Conversation,
  conversationId: ConversationId,
  run: RetrievalRun = {},
): MemoryReaders {
  const projectId = runProjectId(conversation, run);
  const orgId = run.orgId ?? conversation.scope.orgId;
  const userId = run.userId;
  // The conversation's end user is the one it was opened for.
  const participantId = conversation.participantId ?? run.participantId;
  return {
    ...(projectId !== undefined && { projectIds: [projectId] }),
    ...(orgId !== undefined && { orgIds: [orgId] }),
    ...(userId !== undefined && { userIds: [userId] }),
    ...(participantId !== undefined && { participantIds: [participantId] }),
    threadIds: [conversationId as unknown as ThreadId],
  };
}

/**
 * Execute every retrieval intent declared on the agent against the
 * current conversation's scope. Each one sees only what the run may
 * (`runMemoryReaders`); the intent's scope selects within that. Returns retrieved facts paired with
 * the intent that pulled them, so downstream provenance can attribute
 * each fact to its retrieval declaration.
 *
 * Retrieval modes:
 *   - `mode: 'keyword'`  — `searchByKeyword` with the user's message
 *     as the query (full-text search in the memory implementation).
 *   - `mode: 'semantic'` — `searchBySemantic` with the user's message
 *     embedded. Requires `bindings.embeddingRegistry`; without one,
 *     the semantic search is silently skipped.
 *   - `mode: 'both'`     — run both, merge results, dedup by fact id
 *     with keyword score preserved.
 *   - `mode` omitted     — `listFacts` scoped + typed, latest-first.
 *     No query needed; useful for "always pull the current
 *     working-memory snapshot."
 */
export async function runRetrievals(
  agent: Agent,
  conversation: Conversation,
  conversationId: ConversationId,
  userMessage: string,
  bindings: RetrievalBindings,
  run: RetrievalRun = {},
): Promise<Result<readonly RetrievedFact[], AgentError>> {
  const out: RetrievedFact[] = [];
  if (agent.retrieval.length === 0) return { kind: 'ok', value: out };
  const readers = runMemoryReaders(conversation, conversationId, run);
  for (const intent of agent.retrieval) {
    const scope = scopeFilter(intent, conversation, conversationId, run);
    // `same-project` in a run without a project selects nothing.
    if (scope === null) continue;
    for (const type of intent.types) {
      const one = await runOneIntent(
        conversation.tenantId,
        userMessage,
        intent,
        type,
        scope,
        readers,
        bindings,
      );
      if (one.kind === 'err') return one;
      out.push(...one.value);
    }
  }
  return { kind: 'ok', value: out };
}

/**
 * Format retrieved facts as a system-role message the model can read
 * as background context. Kept structural (fact headers + JSON content)
 * rather than freeform prose — models handle discriminable fact
 * boundaries better than blended narrative.
 */
export function formatRetrievedForPrompt(facts: readonly RetrievedFact[]): string {
  if (facts.length === 0) return '';
  const parts: string[] = ['[Retrieved context — background facts for this turn]', ''];
  for (const { fact, intent, score } of facts) {
    const header = `## Fact type=${fact.type} id=${fact.id} version=${fact.version}${score !== undefined ? ` score=${score.toFixed(3)}` : ''} scope=${intent.scope}`;
    parts.push(header);
    parts.push(stringifyContent(fact.content));
    parts.push('');
  }
  return parts.join('\n').trim();
}

// ============ internals ============

async function runOneIntent(
  tenantId: TenantId,
  userMessage: string,
  intent: RetrievalIntent,
  type: string,
  scope: Partial<import('@kindgi/memory').MemoryScope> | undefined,
  readers: MemoryReaders,
  bindings: RetrievalBindings,
): Promise<Result<readonly RetrievedFact[], PersistenceError>> {
  const limit = intent.limit ?? 10;

  if (intent.mode === undefined) {
    return await listMode(bindings.memory, tenantId, type, scope, readers, limit, intent);
  }

  const doKeyword = intent.mode === 'keyword' || intent.mode === 'both';
  const doSemantic =
    (intent.mode === 'semantic' || intent.mode === 'both') &&
    bindings.embeddingRegistry !== undefined;

  const results: RetrievedFact[] = [];
  if (doKeyword) {
    const kw = await bindings.memory.searchByKeyword({
      tenantId,
      query: userMessage,
      type,
      ...(scope !== undefined && { scope }),
      readers,
      topK: limit,
    });
    if (kw.kind === 'err') return persistErr('runOneIntent.keyword', kw.error);
    results.push(...kw.value.map((h) => hitToRetrieved(h, intent)));
  }
  if (doSemantic && bindings.embeddingRegistry !== undefined) {
    const sem = await bindings.memory.searchBySemantic({
      tenantId,
      query: userMessage,
      embeddingRegistry: bindings.embeddingRegistry,
      ...(bindings.embeddingModel !== undefined && { embeddingModel: bindings.embeddingModel }),
      type,
      ...(scope !== undefined && { scope }),
      readers,
      topK: limit,
    });
    if (sem.kind === 'err') return persistErr('runOneIntent.semantic', sem.error);
    results.push(...sem.value.map((h) => hitToRetrieved(h, intent)));
  }
  return { kind: 'ok', value: dedupById(results).slice(0, limit) };
}

async function listMode(
  memory: MemoryQueryBinding,
  tenantId: TenantId,
  type: string,
  scope: Partial<import('@kindgi/memory').MemoryScope> | undefined,
  readers: MemoryReaders,
  limit: number,
  intent: RetrievalIntent,
): Promise<Result<readonly RetrievedFact[], PersistenceError>> {
  const listed = await memory.listFacts({
    tenantId,
    type,
    ...(scope !== undefined && { scope }),
    readers,
    limit,
  });
  if (listed.kind === 'err') return persistErr('runOneIntent.list', listed.error);
  return {
    kind: 'ok',
    value: listed.value.map((f) => ({ fact: f as Fact<unknown>, intent })),
  };
}

function runProjectId(conversation: Conversation, run: RetrievalRun): ProjectId | undefined {
  return run.projectId ?? conversation.projectId ?? conversation.scope.projectId;
}

/**
 * What an intent selects within what the run may see: `undefined` for
 * no narrowing, `null` for nothing.
 */
function scopeFilter(
  intent: RetrievalIntent,
  conversation: Conversation,
  conversationId: ConversationId,
  run: RetrievalRun,
): Partial<import('@kindgi/memory').MemoryScope> | undefined | null {
  if (intent.scope === 'same-conversation') {
    return { threadId: conversationId as unknown as ThreadId };
  }
  if (intent.scope === 'same-project') {
    const projectId = runProjectId(conversation, run);
    return projectId === undefined ? null : { projectId };
  }
  return undefined;
}

function hitToRetrieved(hit: RetrievalHit<unknown>, intent: RetrievalIntent): RetrievedFact {
  return {
    fact: hit.fact,
    intent,
    score: hit.score,
  };
}

function dedupById(facts: readonly RetrievedFact[]): readonly RetrievedFact[] {
  const seen = new Set<string>();
  const out: RetrievedFact[] = [];
  for (const f of facts) {
    if (seen.has(f.fact.id)) continue;
    seen.add(f.fact.id);
    out.push(f);
  }
  return out;
}

function stringifyContent(content: unknown): string {
  if (content === undefined) return '(no content)';
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

function persistErr(step: string, cause: unknown): Result<never, PersistenceError> {
  return {
    kind: 'err',
    error: {
      code: 'persistence-error',
      message: `Agents operation "${step}" failed`,
      cause,
    },
  };
}
