// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The run list's reach (`ListRunsInput.reach`): the route works out whose
 * runs the caller may list, project by project, and hands it to the store,
 * so a page is full of what the caller may see. Every run in a project
 * they read; in one they may only run, their own. And `?actsFor=me`.
 * The list's own check after the store stays, for a store that doesn't
 * apply them (route-authz-runs.test.ts, list-cursor-hidden-rows.test.ts).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { decodeCursor, encodeCursor } from '../src/routes/pagination.js';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'run-list-reach';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
/** Read by the caller. */
const READ = randomUUID() as ProjectId;
/** Run, not read, by the caller: everyone in the workspace may run it. */
const RUN = randomUUID() as ProjectId;
/** Neither. */
const OTHER = randomUUID() as ProjectId;
const ME = 'user:user-1';

let minute = 0;
/** A run, each newer than the last. */
function record(projectId: ProjectId, actsFor?: string): KernelRunRecord {
  minute += 1;
  const at = new Date(Date.UTC(2026, 9, 7, 8, minute)).toISOString() as Timestamp;
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId,
    flowId: 'acme.triage',
    flowVersion: '1.0.0',
    status: 'completed',
    input: {},
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    ...(actsFor !== undefined && { actsFor: actsFor as never }),
  };
}

/**
 * A store that applies the reach and `actsFor`, newest first, a page of
 * `limit` with the next cursor as the kernel's: what a runtime with them
 * answers.
 */
function applyingStore(rows: readonly KernelRunRecord[]): RunBinding['listRuns'] {
  return async (input) => {
    const { reach, actsFor, cursor } = input;
    const listed = [...rows]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .filter(
        (r) =>
          reach === undefined ||
          reach.allIn.includes(r.projectId) ||
          (reach.ownIn.includes(r.projectId) &&
            reach.actsFor !== undefined &&
            r.actsFor === reach.actsFor),
      )
      .filter((r) => actsFor === undefined || r.actsFor === actsFor)
      .filter((r) => cursor === undefined || r.createdAt < cursor.createdAt);
    const limit = input.limit ?? 50;
    const page = listed.slice(0, limit);
    const last = page[page.length - 1];
    return listed.length > limit && last !== undefined
      ? {
          data: page,
          nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.runId }) as never,
        }
      : { data: page };
  };
}

function harness(opts: {
  readonly grants: readonly string[];
  readonly listRuns?: RunBinding['listRuns'];
  /** The authorizer lists objects (OpenFGA's `listObjects`); else the projects are checked one by one. */
  readonly lists?: boolean;
  readonly projects?: readonly ProjectId[];
}) {
  const asked: ListRunsInput[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    const allowed = opts.grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const listRuns = opts.listRuns ?? (async () => ({ data: [] }));
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    listRuns: async (input: ListRunsInput) => {
      asked.push(input);
      return listRuns(input);
    },
  } as unknown as RunBinding;
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (_p, action, r) => decide(action, r),
    checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
    ...(opts.lists === true && {
      listObjects: async (_p, action, type) =>
        opts.grants
          .filter((g) => g.startsWith(`${action} ${type}:`))
          .map((g) => g.slice(`${action} ${type}:`.length)),
    }),
  };
  const projectBinding =
    opts.projects === undefined
      ? undefined
      : ({
          list: async () => ({ items: (opts.projects ?? []).map((id) => ({ id })) }),
        } as unknown as ProjectBinding);
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    ...(projectBinding !== undefined && { projectBinding }),
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  const call = async (path: string, method = 'GET') => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return {
      status: res.status,
      body:
        method === 'HEAD'
          ? undefined
          : ((await res.json()) as {
              data: { id: string }[];
              hasMore: boolean;
              nextCursor?: string;
            }),
    };
  };
  return { call, asked };
}

