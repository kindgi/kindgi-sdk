// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  KeptRepoErasureOutcome,
  KeptRepoId,
  KeptRepoRuling,
  KeptRepoState,
  RunHandlerBinding,
  SystemAccessRecord,
  SystemKeptReposBinding,
  SystemTenantState,
} from '../src/index.js';

/**
 * The kept-repo system routes: the store's reconcile under
 * `system:kept-repos` (`POST /v1/system/kept-repos/rulings`, `GET
 * …/erasures`, `POST …/kept-repo/purged`), and a repo's erasure and state
 * under `system:kept-repos:erase`. Each takes its own scope; a tenant's
 * key never reaches them, and a runtime serving one tenant serves none.
 */

const active = randomUUID() as TenantId;
const closing = randomUUID() as TenantId;
const purged = randomUUID() as TenantId;
const STATES = new Map<string, SystemTenantState>([
  [active, 'active'],
  [closing, 'closing'],
  [purged, 'purged'],
]);
const PROJECT = randomUUID();
const SINCE = '2026-11-05T00:00:00.000Z';

const KEYS: Readonly<Record<string, readonly string[]>> = {
  kgi_sy_reconcile: ['system:kept-repos'],
  kgi_sy_erase: ['system:kept-repos:erase'],
  kgi_sy_limits: ['system:tenants:limits'],
  kgi_sy_full: ['kindgi:system'],
};
const TENANT_ADMIN = 'kgi_ak_tenant_admin';

const OFF_WORDS =
  "This runtime isn't keeping repos for projects without a GitHub repo now, so it can't take an erasure for one.";

interface Fake {
  rulings: (ids: readonly KeptRepoId[]) => readonly KeptRepoRuling[];
  state: KeptRepoState | undefined;
  erasure: KeptRepoErasureOutcome;
  pages: Map<
    string | undefined,
    | { data: { tenantId: TenantId; projectId: string; since: string }[]; nextCursor?: string }
    | undefined
  >;
}

function makeApp(options: { readonly tenancy?: 'multi' } = { tenancy: 'multi' }) {
  const calls = {
    rulings: [] as (readonly KeptRepoId[])[],
    reports: [] as Parameters<SystemKeptReposBinding['reportPurged']>[0][],
    states: [] as [string, string][],
    erasures: [] as Parameters<SystemKeptReposBinding['requestErasure']>[0][],
    pages: [] as { limit: number; cursor?: string }[],
  };
  const fake: Fake = {
    rulings: (ids) => ids.map(() => ({ ruling: 'keep', mark: 'none' })),
    state: { state: 'live', since: SINCE },
    erasure: { kind: 'requested', since: SINCE },
    pages: new Map([[undefined, { data: [] }]]),
  };
  const keptRepos: SystemKeptReposBinding = {
    async rulings(ids) {
      calls.rulings.push(ids);
      return fake.rulings(ids);
    },
    async reportPurged(input) {
      calls.reports.push(input);
    },
    async state(tenantId, projectId) {
      calls.states.push([tenantId, projectId]);
      return fake.state;
    },
    async requestErasure(input) {
      calls.erasures.push(input);
      return fake.erasure;
    },
    async openErasures(page) {
      calls.pages.push(page);
      return fake.pages.get(page.cursor);
    },
  };
  const audit: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    ...(options.tenancy !== undefined && { tenancy: options.tenancy }),
    tenantStates: { of: async () => undefined },
    resolveToken: async (token) => {
      const scopes = KEYS[token];
      if (scopes !== undefined) {
        return { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: [...scopes] };
      }
      if (token === TENANT_ADMIN) {
        return {
          tenantId: active,
          userId: 'user-admin' as UserId,
          scopes: ['tenant-admin'],
          capabilities: ['secrets:write'],
        };
      }
      return null;
    },
    runHandler: {} as RunHandlerBinding,
    systemAccessAudit: {
      async record(entry) {
        audit.push(entry);
      },
      async begin(attempt) {
        audit.push({ ...attempt, status: 0 });
        return String(audit.length - 1);
      },
      async finish(id, outcome) {
        audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
    systemTenantDirectory: {
      async get(tenantId) {
        const state = STATES.get(tenantId);
        return state === undefined ? null : { id: tenantId, state };
      },
    },
    systemKeptRepos: keptRepos,
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && {
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
    };
  };
  const code = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { code?: string } | undefined)?.code;
  return { call, code, calls, fake, audit };
}

