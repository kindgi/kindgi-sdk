// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import { scopeKey } from '@kindgi/platform';
import type { Cursor, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  EnvBinding,
  EnvCloudSecretBinding,
  EnvCloudSecretRecord,
  RunHandlerBinding,
  SystemAccessRecord,
  SystemTenantState,
} from '../src/index.js';

/**
 * The operator's cloud secrets: `PUT`, `DELETE` and `GET` on
 * `/v1/system/tenants/:tenantId/env[/:name]`, with `system:env-refs`; and
 * what the tenant sees of them on `/v1/env`: the names, never the path.
 */

const active = randomUUID() as TenantId;
const closing = randomUUID() as TenantId;
const STATES = new Map<string, SystemTenantState>([
  [active, 'active'],
  [closing, 'closing'],
]);
const projectId = randomUUID();

const KEYS: Readonly<Record<string, readonly string[]>> = {
  kgi_sy_env_refs: ['system:env-refs'],
  kgi_sy_pack_env: ['system:pack-env'],
  kgi_sy_full: ['kindgi:system'],
};
const TENANT_ADMIN = 'kgi_ak_tenant_admin';
const PATH = 'projects/acme-prod/secrets/stripe-key/versions/3';
const query = `envName=production&scopeKind=project&scopeId=${projectId}`;
const at = (tenantId: string, name?: string) =>
  `/v1/system/tenants/${tenantId}/env${name !== undefined ? `/${name}` : ''}?${query}`;

/** A small store keyed `(scope, envName, name)`: the routes are what's under test. */
function makeCloudSecrets(): EnvCloudSecretBinding & {
  readonly rows: Map<string, EnvCloudSecretRecord>;
} {
  const rows = new Map<string, EnvCloudSecretRecord>();
  const key = (i: { scope: Parameters<typeof scopeKey>[0]; envName: unknown; name: string }) =>
    `${scopeKey(i.scope)}|${String(i.envName)}|${i.name}`;
  return {
    rows,
    async get(input) {
      return rows.get(key(input)) ?? null;
    },
    async list(input) {
      const data = [...rows.values()]
        .filter((r) => scopeKey(r.scope) === scopeKey(input.scope) && r.envName === input.envName)
        .filter((r) => input.cursor === undefined || r.name > (input.cursor as unknown as string))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = data.slice(0, input.limit);
      return {
        data: page,
        ...(data.length > page.length && {
          nextCursor: page.at(-1)?.name as unknown as Cursor,
        }),
      };
    },
    async set(input) {
      const existing = rows.get(key(input));
      const current = existing?.revision ?? 0;
      if (input.ifRevision !== undefined && input.ifRevision !== current) {
        return { kind: 'revision-conflict', currentRevision: current };
      }
      const now = new Date().toISOString();
      const record: EnvCloudSecretRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        cloudSecret: input.cloudSecret,
        revision: current + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(key(input), record);
      return { kind: 'ok', record };
    },
    async delete(input) {
      return { deleted: rows.delete(key(input)) };
    },
  };
}

/** No env values: the tenant routes mount, and hold nothing. */
const envBinding: EnvBinding = {
  async list() {
    return { data: [] };
  },
  async get() {
    return null;
  },
  async resolve(input) {
    return { kind: 'err', error: { code: 'env-not-found', message: 'none', name: input.name } };
  },
  async set() {
    throw new Error('not used here');
  },
  async delete() {
    return { deleted: false };
  },
};

