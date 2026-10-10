// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's Schedules page in one read, its owners named:
 * `GET /v1/schedules?projectId=` lists one project's schedules (the
 * registry narrows; the route keeps a page right from one that doesn't),
 * and each schedule's `owner.displayName` is the owner's name now, the
 * person's or the service account's, when it can be read. Without it, the
 * owner's id stands.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, TenantId, UserId } from '@kindgi/types';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  IdentityDirectoryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID() as UserId;
const BOT = randomUUID();
const PROJECT_A = randomUUID() as ProjectId;
const PROJECT_B = randomUUID() as ProjectId;
const ADA_TOKEN = 'schedules-ada';
const BOT_TOKEN = 'schedules-bot';
const resolveToken: TokenResolver = async (token) => {
  if (token === ADA_TOKEN) return { tenantId, userId: ADA };
  if (token === BOT_TOKEN) return { tenantId, serviceAccountId: BOT, tokenId: 'key-bot' as never };
  return null;
};

function harness(
  options: {
    readonly ignoresProject?: boolean;
    readonly directory?: boolean;
    readonly serviceAccounts?: boolean;
    readonly failing?: boolean;
  } = {},
) {
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT_A });
  const asked: Record<string, unknown>[] = [];
  const triggerRegistry = {
    ...registry,
    list: async (input: Record<string, unknown>) => {
      asked.push(input);
      const { projectId: _ignored, ...rest } = input;
      return registry.list((options.ignoresProject === true ? rest : input) as never);
    },
  } as unknown as typeof registry;
  let userReads = 0;
  const identityDirectory = {
    getUser: async ({ userId }: { userId: string }) => {
      userReads += 1;
      if (options.failing === true) throw new Error('directory down');
      return userId === ADA
        ? { userId, tenantId, displayName: 'Ada Lovelace', createdAt: '' }
        : null;
    },
  } as unknown as IdentityDirectoryBinding;
  const serviceAccountBinding = {
    get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
      serviceAccountId === BOT
        ? { serviceAccountId, tenantId, name: 'acme-nightly-bot', grants: [] }
        : null,
  } as unknown as ServiceAccountBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry,
    ...(options.directory !== false && { identityDirectory }),
    ...(options.serviceAccounts !== false && { serviceAccountBinding }),
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, asked, userReads: () => userReads };
}

const schedule = (projectId: ProjectId, label: string) => ({
  flowId: 'acme.nightly',
  flowVersion: '1.0.0',
  projectId,
  label,
  config: { cronExpression: '0 2 * * *' },
});

async function seed(h: ReturnType<typeof harness>) {
  for (const [token, project, label] of [
    [ADA_TOKEN, PROJECT_A, 'a-ada'],
    [ADA_TOKEN, PROJECT_A, 'a-ada-2'],
    [ADA_TOKEN, PROJECT_B, 'b-ada'],
  ] as const) {
    const res = await h.call(token, 'POST', '/v1/schedules', schedule(project, label));
    expect(res.status, label).toBe(201);
  }
}

describe('one project’s schedules', () => {
  test('?projectId= reaches the registry, and the page has only that project’s', async () => {
    for (const ignoresProject of [false, true]) {
      const h = harness({ ignoresProject });
      await seed(h);
      const res = await h.call(ADA_TOKEN, 'GET', `/v1/schedules?projectId=${PROJECT_B}`);
      expect(res.status).toBe(200);
      expect(h.asked.at(-1)?.projectId).toBe(PROJECT_B);
      expect(res.body.data.map((s: { label: string }) => s.label)).toEqual(['b-ada']);
      for (const row of res.body.data)
        expect(validateAgainst('TriggerOwner', row.owner)).toEqual([]);
    }
  });

  test('without it, every project’s; a project id that isn’t one is 400', async () => {
    const h = harness();
    await seed(h);
    const all = await h.call(ADA_TOKEN, 'GET', '/v1/schedules');
    expect(all.body.data).toHaveLength(3);
    expect(h.asked.at(-1)).not.toHaveProperty('projectId');
    const bad = await h.call(ADA_TOKEN, 'GET', '/v1/schedules?projectId=not-a-project');
    expect([bad.status, bad.body.error.code]).toEqual([400, 'bad-input']);
  });
});

describe('the owner’s name', () => {
  test('a person: their display name, on the list, one read per owner, and on one schedule', async () => {
    const h = harness();
    await seed(h);
    const before = h.userReads();
    const list = await h.call(ADA_TOKEN, 'GET', '/v1/schedules');
    expect(list.body.data.map((s: { owner: unknown }) => s.owner)).toEqual(
      Array(3).fill({ kind: 'user', id: ADA, displayName: 'Ada Lovelace' }),
    );
    expect(h.userReads() - before).toBe(1);
    const one = await h.call(ADA_TOKEN, 'GET', `/v1/schedules/${list.body.data[0].scheduleId}`);
    expect(one.body.owner).toEqual({ kind: 'user', id: ADA, displayName: 'Ada Lovelace' });
    expect(validateAgainst('TriggerOwner', one.body.owner)).toEqual([]);
  });

  test('a service account: its name', async () => {
    const h = harness();
    const res = await h.call(BOT_TOKEN, 'POST', '/v1/schedules', schedule(PROJECT_A, 'bot'));
    expect(res.status).toBe(201);
    expect(res.body.owner).toEqual({ kind: 'service', id: BOT, displayName: 'acme-nightly-bot' });
  });

  test('one that can’t be read has none, and its id stands: no directory, a failing one', async () => {
    for (const options of [{ directory: false }, { failing: true }]) {
      const h = harness(options);
      await seed(h);
      const list = await h.call(ADA_TOKEN, 'GET', '/v1/schedules');
      expect(list.status).toBe(200);
      expect(list.body.data[0].owner).toEqual({ kind: 'user', id: ADA });
      expect(validateAgainst('TriggerOwner', list.body.data[0].owner)).toEqual([]);
    }
  });
});