const repoPath = (tenantId: string, projectId: string) =>
  `/v1/system/tenants/${tenantId}/projects/${projectId}/kept-repo`;

describe('POST /v1/system/kept-repos/rulings', () => {
  const path = '/v1/system/kept-repos/rulings';

  test('one ruling for each id, in order, with its ids; ids may span tenants and repeat', async () => {
    const t = makeApp();
    const a = { tenantId: active, projectId: PROJECT };
    const b = { tenantId: purged, projectId: randomUUID() };
    t.fake.rulings = (ids) =>
      ids.map((id, i) =>
        i === 0
          ? { ruling: 'purge', reason: 'erasure', recorded: true }
          : id.tenantId === purged
            ? { ruling: 'purge', reason: 'tenant-purged' }
            : { ruling: 'keep', mark: 'deleted', since: SINCE },
      );
    const r = await t.call('kgi_sy_reconcile', 'POST', path, { ids: [a, b, a] });
    expect(r).toEqual({
      status: 200,
      body: {
        rulings: [
          { ...a, ruling: 'purge', reason: 'erasure', recorded: true },
          { ...b, ruling: 'purge', reason: 'tenant-purged' },
          { ...a, ruling: 'keep', mark: 'deleted', since: SINCE },
        ],
      },
    });
    expect(t.calls.rulings).toEqual([[a, b, a]]);
  });

  test("a ruling answers its own fields alone, never anything else a binding's carries", async () => {
    const t = makeApp();
    const id = { tenantId: active, projectId: PROJECT };
    t.fake.rulings = () => [
      { ruling: 'keep', mark: 'held', since: SINCE, ref: 'refs/heads/main' } as KeptRepoRuling,
    ];
    const r = await t.call('kgi_sy_reconcile', 'POST', path, { ids: [id] });
    expect(r.body).toEqual({ rulings: [{ ...id, ruling: 'keep', mark: 'held', since: SINCE }] });
    t.fake.rulings = () => [
      {
        ruling: 'purge',
        reason: 'retention',
        recorded: false,
        path: '/x',
      } as unknown as KeptRepoRuling,
    ];
    const p = await t.call('kgi_sy_reconcile', 'POST', path, { ids: [id] });
    expect(p.body).toEqual({ rulings: [{ ...id, ruling: 'purge', reason: 'retention' }] });
  });

  test('ids are read in lower case', async () => {
    const t = makeApp();
    await t.call('kgi_sy_reconcile', 'POST', path, {
      ids: [{ tenantId: active.toUpperCase(), projectId: PROJECT.toUpperCase() }],
    });
    expect(t.calls.rulings).toEqual([[{ tenantId: active, projectId: PROJECT }]]);
  });

  test('up to 500 ids; 501, or an id not in form, refuses the whole request', async () => {
    const t = makeApp();
    const id = { tenantId: active, projectId: PROJECT };
    expect(
      (await t.call('kgi_sy_reconcile', 'POST', path, { ids: Array(500).fill(id) })).status,
    ).toBe(200);
    for (const body of [
      { ids: Array(501).fill(id) },
      { ids: [{ tenantId: active }] },
      { ids: [{ ...id, also: 1 }] },
      { ids: [{ tenantId: 'not-a-tenant', projectId: PROJECT }] },
      { ids: [id], also: 1 },
      {},
      'not json',
      [id],
    ]) {
      const r = await t.call('kgi_sy_reconcile', 'POST', path, body);
      expect([r.status, t.code(r)], JSON.stringify(body).slice(0, 60)).toEqual([400, 'bad-input']);
    }
    expect(t.calls.rulings).toHaveLength(1);
  });

  test("the erase key, another scope, or a tenant's key: refused, nothing ruled", async () => {
    const t = makeApp();
    const body = { ids: [{ tenantId: active, projectId: PROJECT }] };
    for (const key of ['kgi_sy_erase', 'kgi_sy_limits']) {
      const r = await t.call(key, 'POST', path, body);
      expect([r.status, t.code(r)], key).toEqual([403, 'system-scope-missing']);
    }
    const tenantKey = await t.call(TENANT_ADMIN, 'POST', path, body);
    expect([tenantKey.status, t.code(tenantKey)]).toEqual([403, 'system-principal-required']);
    expect(t.calls.rulings).toHaveLength(0);
    expect((await t.call('kgi_sy_full', 'POST', path, body)).status).toBe(200);
  });

  test('the access record names the key and the scope, across tenants', async () => {
    const t = makeApp();
    await t.call('kgi_sy_reconcile', 'POST', path, {
      ids: [{ tenantId: active, projectId: PROJECT }],
    });
    expect(t.audit.at(-1)).toMatchObject({
      keyId: 'kgi_sy_reconcile',
      scope: 'system:kept-repos',
      tenantId: '*',
      status: 200,
    });
  });
});

