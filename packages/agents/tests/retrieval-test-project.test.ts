// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run in a person's own test project (`projectIsTest`) recalls only
 * what's in its project: its readers carry `projectFactsOnly`, so no fact
 * without a project reaches it, workspace-wide or its org's. The turn's
 * retrieval step passes the run's flag on; a run elsewhere reads as before.
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
import type { FactId, OrgId, ProjectId, RunId, TenantId, ThreadId, Timestamp } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import { buildRunRetrievalsHandler } from '../src/handlers/run-retrievals.js';
import { runMemoryReaders, runRetrievals } from '../src/index.js';
import type { Agent, Conversation, ConversationId, RetrievalIntent } from '../src/index.js';
import { testNodeContext } from './node-context.js';

const tenantId = 't-1' as TenantId;
const mine = 'p-mine' as ProjectId;
const other = 'p-other' as ProjectId;
const org = 'o-1' as OrgId;
const conversationId = 'c-1' as ConversationId;

const conversation = {
  id: conversationId,
  tenantId,
  projectId: mine,
  participantId: 'e-1',
  scope: { tenantId, projectId: mine },
} as unknown as Conversation;

const agent = (retrieval: readonly RetrievalIntent[]) => ({ retrieval }) as unknown as Agent;

function fact(name: string, scope: Partial<MemoryScope>): Fact {
  return {
    id: name as FactId,
    type: 'acme.note',
    scope: { tenantId, ...scope },
    version: 1,
    createdAt: '2026-11-07T00:00:00Z' as Timestamp,
    content: `${name} refund`,
  };
}

const FACTS: readonly Fact[] = [
  fact('tenant', {}),
  fact('org', { orgId: org }),
  fact('my-user', { userId: 'u-1' as never }),
  fact('mine', { projectId: mine }),
  fact('other', { projectId: other }),
  fact('this-conversation', { projectId: mine, threadId: conversationId as unknown as ThreadId }),
  fact('this-end-user', { projectId: mine, participantId: 'e-1' }),
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

const tenantIntent: RetrievalIntent = { types: ['acme.note'], scope: 'tenant', limit: 50 };

async function retrieved(intent: RetrievalIntent, run: { readonly projectIsTest?: boolean }) {
  const { memory } = guardedMemory();
  const out = await runRetrievals(
    agent([intent]),
    conversation,
    conversationId,
    'refund',
    { memory },
    {
      projectId: mine,
      orgId: org,
      userId: 'u-1' as never,
      ...run,
    },
  );
  if (out.kind !== 'ok') throw new Error(out.error.message);
  return out.value.map((r) => r.fact.id as unknown as string).sort();
}

describe("a test project's run recalls only its project", () => {
  test('its readers carry projectFactsOnly; a run elsewhere has none', () => {
    const run = { projectId: mine, orgId: org };
    expect(
      runMemoryReaders(conversation, conversationId, { ...run, projectIsTest: true }),
    ).toMatchObject({ projectIds: [mine], projectFactsOnly: true });
    expect(runMemoryReaders(conversation, conversationId, run)).not.toHaveProperty(
      'projectFactsOnly',
    );
    expect(
      runMemoryReaders(conversation, conversationId, { ...run, projectIsTest: false }),
    ).not.toHaveProperty('projectFactsOnly');
  });

  test.each([
    ['list', tenantIntent],
    ['keyword', { ...tenantIntent, mode: 'keyword' }],
    ['same-project', { types: ['acme.note'], scope: 'same-project', limit: 50 }],
  ] as const)(
    '%s: no workspace-wide, org or user fact without a project',
    async (_name, intent) => {
      expect(await retrieved(intent, { projectIsTest: true })).toEqual([
        'mine',
        'this-conversation',
        'this-end-user',
      ]);
    },
  );

  test('a run elsewhere still reads workspace-wide, org and user facts', async () => {
    expect(await retrieved(tenantIntent, {})).toEqual([
      'mine',
      'my-user',
      'org',
      'tenant',
      'this-conversation',
      'this-end-user',
    ]);
  });

  test.each([
    [true, true],
    [undefined, undefined],
  ] as const)(
    "the turn's retrieval step passes the run's projectIsTest (%s) to its reads",
    async (projectIsTest, expected) => {
      const { memory, reads } = guardedMemory();
      const ctx = {
        input: {
          tenantId,
          projectId: mine,
          orgId: org,
          conversationId,
          userMessage: 'refund',
          agent: { id: 'pack.agent', version: '1.0.0', retrieval: [tenantIntent] },
          ...(projectIsTest !== undefined && { projectIsTest }),
        },
        bindings: { memoryBinding: memory },
        conversation,
        userMessage: { sequence: 1, role: 'user', content: 'refund' },
        appended: [],
      } as unknown as TurnContext;
      const out = (await buildRunRetrievalsHandler(ctx)(
        undefined,
        testNodeContext({ runId: 'run-1' as RunId }),
      )) as { retrieved: readonly { fact: Fact }[] };
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) expect(read.readers?.projectFactsOnly).toBe(expected);
      const names = out.retrieved.map((r) => r.fact.id as unknown as string);
      expect(names.includes('tenant')).toBe(expected !== true);
    },
  );
});
