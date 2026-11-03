// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_SCOPES, SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  SystemAccessRecord,
  SystemTenantDirectory,
  SystemTenantPurgeOutcome,
  SystemTenantsBinding,
} from '../src/index.js';

/**
 * `POST /v1/system/tenants/{tenantId}/purge`: the one irreversible system
 * action, under its own scope. The route checks the scope, finds the tenant
 * (a purged one too, so a run again finishes it), checks the body, and
 * answers what the binding did; the binding decides whether the tenant may
 * be purged.
 */

const TENANT = randomUUID() as TenantId;
const T = TENANT as unknown as string;
const PATH = `/v1/system/tenants/${T}/purge`;

/** System keys by their capabilities. */
const KEYS: Record<string, string[]> = {
  kgi_sy_full: ['kindgi:system'],
  /** The cancellation tooling's key: the purge's scope alone. */
  kgi_sy_purge: ['system:tenants:purge'],
  /** The worker's: tenants, but not their purge. */
  kgi_sy_tenants: ['system:tenants'],
  /** Every scope but the purge's: none of them includes it. */
  kgi_sy_all_but_purge: SYSTEM_SCOPES.filter((s) => s !== 'system:tenants:purge'),
};

/** A tenant's own key, holding the full capability: still not a system principal. */
const TENANT_KEY = 'kgi_ak_tenant';

const DONE: Extract<SystemTenantPurgeOutcome, { kind: 'ok' }> = {
  kind: 'ok',
  alreadyPurged: false,
  purgedAt: '2026-11-20T10:00:15.000Z',
  deleted: [
    { table: 'runs', rows: 12 },
    { table: 'projects', rows: 1 },
  ],
  objectsDeleted: 3,
  authzStoreDeleted: true,
  left: [],
  objectsLeft: 0,
};

/** A run that stopped before the mark: not marked, rows of it left. */
const { purgedAt: _marked, ...UNMARKED } = DONE;

const unused = async (): Promise<never> => {
  throw new Error('not used by these tests');
};

function makeApp(
  options: {
    readonly state?: 'active' | 'suspended' | 'closing' | 'purged';
    readonly outcomes?: SystemTenantPurgeOutcome[];
    readonly withoutPurge?: boolean;
  } = {},
) {
  const audit: SystemAccessRecord[] = [];
  const calls: { tenantId: TenantId; confirm: string; auditedFirst: boolean }[] = [];
  const outcomes = [...(options.outcomes ?? [DONE])];
  const directory: SystemTenantDirectory = {
    async get(id) {
      return id === TENANT ? { id, state: options.state ?? 'closing' } : null;
    },
  };
  const tenants: SystemTenantsBinding = {
    create: unused,
    list: unused,
    read: async () => null,
    close: unused,
    setSuspended: unused,
    setImagePrefix: unused,
    setProjectSuspended: unused,
    admins: unused,
    ...(options.withoutPurge !== true && {
      async purge(tenantId: TenantId, input: { readonly confirm: string }) {
        // The attempt is on record before the purge acts.
        const begun = audit.at(-1);
        calls.push({
          tenantId,
          confirm: input.confirm,
          auditedFirst: begun?.path === PATH && begun.status === 0,
        });
        const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
        if (next === undefined) throw new Error('no outcome scripted');
        return next;
      },
    }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
    tenantStates: { of: async () => undefined },
    resolveToken: async (token) => {
      if (token === TENANT_KEY) {
        return { tenantId: TENANT, capabilities: ['kindgi:system', 'system:tenants:purge'] };
      }
      const caps = KEYS[token];
      return caps === undefined
        ? null
        : { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: caps };
    },
    runHandler: {} as RunHandlerBinding,
    systemTenants: tenants,
    systemTenantDirectory: directory,
    systemAccessAudit: {
      record: async (e) => void audit.push(e),
      begin: async (a) => {
        audit.push({ ...a, status: 0 });
        return String(audit.length - 1);
      },
      finish: async (id, outcome) => {
        audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
  });
  const call = async (token: string, body: unknown, path = PATH, method = 'POST') => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
    };
  };
  const errorOf = (r: { body: Record<string, unknown> }) =>
    r.body.error as { code?: string; message?: string; details?: Record<string, unknown> };
  return { call, errorOf, audit, calls };
}

const CONFIRM = { confirm: 'acme-shop' };

