// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An in-memory `MemoryBinding` with the contract's semantics, for route
 * tests: a fact keeps its id across revisions; reads see current
 * revisions the readers may see (`isReadableBy`, the guard as the
 * runtime's SQL applies it); supersede, delete and verify close the current
 * revision; `expectVersion` and legal hold refuse.
 */

import { type Fact, type MemoryReaders, type MemoryScope, isReadableBy } from '@kindgi/memory';
import type { Cursor, FactId, Timestamp } from '@kindgi/types';

import type {
  MemoryBinding,
  MemoryFactChangeOutcome,
  MemoryListFactsInput,
} from '../../src/index.js';

/** The scope guard, as the runtime's SQL applies it. */
export const readable = isReadableBy;

export interface InMemoryMemory {
  readonly binding: MemoryBinding;
  /** Every revision stored, oldest first. */
  readonly rows: Fact[];
  /** The readers each call got, newest last. */
  readonly readersSeen: MemoryReaders[];
  /** The last list input. */
  lastList?: MemoryListFactsInput;
}

export function inMemoryMemory(
  options: { readonly hasEmbeddings?: boolean; readonly now?: () => Date } = {},
): InMemoryMemory {
  const rows: Fact[] = [];
  const readersSeen: MemoryReaders[] = [];
  const now = options.now ?? (() => new Date());
  let seq = 0;
  const nextId = () => `fact-${String(++seq).padStart(4, '0')}` as unknown as FactId;
  const at = () => now().toISOString() as Timestamp;

  const revisions = (factId: FactId) =>
    rows.filter((r) => r.id === factId).sort((a, b) => b.version - a.version);
  const current = (factId: FactId) =>
    revisions(factId).find((r) => r.invalidatedAt === undefined && r.review === undefined);
  const visible = (f: Fact | undefined, readers: MemoryReaders) =>
    f !== undefined && readable(f.scope, readers) ? f : undefined;
  const currentAt = (factId: FactId, asOf: string) =>
    revisions(factId).find(
      (r) => r.createdAt <= asOf && (r.invalidatedAt === undefined || r.invalidatedAt > asOf),
    );

  /** Close the current revision and add `next` (if any), as one change. */
  function change(
    input: { factId: FactId; readers: MemoryReaders; expectVersion?: number },
    next: ((cur: Fact) => Fact) | undefined,
    reason: 'superseded' | 'deleted',
    by: string,
  ): MemoryFactChangeOutcome {
    readersSeen.push(input.readers);
    const cur = visible(current(input.factId), input.readers);
    if (cur === undefined) return { kind: 'not-found' };
    if (input.expectVersion !== undefined && input.expectVersion !== cur.version) {
      return { kind: 'fact-changed', current: cur };
    }
    if (cur.retention?.legalHold === true) {
      return {
        kind: 'legal-hold',
        message: `Fact "${cur.id as unknown as string}" is under legal hold.`,
      };
    }
    const closed: Fact = {
      ...cur,
      invalidatedAt: at(),
      invalidatedBy: by,
      invalidationReason: reason,
    };
    rows[rows.indexOf(cur)] = closed;
    if (next === undefined) return { kind: 'ok', fact: closed };
    const added = next(cur);
    rows.push(added);
    return { kind: 'ok', fact: added };
  }

  const binding: MemoryBinding = {
    async listFacts(input) {
      readersSeen.push(input.readers);
      state.lastList = input;
      const ids = [...new Set(rows.map((r) => r.id))];
      const facts = ids
        .map((id) => (input.asOf !== undefined ? currentAt(id, input.asOf) : current(id)))
        .filter((f): f is Fact => f !== undefined && readable(f.scope, input.readers))
        .filter((f) => input.type === undefined || f.type === input.type)
        .filter((f) => input.scope === undefined || scopeMatches(f.scope, input.scope))
        .sort((a, b) => (a.id as unknown as string).localeCompare(b.id as unknown as string));
      return paginate(facts, input.limit, input.cursor);
    },
    async getFact(input) {
      readersSeen.push(input.readers);
      const found =
        input.version !== undefined
          ? revisions(input.factId).find((r) => r.version === input.version)
          : input.asOf !== undefined
            ? currentAt(input.factId, input.asOf)
            : current(input.factId);
      return visible(found, input.readers) ?? null;
    },
    async listRevisions(input) {
      readersSeen.push(input.readers);
      const all = revisions(input.factId);
      const first = all[0];
      return first !== undefined && readable(first.scope, input.readers) ? all : null;
    },
    async writeFact(input) {
      if (input.type === 'semantic-only' && options.hasEmbeddings !== true) {
        return {
          kind: 'embedding-unavailable',
          message:
            'Type "semantic-only" declares semantic indexing but no embedding registry is bound',
        };
      }
      const fact: Fact = {
        id: nextId(),
        type: input.type,
        scope: input.scope,
        version: 1,
        createdAt: at(),
        content: input.content,
        trust: 'asserted',
        ...(input.retention !== undefined && { retention: input.retention }),
        ...(input.contentHash !== undefined && { contentHash: input.contentHash }),
        ...(input.attributedTo !== undefined && { attributedTo: input.attributedTo }),
        ...(input.subjects !== undefined && { subjects: input.subjects }),
        ...(input.validFrom !== undefined && { validFrom: input.validFrom }),
        ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
        ...(input.observedAt !== undefined && { observedAt: input.observedAt }),
      };
      rows.push(fact);
      return { kind: 'ok', fact };
    },
    async supersedeFact(input) {
      return change(
        input,
        (cur) => ({
          ...carriedOver(cur),
          revisionId: `${cur.id as unknown as string}@${cur.version + 1}`,
          version: cur.version + 1,
          supersedes: revisionOf(cur),
          createdAt: at(),
          content: input.content,
          trust: 'asserted',
          ...(input.retention !== undefined && { retention: input.retention }),
          ...(input.subjects !== undefined && { subjects: input.subjects }),
          ...(input.validFrom !== undefined && { validFrom: input.validFrom }),
          ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
          ...(input.observedAt !== undefined && { observedAt: input.observedAt }),
          ...(input.attributedTo !== undefined && { attributedTo: input.attributedTo }),
        }),
        'superseded',
        input.attributedTo !== undefined
          ? `${input.attributedTo.kind}:${input.attributedTo.id}`
          : 'service:unknown',
      );
    },
    async deleteFact(input) {
      return change(input, undefined, 'deleted', input.by);
    },
    async verifyFact(input) {
      return change(
        input,
        (cur) => ({
          ...carriedOver(cur),
          revisionId: `${cur.id as unknown as string}@${cur.version + 1}`,
          version: cur.version + 1,
          supersedes: revisionOf(cur),
          createdAt: at(),
          ...(cur.attributedTo !== undefined && { attributedTo: cur.attributedTo }),
          ...(cur.generatedBy !== undefined && { generatedBy: cur.generatedBy }),
          trust: 'verified',
          verifiedBy: input.by,
          verifiedAt: at(),
        }),
        'superseded',
        input.by,
      );
    },
    async retrieve(input) {
      readersSeen.push(input.readers);
      const { intent } = input;
      if (
        (intent.mode === 'semantic' || intent.mode === 'both') &&
        options.hasEmbeddings !== true
      ) {
        return { kind: 'embedding-unavailable', message: 'No embedding registry is bound' };
      }
      const ids = [...new Set(rows.map((r) => r.id))];
      const facts = ids
        .map((id) => current(id))
        .filter((f): f is Fact => f !== undefined && readable(f.scope, input.readers))
        .filter((f) => intent.type === undefined || f.type === intent.type)
        .filter((f) => intent.scope === undefined || scopeMatches(f.scope, intent.scope));
      const limit = intent.limit ?? facts.length;
      if (intent.mode === 'list') {
        return { kind: 'ok', results: facts.slice(0, limit).map((fact) => ({ fact })) };
      }
      const q = (intent.query ?? '').toLowerCase();
      const hits = facts
        .filter((f) =>
          JSON.stringify(f.content ?? '')
            .toLowerCase()
            .includes(q),
        )
        .map((fact) => ({ fact, score: 1 }))
        .slice(0, limit);
      return { kind: 'ok', results: hits };
    },
  };
  const state: InMemoryMemory = { binding, rows, readersSeen };
  return state;
}

/** What a fact's next revision keeps: its content, scope and times, not who wrote or checked it. */
function carriedOver(f: Fact): Fact {
  const {
    invalidatedAt: _a,
    invalidatedBy: _b,
    invalidationReason: _c,
    verifiedBy: _d,
    verifiedAt: _e,
    attributedTo: _f,
    generatedBy: _g,
    revisionId: _h,
    ...rest
  } = f;
  return rest;
}

/** The revision's own id, as `supersedes` names it. */
function revisionOf(f: Fact): FactId {
  return (f.revisionId ?? f.id) as FactId;
}

function scopeMatches(actual: MemoryScope, wanted: Partial<MemoryScope>): boolean {
  const a = actual as unknown as Readonly<Record<string, unknown>>;
  return Object.entries(wanted).every(([k, v]) => v === undefined || a[k] === v);
}

function paginate(
  facts: readonly Fact[],
  limit: number,
  cursor: Cursor | undefined,
): { data: readonly Fact[]; nextCursor?: Cursor } {
  let start = 0;
  if (cursor !== undefined) {
    start = facts.findIndex((f) => (f.id as unknown as string) > (cursor as unknown as string));
    if (start < 0) start = facts.length;
  }
  const slice = facts.slice(start, start + limit);
  const last = slice.at(-1);
  return {
    data: slice,
    ...(start + slice.length < facts.length &&
      last !== undefined && { nextCursor: last.id as unknown as Cursor }),
  };
}
