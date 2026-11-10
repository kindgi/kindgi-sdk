// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs?include=waitingFor`: each suspended run on the page says
 * what it waits for, as `GET /v1/runs/{runId}` says it. Only suspended runs
 * have their waits read, at most five at once, and a page that carries
 * them holds at most 25 runs.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { JournalEntry, KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import type { Approval, HitlBinding } from '../src/hitl-binding.js';
import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'runs-list-waiting-for';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const at = '2026-11-04T06:00:00.000Z';

function row(status: string): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId,
    flowId: 'agent.turn',
    flowVersion: '1.0.0',
    status,
    input: {},
    dryRun: false,
    createdAt: at as Timestamp,
    updatedAt: at as Timestamp,
  } as KernelRunRecord;
}

/** Each suspended run waits on one wait of its own, `tok-<runId>`. */
const tokenOf = (runId: string) => `tok-${runId}`;

/** The approval a hand-off's call waits on, linked to that wait. */
function handOff(runId: string): Approval {
  return {
    id: randomUUID(),
    tenantId,
    subjectKind: 'tool-call:pending',
    subjectRef: {
      conversationId: randomUUID(),
      agentId: 'acme-desk.support-desk',
      agentVersion: '1.0.0',
      toolId: 'acme-desk.support-desk.hand-off',
      toolVersion: '1.0.0',
      callId: 'call_1',
      argsHash: 'sha256:x',
      arguments: { why: 'The order is not in the store' },
    },
    requiredRole: 'approver',
    status: 'pending',
    title: 'HITL review: hand-off',
    waitTokenId: tokenOf(runId),
    createdAt: at,
    updatedAt: at,
  } as unknown as Approval;
}

function harness(
  rows: readonly KernelRunRecord[],
  broken: { readonly unreadable?: readonly string[]; readonly throwing?: readonly string[] } = {},
) {
  const listCalls: ListRunsInput[] = [];
  const journalReads: string[] = [];
  let reading = 0;
  let mostAtOnce = 0;
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) => rows.find((r) => r.runId === id) ?? null,
    // A store that keeps to `limit`, with a next page when there are more.
    listRuns: async (input: ListRunsInput) => {
      listCalls.push(input);
      const data = rows.slice(0, input.limit);
      return { data, ...(data.length < rows.length && { nextCursor: 'next-page' }) };
    },
    // Each read takes a moment, so reads that may overlap do.
    readJournal: async (_t: TenantId, id: RunId) => {
      journalReads.push(id);
      reading += 1;
      mostAtOnce = Math.max(mostAtOnce, reading);
      await new Promise((resolve) => setTimeout(resolve, 5));
      reading -= 1;
      if (broken.throwing?.includes(id)) throw new Error('the store is down');
      if (broken.unreadable?.includes(id)) {
        return { kind: 'err', error: { code: 'journal-error', message: 'x' } };
      }
      const entry = {
        sequence: 1,
        kind: 'wait.suspended',
        payload: { tokenId: tokenOf(id) },
        timestamp: at,
      } as unknown as JournalEntry;
      return { kind: 'ok', value: [entry] };
    },
  } as unknown as RunBinding;
  const approvals = rows.map((r) => handOff(r.runId));
  const hitlBinding = {
    listApprovals: async () => ({ kind: 'ok', value: { approvals } }),
  } as unknown as HitlBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    hitlBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { get, listCalls, journalReads, mostAtOnce: () => mostAtOnce };
}

