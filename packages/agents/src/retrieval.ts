// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EmbeddingProviderRegistry } from '@kindgi/embedding';
import type { Fact, MemoryQueryBinding, RetrievalHit } from '@kindgi/memory';
import type { ProjectId, Result, TenantId, ThreadId } from '@kindgi/types';

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
 * Execute every retrieval intent declared on the agent against the
 * current conversation's scope. Returns retrieved facts paired with
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
): Promise<Result<readonly RetrievedFact[], AgentError>> {
  const out: RetrievedFact[] = [];
  for (const intent of agent.retrieval) {
    for (const type of intent.types) {
      const one = await runOneIntent(
        conversation,
        conversationId,
        userMessage,
        intent,
        type,
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
  conversation: Conversation,
  conversationId: ConversationId,
  userMessage: string,
  intent: RetrievalIntent,
  type: string,
  bindings: RetrievalBindings,
): Promise<Result<readonly RetrievedFact[], PersistenceError>> {
  const limit = intent.limit ?? 10;
  const tenantId = conversation.tenantId;
  const scope = scopeFilter(intent, conversation, conversationId);

  if (intent.mode === undefined) {
    return await listMode(bindings.memory, tenantId, type, scope, limit, intent);
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
  limit: number,
  intent: RetrievalIntent,
): Promise<Result<readonly RetrievedFact[], PersistenceError>> {
  const listed = await memory.listFacts({
    tenantId,
    type,
    ...(scope !== undefined && { scope }),
    limit,
    latestOnly: true,
  });
  if (listed.kind === 'err') return persistErr('runOneIntent.list', listed.error);
  return {
    kind: 'ok',
    value: listed.value.map((f) => ({ fact: f as Fact<unknown>, intent })),
  };
}

function scopeFilter(
  intent: RetrievalIntent,
  conversation: Conversation,
  conversationId: ConversationId,
): Partial<import('@kindgi/memory').MemoryScope> | undefined {
  if (intent.scope === 'same-conversation') {
    return { threadId: conversationId as unknown as ThreadId };
  }
  if (intent.scope === 'same-project') {
    const projectId = conversation.scope.projectId;
    // If the conversation has no project scope, treat as tenant-wide
    // rather than empty-result — the intent still applies conceptually.
    if (projectId === undefined) return undefined;
    return { projectId: projectId as ProjectId };
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