describe('GET /v1/system/kept-repos/erasures', () => {
  const path = '/v1/system/kept-repos/erasures';

  test('a page of the unfinished erasures, 500 when no limit is given, with the next cursor', async () => {
    const t = makeApp();
    const row = { tenantId: active, projectId: PROJECT, since: SINCE };
    t.fake.pages.set(undefined, { data: [row], nextCursor: 'c-2' });
    expect(await t.call('kgi_sy_reconcile', 'GET', path)).toEqual({
      status: 200,
      body: { data: [row], nextCursor: 'c-2' },
    });
    t.fake.pages.set('c-2', { data: [] });
    expect(await t.call('kgi_sy_reconcile', 'GET', `${path}?limit=1&cursor=c-2`)).toEqual({
      status: 200,
      body: { data: [] },
    });
    expect(t.calls.pages).toEqual([{ limit: 500 }, { limit: 1, cursor: 'c-2' }]);
  });

  test("a limit that isn't 1 to 500, or a cursor the runtime didn't give, is 400", async () => {
    const t = makeApp();
    for (const q of ['limit=0', 'limit=501', 'limit=x', 'limit=1.5']) {
      const r = await t.call('kgi_sy_reconcile', 'GET', `${path}?${q}`);
      expect([r.status, t.code(r)], q).toEqual([400, 'bad-input']);
    }
    const foreign = await t.call('kgi_sy_reconcile', 'GET', `${path}?cursor=elsewhere`);
    expect([foreign.status, t.code(foreign)]).toEqual([400, 'bad-input']);
  });

  test('the erase key is refused', async () => {
    const t = makeApp();
    const r = await t.call('kgi_sy_erase', 'GET', path);
    expect([r.status, t.code(r)]).toEqual([403, 'system-scope-missing']);
    expect(t.calls.pages).toHaveLength(0);
  });
});