function makeApp(options: { readonly store?: boolean } = {}) {
  const cloudSecrets = makeCloudSecrets();
  const auditEvents = createInMemoryAuditEventBinding();
  const access: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
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
          capabilities: ['env:write'],
        };
      }
      return null;
    },
    runHandler: {} as RunHandlerBinding,
    envBinding,
    auditEvents,
    systemAccessAudit: {
      async record(entry) {
        access.push(entry);
      },
      async begin(attempt) {
        access.push({ ...attempt, status: 0 });
        return String(access.length - 1);
      },
      async finish(id, outcome) {
        access[Number(id)] = { ...(access[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
    systemTenantDirectory: {
      async get(tenantId) {
        const state = STATES.get(tenantId);
        return state === undefined ? null : { id: tenantId, state };
      },
    },
    ...(options.store !== false && { envCloudSecrets: cloudSecrets }),
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
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const code = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { code?: string } | undefined)?.code;
  const recorded = async (tenantId: TenantId): Promise<AuditEvent[]> => {
    const page = await auditEvents.query({ tenantId, limit: 50 });
    if (page.kind === 'err') throw new Error(page.error.message);
    return [...page.value.data];
  };
  return { call, code, cloudSecrets, recorded, access };
}

const docOf = (e: AuditEvent | undefined) =>
  (e?.payload as { doc?: Record<string, unknown> } | undefined)?.doc;

describe('PUT /v1/system/tenants/:tenantId/env/:name', () => {
  test('sets a name to a cloud secret, at the scope in the tenant the path names', async () => {
    const t = makeApp();
    const r = await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), {
      cloudSecret: PATH,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      scope: { kind: 'project', tenantId: active, projectId },
      envName: 'production',
      name: 'STRIPE_KEY',
      cloudSecret: PATH,
      revision: 1,
    });
    const [row] = [...t.cloudSecrets.rows.values()];
    expect(row?.scope).toEqual({ kind: 'project', tenantId: active, projectId });
  });

  test('a changed one bumps the revision; a stale ifRevision is 409 with the current one', async () => {
    const t = makeApp();
    await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), { cloudSecret: PATH });
    const next = PATH.replace(/3$/, '4');
    const changed = await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), {
      cloudSecret: next,
      ifRevision: 1,
    });
    expect([changed.status, changed.body.revision, changed.body.cloudSecret]).toEqual([
      200,
      2,
      next,
    ]);
    const stale = await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), {
      cloudSecret: PATH,
      ifRevision: 1,
    });
    expect([stale.status, t.code(stale)]).toEqual([409, 'env-write-conflict']);
    expect((stale.body.error as { details?: Record<string, unknown> }).details).toMatchObject({
      currentRevision: 2,
    });
  });

  test('anything but a numbered version of a secret, or a kp- one, is 400 and sets nothing', async () => {
    const t = makeApp();
    for (const cloudSecret of [
      'projects/acme-prod/secrets/stripe-key/versions/latest',
      'projects/acme-prod/secrets/stripe-key/versions/0',
      'projects/acme-prod/secrets/stripe-key',
      'projects/acme-prod/secrets/kp-0a1b2c/versions/2',
      'projects/Acme/secrets/stripe-key/versions/1',
      'stripe-key',
      42,
      undefined,
    ]) {
      const r = await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), {
        ...(cloudSecret !== undefined && { cloudSecret }),
      });
      expect([r.status, t.code(r)], String(cloudSecret)).toEqual([400, 'cloud-secret-invalid']);
      // The message names the form, never what was sent.
      if (typeof cloudSecret === 'string') expect(r.text).not.toContain(cloudSecret);
    }
    expect(t.cloudSecrets.rows.size).toBe(0);
  });

  test('a body with another field, or ifRevision not a whole number, is 400 bad-input', async () => {
    const t = makeApp();
    for (const body of [
      'not json',
      [PATH],
      { cloudSecret: PATH, value: 'x' },
      { cloudSecret: PATH, ifRevision: 1.5 },
      { cloudSecret: PATH, ifRevision: '1' },
    ]) {
      const r = await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), body);
      expect([r.status, t.code(r)], JSON.stringify(body)).toEqual([400, 'bad-input']);
    }
  });

  test('another scope, or a tenant key: refused, and nothing is set', async () => {
    const t = makeApp();
    const packEnv = await t.call('kgi_sy_pack_env', 'PUT', at(active, 'STRIPE_KEY'), {
      cloudSecret: PATH,
    });
    expect([packEnv.status, t.code(packEnv)]).toEqual([403, 'system-scope-missing']);
    const tenant = await t.call(TENANT_ADMIN, 'PUT', at(active, 'STRIPE_KEY'), {
      cloudSecret: PATH,
    });
    expect([tenant.status, t.code(tenant)]).toEqual([403, 'system-principal-required']);
    expect(t.cloudSecrets.rows.size).toBe(0);
    const full = await t.call('kgi_sy_full', 'PUT', at(active, 'STRIPE_KEY'), {
      cloudSecret: PATH,
    });
    expect(full.status).toBe(200);
  });

  test('an unknown tenant is 404; a closing one is frozen, 409', async () => {
    const t = makeApp();
    const unknown = await t.call('kgi_sy_env_refs', 'PUT', at(randomUUID(), 'STRIPE_KEY'), {
      cloudSecret: PATH,
    });
    expect([unknown.status, t.code(unknown)]).toEqual([404, 'tenant-not-found']);
    const frozen = await t.call('kgi_sy_env_refs', 'PUT', at(closing, 'STRIPE_KEY'), {
      cloudSecret: PATH,
    });
    expect([frozen.status, t.code(frozen)]).toEqual([409, 'tenant-closing']);
    expect(t.cloudSecrets.rows.size).toBe(0);
  });

  test('recorded as env-set by the system key, in the tenant, marked a cloud secret, never with its path', async () => {
    const t = makeApp();
    await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), { cloudSecret: PATH });
    const [event] = await t.recorded(active);
    expect(event).toMatchObject({
      kind: 'env-set',
      tenantId: active,
      actor: 'system-key:kgi_sy_env_refs',
      outcome: 'succeeded',
    });
    expect(docOf(event)).toMatchObject({
      name: 'STRIPE_KEY',
      envName: 'production',
      cloudSecret: true,
    });
    // A tenant may read the row (as exported evidence): only the operator reads the path.
    expect(JSON.stringify(event)).not.toContain('projects/');
  });
});