describe('the scope: system:tenants:purge, which no other scope includes', () => {
  test('a key holding the purge scope alone purges', async () => {
    const { call, calls } = makeApp();
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls).toEqual([{ tenantId: TENANT, confirm: 'acme-shop', auditedFirst: true }]);
  });

  test('the full system capability purges', async () => {
    const { call, calls } = makeApp();
    const r = await call('kgi_sy_full', CONFIRM);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('a system:tenants key is refused, naming the scope, and nothing is purged', async () => {
    const { call, errorOf, calls } = makeApp();
    const r = await call('kgi_sy_tenants', CONFIRM);
    expect(r.status).toBe(403);
    expect(errorOf(r)).toMatchObject({
      code: 'system-scope-missing',
      details: { scope: 'system:tenants:purge' },
    });
    expect(calls).toEqual([]);
  });

  test('a key holding every other system scope is refused too', async () => {
    const { call, errorOf, calls } = makeApp();
    const r = await call('kgi_sy_all_but_purge', CONFIRM);
    expect(r.status).toBe(403);
    expect(errorOf(r).code).toBe('system-scope-missing');
    expect(calls).toEqual([]);
  });

  test("a tenant's key is refused whatever it holds", async () => {
    const { call, errorOf, calls } = makeApp();
    const r = await call(TENANT_KEY, CONFIRM);
    expect(r.status).toBe(403);
    expect(errorOf(r).code).toBe('system-principal-required');
    expect(calls).toEqual([]);
  });
});

describe('the access record', () => {
  test('the purge is on record before it acts, then with its outcome, scope and tenant', async () => {
    const { call, audit, calls } = makeApp();
    expect((await call('kgi_sy_purge', CONFIRM)).status).toBe(200);
    expect(calls[0]?.auditedFirst).toBe(true);
    expect(audit).toEqual([
      expect.objectContaining({
        keyId: 'kgi_sy_purge',
        method: 'POST',
        path: PATH,
        status: 200,
        scope: 'system:tenants:purge',
        tenantId: T,
      }),
    ]);
  });

  test('a refusal is on record too', async () => {
    const { call, audit } = makeApp();
    expect((await call('kgi_sy_tenants', CONFIRM)).status).toBe(403);
    expect(audit).toEqual([
      expect.objectContaining({ keyId: 'kgi_sy_tenants', path: PATH, status: 403 }),
    ]);
  });

  test("a refusal of the tenant's state is on record with the purge's scope and the tenant", async () => {
    const { call, audit } = makeApp({ outcomes: [{ kind: 'not-closing', state: 'active' }] });
    expect((await call('kgi_sy_purge', CONFIRM)).status).toBe(409);
    expect(audit.at(-1)).toMatchObject({
      status: 409,
      scope: 'system:tenants:purge',
      tenantId: T,
    });
  });
});

describe('what the runtime refuses: 409, nothing changed', () => {
  test.each([
    [
      { kind: 'not-closing', state: 'active' },
      'tenant-not-closing',
      { tenantId: T, state: 'active' },
    ],
    [
      { kind: 'not-closing', state: 'suspended' },
      'tenant-not-closing',
      { tenantId: T, state: 'suspended' },
    ],
    [
      { kind: 'window-open', windowEndsAt: '2026-12-01T00:00:00.000Z' },
      'tenant-export-window-open',
      { tenantId: T, windowEndsAt: '2026-12-01T00:00:00.000Z' },
    ],
    [{ kind: 'record-unset' }, 'purge-record-unset', { tenantId: T }],
    [
      {
        kind: 'setting-missing',
        reason: "the tenant has 2 artifacts, and this server's artifacts' store isn't set",
      },
      'purge-setting-missing',
      { tenantId: T },
    ],
  ] as const)('%o is %s', async (outcome, code, details) => {
    const { call, errorOf } = makeApp({ outcomes: [outcome as SystemTenantPurgeOutcome] });
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe(code);
    expect(errorOf(r).details).toEqual(details);
    expect(errorOf(r).message).toMatch(/Nothing was changed\.$/);
  });

  test('the record unset names the setting', async () => {
    const { call, errorOf } = makeApp({ outcomes: [{ kind: 'record-unset' }] });
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(errorOf(r).message).toContain('KINDGI_TENANT_PURGE_RECORD');
  });

  test('the authorization store refusing its delete is 502, and says to run it again', async () => {
    const { call, errorOf } = makeApp({
      outcomes: [
        {
          kind: 'authz-store-refused',
          reason:
            "OpenFGA answered 503 to deleting the tenant's authorization store, so none of its rows were deleted",
        },
      ],
    });
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(r.status).toBe(502);
    expect(errorOf(r)).toMatchObject({
      code: 'authz-store-delete-failed',
      message:
        "OpenFGA answered 503 to deleting the tenant's authorization store, so none of its rows were deleted. Run the purge again.",
    });
  });
});

describe('the body: the slug, a second check on the id', () => {
  test("a confirm that isn't the slug is 400 tenant-slug-mismatch", async () => {
    const { call, errorOf } = makeApp({ outcomes: [{ kind: 'slug-mismatch' }] });
    const r = await call('kgi_sy_purge', { confirm: 'acme-shop-2' });
    expect(r.status).toBe(400);
    expect(errorOf(r)).toMatchObject({
      code: 'tenant-slug-mismatch',
      details: { tenantId: T },
    });
    expect(errorOf(r).message).toMatch(/Nothing was changed\.$/);
  });

  test.each([
    ['no confirm', {}],
    ['an empty one', { confirm: '' }],
    ['not a string', { confirm: 7 }],
    ['another field', { confirm: 'acme-shop', force: true }],
    ['not JSON', '{'],
    ['not an object', ['acme-shop']],
  ])('%s is 400 bad-input, and the binding is never asked', async (_what, body) => {
    const { call, errorOf, calls } = makeApp();
    const r = await call('kgi_sy_purge', body);
    expect(r.status).toBe(400);
    expect(errorOf(r).code).toBe('bad-input');
    expect(calls).toEqual([]);
  });
});

describe('which tenant', () => {
  test('an unknown tenant, or a malformed id, is 404', async () => {
    const { call, errorOf, calls } = makeApp();
    const unknown = await call('kgi_sy_purge', CONFIRM, `/v1/system/tenants/${randomUUID()}/purge`);
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe('tenant-not-found');
    const malformed = await call('kgi_sy_purge', CONFIRM, '/v1/system/tenants/acme/purge');
    expect(malformed.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('a purged tenant is found, so a run again reaches the binding', async () => {
    const { call, calls } = makeApp({
      state: 'purged',
      outcomes: [{ ...DONE, alreadyPurged: true, deleted: [], objectsDeleted: 0 }],
    });
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ complete: true, alreadyPurged: true, deleted: [] });
    expect(calls).toHaveLength(1);
  });

  test('every other system route still answers 404 for a purged tenant', async () => {
    const { call, errorOf } = makeApp({ state: 'purged' });
    const read = await call('kgi_sy_full', undefined, `/v1/system/tenants/${T}`, 'GET');
    expect(read.status).toBe(404);
    expect(errorOf(read).code).toBe('tenant-not-found');
    const close = await call('kgi_sy_full', {}, `/v1/system/tenants/${T}/close`);
    expect(close.status).toBe(404);
  });

  test("a runtime whose binding doesn't purge answers 501", async () => {
    const { call, errorOf } = makeApp({ withoutPurge: true });
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(r.status).toBe(501);
    expect(errorOf(r).code).toBe('tenant-purge-unsupported');
  });
});

describe('the answer', () => {
  test('done: complete, with what it deleted, and nothing more than the schema has', async () => {
    const { call } = makeApp({
      outcomes: [
        {
          ...DONE,
          deleted: [...DONE.deleted, { table: 'memory_facts', rows: 0 }],
          // Something only the runtime knows stays out of the answer.
          ...({ fgaStore: '01M4WPFNJJ7YY6RXSJK1KB9W7D' } as object),
        },
      ],
    });
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(r.body).toEqual({
      tenantId: T,
      complete: true,
      alreadyPurged: false,
      purgedAt: '2026-11-20T10:00:15.000Z',
      deleted: [
        { table: 'runs', rows: 12 },
        { table: 'projects', rows: 1 },
      ],
      objectsDeleted: 3,
      authzStoreDeleted: true,
      left: [],
      objectsLeft: 0,
    });
  });

  test('rows left before the mark: not complete, not marked, and what is left named', async () => {
    const { call } = makeApp({
      outcomes: [{ ...UNMARKED, left: [{ table: 'audit_events', rows: 2 }] }],
    });
    const r = await call('kgi_sy_purge', CONFIRM);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ complete: false, left: [{ table: 'audit_events', rows: 2 }] });
    expect(r.body).not.toHaveProperty('purgedAt');
  });

  test('objects left, or rows written after the mark left with why: not complete', async () => {
    const objects = makeApp({ outcomes: [{ ...DONE, objectsLeft: 1 }] });
    expect((await objects.call('kgi_sy_purge', CONFIRM)).body).toMatchObject({
      complete: false,
      objectsLeft: 1,
    });
    const late = makeApp({
      outcomes: [
        {
          ...DONE,
          left: [{ table: 'artifacts', rows: 1 }],
          leftBecause: "the tenant has 1 artifact, and this server's artifacts' store isn't set",
        },
      ],
    });
    expect((await late.call('kgi_sy_purge', CONFIRM)).body).toMatchObject({
      complete: false,
      purgedAt: '2026-11-20T10:00:15.000Z',
      left: [{ table: 'artifacts', rows: 1 }],
      leftBecause: "the tenant has 1 artifact, and this server's artifacts' store isn't set",
    });
  });

  test('a run again after one that stopped part-way finishes it', async () => {
    const { call, calls } = makeApp({
      outcomes: [
        { ...UNMARKED, left: [{ table: 'audit_events', rows: 2 }] },
        {
          ...DONE,
          deleted: [{ table: 'audit_events', rows: 2 }],
          objectsDeleted: 0,
          authzStoreDeleted: false,
        },
      ],
    });
    const first = await call('kgi_sy_purge', CONFIRM);
    expect(first.body).toMatchObject({ complete: false });
    const again = await call('kgi_sy_purge', CONFIRM);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      complete: true,
      deleted: [{ table: 'audit_events', rows: 2 }],
    });
    expect(calls).toHaveLength(2);
  });
});