describe('POST /v1/system/tenants/:tenantId/projects/:projectId/kept-repo/purged', () => {
  const path = (tenantId: string, projectId = PROJECT) => `${repoPath(tenantId, projectId)}/purged`;

  test("204 whatever the tenant's state, telling the binding which, and the reporting key", async () => {
    const t = makeApp();
    const unknown = randomUUID();
    for (const [tenantId, tenant] of [
      [active, 'served'],
      [closing, 'served'],
      [purged, 'purged'],
      [unknown, 'unknown'],
    ] as const) {
      const r = await t.call('kgi_sy_reconcile', 'POST', path(tenantId), { reason: 'no-record' });
      expect(r, tenantId).toEqual({ status: 204, body: {} });
      expect(t.calls.reports.at(-1)).toEqual({
        tenantId,
        projectId: PROJECT,
        reason: 'no-record',
        tenant,
        reportedBy: 'kgi_sy_reconcile',
      });
    }
  });

  test('each reason is taken; any other body, or an id not in form, is 400', async () => {
    const t = makeApp();
    for (const reason of ['erasure', 'retention', 'tenant-purged', 'no-record']) {
      expect((await t.call('kgi_sy_reconcile', 'POST', path(active), { reason })).status).toBe(204);
    }
    for (const body of [{}, { reason: 'gone' }, { reason: 'erasure', also: 1 }, 'not json']) {
      const r = await t.call('kgi_sy_reconcile', 'POST', path(active), body);
      expect([r.status, t.code(r)], JSON.stringify(body)).toEqual([400, 'bad-input']);
    }
    for (const p of [path('not-a-tenant'), path(active, 'not-a-project')]) {
      const r = await t.call('kgi_sy_reconcile', 'POST', p, { reason: 'erasure' });
      expect([r.status, t.code(r)], p).toEqual([400, 'bad-input']);
    }
    expect(t.calls.reports).toHaveLength(4);
  });

  test('the erase key is refused; the access record names the tenant', async () => {
    const t = makeApp();
    const r = await t.call('kgi_sy_erase', 'POST', path(active), { reason: 'erasure' });
    expect([r.status, t.code(r)]).toEqual([403, 'system-scope-missing']);
    expect(t.calls.reports).toHaveLength(0);
    await t.call('kgi_sy_reconcile', 'POST', path(active), { reason: 'erasure' });
    expect(t.audit.at(-1)).toMatchObject({
      keyId: 'kgi_sy_reconcile',
      scope: 'system:kept-repos',
      tenantId: active,
      status: 204,
    });
  });
});

describe('GET /v1/system/tenants/:tenantId/projects/:projectId/kept-repo', () => {
  test('the repo state', async () => {
    const t = makeApp();
    t.fake.state = { state: 'erasure-requested', since: SINCE };
    expect(await t.call('kgi_sy_erase', 'GET', repoPath(active, PROJECT))).toEqual({
      status: 200,
      body: { state: 'erasure-requested', since: SINCE },
    });
    expect(t.calls.states).toEqual([[active, PROJECT]]);
  });

  test('no record of the project, or an id not in form, is 404 project-not-found', async () => {
    const t = makeApp();
    t.fake.state = undefined;
    for (const p of [PROJECT, 'not-a-project']) {
      const r = await t.call('kgi_sy_erase', 'GET', repoPath(active, p));
      expect([r.status, t.code(r)], p).toEqual([404, 'project-not-found']);
    }
    expect(t.calls.states).toHaveLength(1);
  });

  test('an unknown or purged tenant is 404 tenant-not-found; the reconcile key is refused', async () => {
    const t = makeApp();
    for (const id of [randomUUID(), purged]) {
      const r = await t.call('kgi_sy_erase', 'GET', repoPath(id, PROJECT));
      expect([r.status, t.code(r)], id).toEqual([404, 'tenant-not-found']);
    }
    const r = await t.call('kgi_sy_reconcile', 'GET', repoPath(active, PROJECT));
    expect([r.status, t.code(r)]).toEqual([403, 'system-scope-missing']);
    expect(t.calls.states).toHaveLength(0);
  });
});