describe('the reach the store is handed', () => {
  test("a project scope the caller reads: none, so the store lists the project's runs", async () => {
    const { call, asked } = harness({ grants: [`read project:${READ}`] });
    expect((await call(`/v1/runs?scopeKind=project&scopeId=${READ}`)).status).toBe(200);
    expect(asked[0]?.reach).toBeUndefined();
  });

  test('a project scope the caller only runs: their own runs there', async () => {
    const { call, asked } = harness({ grants: [`run project:${RUN}`] });
    await call(`/v1/runs?scopeKind=project&scopeId=${RUN}`);
    expect(asked[0]?.reach).toEqual({ allIn: [], ownIn: [RUN], actsFor: ME });
  });

  test("a project scope the caller neither reads nor runs: an empty reach, and the store's empty page has no cursor", async () => {
    const rows = [record(OTHER, ME), record(OTHER, 'user:user-2')];
    const { call, asked } = harness({ grants: [], listRuns: applyingStore(rows) });
    const res = await call(`/v1/runs?scopeKind=project&scopeId=${OTHER}`);
    expect(asked[0]?.reach).toEqual({ allIn: [], ownIn: [], actsFor: ME });
    expect(res.body).toEqual({ data: [], hasMore: false });
  });

  test('a workspace admin: none', async () => {
    const { call, asked } = harness({
      grants: [`admin tenant:${tenantId}`],
      lists: true,
    });
    await call('/v1/runs');
    expect(asked[0]?.reach).toBeUndefined();
  });

  test('across projects, from a listing authorizer: every run where they read, their own where they only run', async () => {
    const { call, asked } = harness({
      grants: [`read project:${READ}`, `run project:${READ}`, `run project:${RUN}`],
      lists: true,
    });
    await call('/v1/runs');
    expect(asked[0]?.reach).toEqual({ allIn: [READ], ownIn: [RUN], actsFor: ME });
  });

  test("across projects, without one: the workspace's projects checked one by one", async () => {
    const { call, asked } = harness({
      grants: [`read project:${READ}`, `run project:${READ}`, `run project:${RUN}`],
      projects: [READ, RUN, OTHER],
    });
    await call('/v1/runs');
    expect(asked[0]?.reach).toEqual({ allIn: [READ], ownIn: [RUN], actsFor: ME });
  });

  test("across projects, when neither can say: none, and the list's own check keeps what they may see", async () => {
    const own = record(RUN, ME);
    const rows = [record(RUN, 'user:user-2'), own, record(OTHER)];
    const { call, asked } = harness({
      grants: [`run project:${RUN}`],
      listRuns: async () => ({ data: rows }),
    });
    const res = await call('/v1/runs');
    expect(asked[0]?.reach).toBeUndefined();
    expect(res.body?.data.map((r) => r.id)).toEqual([own.runId]);
  });

  test('a HEAD of the list is checked as its GET', async () => {
    const { call, asked } = harness({ grants: [`run project:${RUN}`] });
    expect((await call(`/v1/runs?scopeKind=project&scopeId=${RUN}`, 'HEAD')).status).toBe(200);
    expect(asked[0]?.reach).toEqual({ allIn: [], ownIn: [RUN], actsFor: ME });
  });
});

describe('a page is full of what the caller may see', () => {
  test("someone who only runs pages through their own runs, two to a page, past everyone else's", async () => {
    const rows: KernelRunRecord[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push(record(RUN, ME));
      for (let j = 0; j < 5; j++) rows.push(record(RUN, 'user:user-2'));
    }
    const own = rows.filter((r) => r.actsFor === ME).reverse();
    const { call } = harness({ grants: [`run project:${RUN}`], listRuns: applyingStore(rows) });
    const first = await call(`/v1/runs?scopeKind=project&scopeId=${RUN}&limit=2`);
    expect(first.body?.data.map((r) => r.id)).toEqual(own.slice(0, 2).map((r) => r.runId));
    expect(first.body?.hasMore).toBe(true);
    const second = await call(
      `/v1/runs?scopeKind=project&scopeId=${RUN}&limit=2&cursor=${encodeURIComponent(first.body?.nextCursor ?? '')}`,
    );
    expect(second.body?.data.map((r) => r.id)).toEqual(own.slice(2, 4).map((r) => r.runId));
    expect(second.body?.hasMore).toBe(false);
    // The cursor names one of their own runs, never another person's.
    expect(decodeCursor(first.body?.nextCursor ?? '')?.id).toBe(own[1]?.runId);
  });
});

describe('?actsFor=me', () => {
  test('hands the store whom the caller acts for, within the reach', async () => {
    const { call, asked } = harness({ grants: [`read project:${READ}`], lists: true });
    expect((await call('/v1/runs?actsFor=me')).status).toBe(200);
    expect(asked[0]?.actsFor).toBe(ME);
    expect(asked[0]?.reach).toEqual({ allIn: [READ], ownIn: [], actsFor: ME });
  });

  test("keeps only the caller's own runs from a store that doesn't apply it", async () => {
    const own = record(READ, ME);
    const rows = [record(READ, 'user:user-2'), own, record(READ)];
    const { call } = harness({
      grants: [`read project:${READ}`],
      listRuns: async () => ({ data: rows }),
    });
    const res = await call('/v1/runs?actsFor=me');
    expect(res.body?.data.map((r) => r.id)).toEqual([own.runId]);
  });

  test("anything but `me` is a 400, and the store isn't asked", async () => {
    const { call, asked } = harness({ grants: [`read project:${READ}`] });
    const res = await call('/v1/runs?actsFor=user:user-2');
    expect(res.status).toBe(400);
    expect(asked).toEqual([]);
  });
});