test('the access record names the key, the scope and the tenant', async () => {
  const t = makeApp();
  await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), { cloudSecret: PATH });
  expect(t.access.at(-1)).toMatchObject({
    keyId: 'kgi_sy_env_refs',
    scope: 'system:env-refs',
    tenantId: active,
  });
});

describe('DELETE and GET /v1/system/tenants/:tenantId/env', () => {
  test('the list carries each path; a delete removes one, once, and is recorded without it', async () => {
    const t = makeApp();
    for (const name of ['B_KEY', 'A_KEY']) {
      await t.call('kgi_sy_env_refs', 'PUT', at(active, name), { cloudSecret: PATH });
    }
    const listed = await t.call('kgi_sy_env_refs', 'GET', at(active));
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      data: [
        { name: 'A_KEY', cloudSecret: PATH },
        { name: 'B_KEY', cloudSecret: PATH },
      ],
      hasMore: false,
    });

    const removed = await t.call('kgi_sy_env_refs', 'DELETE', at(active, 'A_KEY'));
    expect(removed).toMatchObject({ status: 200, body: { deleted: true } });
    const again = await t.call('kgi_sy_env_refs', 'DELETE', at(active, 'A_KEY'));
    expect(again).toMatchObject({ status: 200, body: { deleted: false } });
    const deletes = (await t.recorded(active)).filter((e) => e.kind === 'env-deleted');
    expect(deletes).toHaveLength(1);
    expect(docOf(deletes[0])).toMatchObject({ name: 'A_KEY', cloudSecret: true });
    expect(JSON.stringify(deletes)).not.toContain('projects/');
  });

  test('a page at a time, by cursor', async () => {
    const t = makeApp();
    for (const name of ['A_KEY', 'B_KEY', 'C_KEY']) {
      await t.call('kgi_sy_env_refs', 'PUT', at(active, name), { cloudSecret: PATH });
    }
    const first = await t.call('kgi_sy_env_refs', 'GET', `${at(active)}&limit=2`);
    expect(first.body).toMatchObject({ hasMore: true, nextCursor: 'B_KEY' });
    const second = await t.call(
      'kgi_sy_env_refs',
      'GET',
      `${at(active)}&limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body).toMatchObject({ data: [{ name: 'C_KEY' }], hasMore: false });
  });

  test('a closing tenant can be read, not changed; a tenant key reaches neither', async () => {
    const t = makeApp();
    expect((await t.call('kgi_sy_env_refs', 'GET', at(closing))).status).toBe(200);
    const del = await t.call('kgi_sy_env_refs', 'DELETE', at(closing, 'A_KEY'));
    expect([del.status, t.code(del)]).toEqual([409, 'tenant-closing']);
    for (const method of ['GET', 'DELETE']) {
      const r = await t.call(TENANT_ADMIN, method, at(active, method === 'GET' ? undefined : 'A'));
      expect([r.status, t.code(r)], method).toEqual([403, 'system-principal-required']);
    }
  });
});

describe('a runtime that keeps no cloud secrets (hosted, for one)', () => {
  test('each system route answers 501 cloud-secrets-unsupported', async () => {
    const t = makeApp({ store: false });
    for (const [method, path, body] of [
      ['PUT', at(active, 'STRIPE_KEY'), { cloudSecret: PATH }],
      ['DELETE', at(active, 'STRIPE_KEY'), undefined],
      ['GET', at(active), undefined],
    ] as const) {
      const r = await t.call('kgi_sy_env_refs', method, path, body);
      expect([r.status, t.code(r)], method).toEqual([501, 'cloud-secrets-unsupported']);
    }
  });

  test("the tenant's list and a PUT with cloudSecret answer 501 too", async () => {
    const t = makeApp({ store: false });
    const list = await t.call(TENANT_ADMIN, 'GET', `/v1/env/cloud-secrets?${query}`);
    expect([list.status, t.code(list)]).toEqual([501, 'cloud-secrets-unsupported']);
    const put = await t.call(TENANT_ADMIN, 'PUT', `/v1/env/STRIPE_KEY?${query}`, {
      cloudSecret: PATH,
    });
    expect([put.status, t.code(put)]).toEqual([501, 'cloud-secrets-unsupported']);
  });
});

describe("the tenant's view", () => {
  test('a PUT with cloudSecret is 403 cloud-secret-system-only, and sets nothing', async () => {
    const t = makeApp();
    for (const body of [{ cloudSecret: PATH }, { cloudSecret: PATH, value: 'x' }]) {
      const r = await t.call(TENANT_ADMIN, 'PUT', `/v1/env/STRIPE_KEY?${query}`, body);
      expect([r.status, t.code(r)]).toEqual([403, 'cloud-secret-system-only']);
    }
    expect(t.cloudSecrets.rows.size).toBe(0);
  });

  test('lists the names set to a cloud secret, and no answer holds the path', async () => {
    const t = makeApp();
    await t.call('kgi_sy_env_refs', 'PUT', at(active, 'STRIPE_KEY'), { cloudSecret: PATH });
    const list = await t.call(TENANT_ADMIN, 'GET', `/v1/env/cloud-secrets?${query}`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      data: [{ name: 'STRIPE_KEY', envName: 'production', revision: 1 }],
      hasMore: false,
    });
    expect((list.body.data as Record<string, unknown>[])[0]).not.toHaveProperty('cloudSecret');
    for (const path of [
      `/v1/env/cloud-secrets?${query}`,
      `/v1/env?${query}`,
      `/v1/env/STRIPE_KEY?${query}`,
    ]) {
      const r = await t.call(TENANT_ADMIN, 'GET', path);
      expect(r.text, path).not.toContain('projects/');
    }
  });
});