describe('POST /v1/system/tenants/:tenantId/projects/:projectId/kept-repo/erasure', () => {
  const path = (tenantId: string, projectId = PROJECT) =>
    `${repoPath(tenantId, projectId)}/erasure`;

  test('202 for a new or unfinished request, with the requesting key', async () => {
    const t = makeApp();
    expect(await t.call('kgi_sy_erase', 'POST', path(active))).toEqual({
      status: 202,
      body: { state: 'erasure-requested', since: SINCE },
    });
    expect(t.calls.erasures).toEqual([
      { tenantId: active, projectId: PROJECT, requestedBy: 'kgi_sy_erase' },
    ]);
  });

  test('200 when its erasure is done already', async () => {
    const t = makeApp();
    t.fake.erasure = { kind: 'purged', since: SINCE };
    expect(await t.call('kgi_sy_erase', 'POST', path(active))).toEqual({
      status: 200,
      body: { state: 'purged', since: SINCE },
    });
  });

  test('404 project-not-found for a project the runtime has no record of, or an id not in form', async () => {
    const t = makeApp();
    t.fake.erasure = { kind: 'not-found' };
    const r = await t.call('kgi_sy_erase', 'POST', path(active));
    expect([r.status, t.code(r)]).toEqual([404, 'project-not-found']);
    const malformed = await t.call('kgi_sy_erase', 'POST', path(active, 'not-a-project'));
    expect([malformed.status, t.code(malformed)]).toEqual([404, 'project-not-found']);
    expect(t.calls.erasures).toHaveLength(1);
  });

  test('409 legal-hold, naming the project, when something holds it', async () => {
    const t = makeApp();
    t.fake.erasure = { kind: 'refused', message: 'Something holds this repo.' };
    const r = await t.call('kgi_sy_erase', 'POST', path(active));
    expect(r).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'legal-hold',
          message: 'Something holds this repo.',
          details: { projectId: PROJECT },
        },
      },
    });
  });

  test('501 kept-repos-off, in its words, while the runtime keeps no repos', async () => {
    const t = makeApp();
    t.fake.erasure = { kind: 'off' };
    const r = await t.call('kgi_sy_erase', 'POST', path(active));
    expect(r).toMatchObject({
      status: 501,
      body: { error: { code: 'kept-repos-off', message: OFF_WORDS } },
    });
  });

  test("the reconcile key, or a tenant's key, is refused, and nothing is requested", async () => {
    const t = makeApp();
    const reconcile = await t.call('kgi_sy_reconcile', 'POST', path(active));
    expect([reconcile.status, t.code(reconcile)]).toEqual([403, 'system-scope-missing']);
    const tenantKey = await t.call(TENANT_ADMIN, 'POST', path(active));
    expect([tenantKey.status, t.code(tenantKey)]).toEqual([403, 'system-principal-required']);
    expect(t.calls.erasures).toHaveLength(0);
    expect((await t.call('kgi_sy_full', 'POST', path(active))).status).toBe(202);
  });

  test('a closing tenant still takes an erasure; an unknown or purged one is 404', async () => {
    const t = makeApp();
    expect((await t.call('kgi_sy_erase', 'POST', path(closing))).status).toBe(202);
    for (const id of [randomUUID(), purged]) {
      const r = await t.call('kgi_sy_erase', 'POST', path(id));
      expect([r.status, t.code(r)], id).toEqual([404, 'tenant-not-found']);
    }
    expect(t.calls.erasures.map((e) => e.tenantId)).toEqual([closing]);
  });
});

describe('a runtime serving one tenant', () => {
  test('serves no kept-repo route to a system key', async () => {
    const t = makeApp({});
    const id = { tenantId: active, projectId: PROJECT };
    for (const [key, method, p, body] of [
      ['kgi_sy_reconcile', 'POST', '/v1/system/kept-repos/rulings', { ids: [id] }],
      ['kgi_sy_reconcile', 'GET', '/v1/system/kept-repos/erasures', undefined],
      ['kgi_sy_reconcile', 'POST', `${repoPath(active, PROJECT)}/purged`, { reason: 'erasure' }],
      ['kgi_sy_erase', 'GET', repoPath(active, PROJECT), undefined],
      ['kgi_sy_erase', 'POST', `${repoPath(active, PROJECT)}/erasure`, undefined],
    ] as const) {
      const r = await t.call(key, method, p, body);
      expect([r.status, t.code(r)], `${method} ${p}`).toEqual([403, 'system-key-scope-not-served']);
    }
    expect(t.calls).toEqual({ rulings: [], reports: [], states: [], erasures: [], pages: [] });
  });
});
