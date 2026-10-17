// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn's retrievals see only what the run may (its project and org,
 * the user it acts for, its conversation and that conversation's end
 * user); the intent selects within that.
 */

import { describe, expect, test } from 'vitest';

import {
  type Fact,
  type ListFactsInput,
  type MemoryQueryBinding,
  type MemoryScope,
  type SearchByKeywordInput,
  isReadableBy,
} from '@kindgi/memory';
import type { FactId, OrgId, ProjectId, TenantId, ThreadId, Timestamp } from '@kindgi/types';

import { runMemoryReaders, runRetrievals } from '../src/index.js';
import type { Agent, Conversation, ConversationId, RetrievalIntent } from '../src/index.js';

const tenantId = 't-1' as TenantId;
const acme = 'p-acme' as ProjectId;
const globex = 'p-globex' as ProjectId;
const org = 'o-1' as OrgId;
const conversationId = 'c-1' as ConversationId;

const conversation = {
  id: conversationId,
  tenantId,
  projectId: acme,
  participantId: 'e-1',
  scope: { tenantId, projectId: acme },
} as unknown as Conversation;

const agent = (retrieval: readonly RetrievalIntent[]) => ({ retrieval }) as unknown as Agent;

function fact(name: string, scope: Partial<MemoryScope>): Fact {
  return {
    id: name as FactId,
    type: 'acme.note',
    scope: { tenantId, ...scope },
    version: 1,
    createdAt: '2026-10-07T00:00:00Z' as Timestamp,
    content: `${name} refund`,
  };
}

const FACTS: readonly Fact[] = [
  fact('tenant', {}),
  fact('org', { orgId: org }),
  fact('acme', { projectId: acme }),
  fact('globex', { projectId: globex }),
  fact('this-conversation', { projectId: acme, threadId: conversationId as unknown as ThreadId }),
  fact('other-conversation', { projectId: acme, threadId: 'c-2' as ThreadId }),
  fact('this-end-user', { projectId: acme, participantId: 'e-1' }),
  fact('other-end-user', { projectId: acme, participantId: 'e-2' }),
];

/** A memory that applies the guard, as a binding must, and records each read. */
function guardedMemory() {
  const reads: (ListFactsInput | SearchByKeywordInput)[] = [];
  const select = (input: ListFactsInput | SearchByKeywordInput) =>
    FACTS.filter(
      (f) =>
        isReadableBy(f.scope, input.readers ?? {}) &&
        Object.entries(input.scope ?? {}).every(
          ([k, v]) => (f.scope as unknown as Record<string, unknown>)[k] === v,
        ),
    );
  const memory = {
    async listFacts(input: ListFactsInput) {
      reads.push(input);
      return { kind: 'ok', value: select(input) };
    },
    async searchByKeyword(input: SearchByKeywordInput) {
      reads.push(input);
      return { kind: 'ok', value: select(input).map((f) => ({ fact: f, score: 1 })) };
    },
  } as unknown as MemoryQueryBinding;
  return { memory, reads };
}

async function retrieved(intent: RetrievalIntent, run = {}) {
  const { memory, reads } = guardedMemory();
  const out = await runRetrievals(
    agent([intent]),
    conversation,
    conversationId,
    'refund',
    { memory },
    run,
  );
  if (out.kind !== 'ok') throw new Error(out.error.message);
  return { names: out.value.map((r) => r.fact.id as unknown as string).sort(), reads };
}

describe('retrieval readers', () => {
  test("the run's readers: its project, org, user, end user and conversation", () => {
    expect(
      runMemoryReaders(conversation, conversationId, {
        projectId: acme,
        orgId: org,
        userId: 'u-1' as never,
      }),
    ).toEqual({
      projectIds: [acme],
      orgIds: [org],
      userIds: ['u-1'],
      participantIds: ['e-1'],
      threadIds: [conversationId],
    });
  });

  test.each([
    ['list', undefined],
    ['keyword', 'keyword'],
  ] as const)(
    'a tenant intent (%s) never reaches another project, conversation or end user',
    async (_mode, mode) => {
      const { names, reads } = await retrieved(
        { types: ['acme.note'], scope: 'tenant', limit: 50, ...(mode !== undefined && { mode }) },
        { projectId: acme, orgId: org },
      );
      expect(names).toEqual(['acme', 'org', 'tenant', 'this-conversation', 'this-end-user']);
      expect(reads[0]?.readers?.threadIds).toEqual([conversationId]);
    },
  );

  test('same-conversation selects this conversation within the guard', async () => {
    const { names } = await retrieved({ types: ['acme.note'], scope: 'same-conversation' });
    expect(names).toEqual(['this-conversation']);
  });

  test('same-project selects the run project; a run without one gets nothing', async () => {
    const { names } = await retrieved({ types: ['acme.note'], scope: 'same-project', limit: 50 });
    expect(names).toEqual(['acme', 'this-conversation', 'this-end-user']);
    const noProject = {
      ...conversation,
      projectId: undefined,
      scope: { tenantId },
    } as unknown as Conversation;
    const { memory, reads } = guardedMemory();
    const out = await runRetrievals(
      agent([{ types: ['acme.note'], scope: 'same-project' }]),
      noProject,
      conversationId,
      'refund',
      { memory },
    );
    expect(out).toEqual({ kind: 'ok', value: [] });
    expect(reads).toEqual([]);
  });
});