describe('GET /v1/runs?include=waitingFor', () => {
  test('a suspended run carries what GET /v1/runs/{runId} gives it; another run carries nothing and costs no read', async () => {
    const waiting = row('suspended');
    const done = row('completed');
    const h = harness([waiting, done]);
    const listed = await h.get('/v1/runs?include=waitingFor');
    expect(listed.status).toBe(200);
    const [first, second] = listed.body.data as Record<string, any>[];
    const single = await h.get(`/v1/runs/${waiting.runId}`);
    expect(first?.waitingFor).toEqual(single.body.waitingFor);
    expect(first?.waitingFor.approvals).toHaveLength(1);
    expect(first?.waitingFor.approvals[0].tool.id).toBe('acme-desk.support-desk.hand-off');
    expect(second).not.toHaveProperty('waitingFor');
    expect(first).not.toHaveProperty('output');
    // The list read one journal (the suspended run's), the single read another.
    expect(h.journalReads).toEqual([waiting.runId, waiting.runId]);
  });

  test('with output too, both; without include, neither, and no journal is read', async () => {
    const h = harness([row('suspended')]);
    const both = await h.get('/v1/runs?include=output,waitingFor');
    expect((both.body.data as Record<string, any>[])[0]?.waitingFor.approvals).toHaveLength(1);
    // As the TypeScript client sends it, with the comma encoded.
    const encoded = await h.get('/v1/runs?include=output%2CwaitingFor');
    expect((encoded.body.data as Record<string, any>[])[0]?.waitingFor.approvals).toHaveLength(1);
    const plain = await h.get('/v1/runs');
    expect((plain.body.data as Record<string, any>[])[0]).not.toHaveProperty('waitingFor');
    expect(h.journalReads).toHaveLength(2);
  });

  test('a page that carries it holds at most 25 runs, and paging goes on', async () => {
    const rows = Array.from({ length: 30 }, () => row('completed'));
    const h = harness(rows);
    const capped = await h.get('/v1/runs?include=waitingFor&limit=26');
    expect(h.listCalls[0]?.limit).toBe(25);
    expect(capped.body.data).toHaveLength(25);
    expect(capped.body.hasMore).toBe(true);
    expect(capped.body.nextCursor).toBe('next-page');
    const defaulted = await h.get('/v1/runs?include=waitingFor');
    expect(h.listCalls[1]?.limit).toBe(25);
    expect(defaulted.body.data).toHaveLength(25);
    // Without it, the list's own bound (100) holds.
    const plain = await h.get('/v1/runs?limit=26');
    expect(h.listCalls[2]?.limit).toBe(26);
    expect(plain.body.data).toHaveLength(26);
  });

  test('at most five waits are read at once, and every suspended run gets its own', async () => {
    const rows = Array.from({ length: 12 }, () => row('suspended'));
    const h = harness(rows);
    const listed = await h.get('/v1/runs?include=waitingFor');
    expect(h.mostAtOnce()).toBe(5);
    expect([...h.journalReads].sort()).toEqual(rows.map((r) => r.runId).sort());
    // In the page's order, each with the approval linked to its own wait.
    const data = listed.body.data as Record<string, any>[];
    expect(data.map((d) => d.id)).toEqual(rows.map((r) => r.runId));
    const ids = data.map((d) => d.waitingFor.approvals.map((a: any) => a.approvalId));
    expect(new Set(ids.flat()).size).toBe(12);
    expect(ids.every((one) => one.length === 1)).toBe(true);
  });

  test("a run whose journal can't be read, or whose read throws, is listed without it; the page still answers", async () => {
    const lost = row('suspended');
    const thrown = row('suspended');
    const kept = row('suspended');
    const h = harness([lost, thrown, kept], {
      unreadable: [lost.runId],
      throwing: [thrown.runId],
    });
    const listed = await h.get('/v1/runs?include=waitingFor');
    expect(listed.status).toBe(200);
    const [first, second, third] = listed.body.data as Record<string, any>[];
    expect(first).not.toHaveProperty('waitingFor');
    expect(second).not.toHaveProperty('waitingFor');
    expect(third?.waitingFor.approvals).toHaveLength(1);
  });

  test('an unknown value beside it is refused, by name', async () => {
    const h = harness([row('suspended')]);
    const refused = await h.get('/v1/runs?include=waitingFor,keys');
    expect([refused.status, refused.body.error?.code]).toEqual([400, 'bad-input']);
    expect(refused.body.error?.message).toBe('Unknown `include` value(s): keys');
    expect(h.journalReads).toEqual([]);
  });
});
