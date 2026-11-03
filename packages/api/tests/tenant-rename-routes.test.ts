// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import type {
  RenameTenantOutcome,
  RenameTenantParams,
  TenantHierarchyBinding,
} from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  SystemAccessRecord,
  SystemTenantDirectory,
  SystemTenantState,
  SystemTenantsBinding,
} from '../src/index.js';

/**
 * Renaming a tenant: `PATCH /v1/tenant` (its own admins) and
 * `PATCH /v1/system/tenants/{tenantId}` (the operator). Both check the body
 * by tenant create's rules, hand it to the binding's `renameTenant`, and
 * answer its outcome the same way; each mounts only with that method.
 */

const ACME = randomUUID() as TenantId;
const userId = randomUUID() as UserId;

const runHandler = {} as RunHandlerBinding;

/** A `renameTenant` that records each call and answers `outcome`. */
function renamer(outcome: RenameTenantOutcome = { kind: 'ok' }) {
  const calls: RenameTenantParams[] = [];
  const renameTenant = async (params: RenameTenantParams) => {
    calls.push(params);
    return outcome;
  };
  return { calls, renameTenant };
}

function hierarchy(renameTenant?: TenantHierarchyBinding['renameTenant']): TenantHierarchyBinding {
  const { renameTenant: _stub, ...stubs } = createStubAppBindings().tenantHierarchyBinding;
  return {
    ...stubs,
    getTenant: async (tenantId) => ({
      id: tenantId,
      name: 'Acme',
      slug: 'acme',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
    ...(renameTenant !== undefined && { renameTenant }),
  };
}

/** Allows what `allowed` names (`read`, `admin`), and records each check. */
function authzAllowing(...allowed: string[]) {
  const asked: string[] = [];
  const binding = {
    check: async (_p: unknown, action: string, resource: { type: string; id: string }) => {
      asked.push(`${action} ${resource.type}:${resource.id}`);
      const ok = allowed.includes(action);
      return { allowed: ok, reason: 'test', failing: ok ? undefined : 'actor' } as Decision;
    },
  } as unknown as AuthzCheckBinding;
  return { asked, binding };
}

function tenantApp(
  renameTenant?: TenantHierarchyBinding['renameTenant'],
  authz?: AuthzCheckBinding,
) {
  const app = createApp({
    ...createStubAppBindings(),
    tenantHierarchyBinding: hierarchy(renameTenant),
    resolveToken: async (token) => (token === 'acme-token' ? { tenantId: ACME, userId } : null),
    runHandler,
    ...(authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: authz },
    }),
  });
  return (body: unknown, raw?: string) => send(app, 'acme-token', 'PATCH', '/v1/tenant', body, raw);
}

async function send(
  app: ReturnType<typeof createApp>,
  token: string,
  method: string,
  path: string,
  body: unknown,
  raw?: string,
) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  const json = (text === '' ? {} : JSON.parse(text)) as {
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
  return { status: res.status, text, error: json.error };
}

describe('PATCH /v1/tenant', () => {
  test('renames the caller’s tenant: 204 and no body, the fields given and no others', async () => {
    const { calls, renameTenant } = renamer();
    const patch = tenantApp(renameTenant);
    const both = await patch({ name: 'Acme Store', slug: 'acme-store' });
    expect(both.status).toBe(204);
    expect(both.text).toBe('');
    await patch({ name: 'Acme Store' });
    await patch({ slug: 'acme-store' });
    await patch({});
    expect(calls).toEqual([
      { tenantId: ACME, name: 'Acme Store', slug: 'acme-store' },
      { tenantId: ACME, name: 'Acme Store' },
      { tenantId: ACME, slug: 'acme-store' },
      { tenantId: ACME },
    ]);
  });

  test("a body out of tenant create's rules is refused before the binding", async () => {
    const { calls, renameTenant } = renamer();
    const patch = tenantApp(renameTenant);
    const refused: [unknown, string, string][] = [
      [{ name: '' }, 'bad-input', '`name` must be a non-empty string of at most 100 characters'],
      [{ name: '   ' }, 'bad-input', '`name` must be a non-empty string'],
      [{ name: 'a'.repeat(101) }, 'bad-input', 'at most 100 characters'],
      [{ name: 7 }, 'bad-input', '`name` must be'],
      [
        { slug: 'Acme' },
        'bad-input',
        '`slug` must be lowercase letters, digits and single hyphens',
      ],
      [{ slug: 'acme--store' }, 'bad-input', 'single hyphens'],
      [{ slug: 'acme-' }, 'bad-input', 'single hyphens'],
      [{ slug: '-acme' }, 'bad-input', 'single hyphens'],
      [{ slug: '' }, 'bad-input', 'single hyphens'],
      [{ slug: 'a'.repeat(64) }, 'bad-input', 'at most 63 characters'],
      [{ slug: 'acme', id: ACME }, 'unknown-field', 'Unknown field `id`'],
      [['acme'], 'bad-input', 'Request body must be an object'],
      [null, 'bad-input', 'Request body must be an object'],
    ];
    for (const [body, code, message] of refused) {
      const r = await patch(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code, JSON.stringify(body)).toBe(code);
      expect(r.error?.message, JSON.stringify(body)).toContain(message);
    }
    const notJson = await patch(undefined, '{"name":');
    expect([notJson.status, notJson.error?.code]).toEqual([400, 'bad-input']);
    expect(notJson.error?.message).toBe('Request body must be valid JSON');
    expect(calls).toEqual([]);

    // The longest slug, and one hyphen between letters or digits, pass.
    await patch({ slug: 'a'.repeat(63) });
    await patch({ slug: 'acme-2-store' });
    expect(calls.map((c) => c.slug)).toEqual(['a'.repeat(63), 'acme-2-store']);
  });

  test('each refusal from the binding, by its code', async () => {
    const id = ACME as unknown as string;
    const cases: [RenameTenantOutcome, number, string, Record<string, unknown>][] = [
      [{ kind: 'tenant-not-found' }, 404, 'tenant-not-found', { tenantId: id }],
      [{ kind: 'tenant-closing' }, 409, 'tenant-closing', { tenantId: id, state: 'closing' }],
      [{ kind: 'tenant-setup-pending' }, 409, 'tenant-setup-pending', { tenantId: id }],
      [{ kind: 'slug-taken' }, 409, 'tenant-slug-taken', { slug: 'acme-store' }],
    ];
    for (const [outcome, status, code, details] of cases) {
      const r = await tenantApp(renamer(outcome).renameTenant)({ slug: 'acme-store' });
      expect([r.status, r.error?.code], outcome.kind).toEqual([status, code]);
      expect(r.error?.details, outcome.kind).toEqual(details);
    }
    const taken = await tenantApp(renamer({ kind: 'slug-taken' }).renameTenant)({
      slug: 'acme-store',
    });
    expect(taken.error?.message).toBe('Another workspace has the slug "acme-store".');
  });

  test('an empty body still meets the tenant’s state: closing and setup-pending answer their 409s', async () => {
    const id = ACME as unknown as string;
    for (const [outcome, code, details] of [
      [{ kind: 'tenant-closing' }, 'tenant-closing', { tenantId: id, state: 'closing' }],
      [{ kind: 'tenant-setup-pending' }, 'tenant-setup-pending', { tenantId: id }],
    ] as const) {
      const { calls, renameTenant } = renamer(outcome);
      const r = await tenantApp(renameTenant)({});
      expect([r.status, r.error?.code], code).toEqual([409, code]);
      expect(r.error?.details, code).toEqual(details);
      expect(calls, code).toEqual([{ tenantId: ACME }]);
    }
  });

  test('sign-in settings that name its current slug: its own entries, and what the operator does', async () => {
    const r = await tenantApp(
      renamer({
        kind: 'slug-in-config',
        names: 'current',
        slug: 'acme',
        domains: ['acme.com', 'acme.co.uk'],
      }).renameTenant,
    )({ slug: 'acme-store' });
    expect([r.status, r.error?.code]).toEqual([409, 'tenant-slug-in-config']);
    expect(r.error?.details).toEqual({ slug: 'acme', domains: ['acme.com', 'acme.co.uk'] });
    expect(r.error?.message).toBe(
      `The server's KINDGI_AUTH_VERIFIED_DOMAINS names this workspace by its slug (acme.com:acme, acme.co.uk:acme), so its slug can't change yet: the server would find no workspace by it when it next starts. The server's operator names it there by its id (${ACME as unknown as string}) instead and restarts the server; then rename it.`,
    );
  });

  test('sign-in settings that name the new slug: refused, and no entry is shown', async () => {
    const r = await tenantApp(renamer({ kind: 'slug-in-config', names: 'new' }).renameTenant)({
      slug: 'globex',
    });
    expect([r.status, r.error?.code]).toEqual([409, 'tenant-slug-in-config']);
    expect(r.error?.details).toEqual({ slug: 'globex' });
    expect(r.error?.message).toBe(
      `The server's KINDGI_AUTH_VERIFIED_DOMAINS names the slug "globex", so no workspace can be renamed to it. Choose another.`,
    );
  });

  test('takes admin on the tenant; a member is refused before the binding', async () => {
    const admin = authzAllowing('read', 'admin');
    const { calls, renameTenant } = renamer();
    expect((await tenantApp(renameTenant, admin.binding)({ name: 'Acme Store' })).status).toBe(204);
    expect(admin.asked).toEqual([`read tenant:${ACME}`, `admin tenant:${ACME}`]);

    const member = authzAllowing('read');
    const refused = await tenantApp(renameTenant, member.binding)({ name: 'Globex' });
    expect(refused.status).toBe(403);
    expect(member.asked).toEqual([`read tenant:${ACME}`, `admin tenant:${ACME}`]);
    expect(calls).toEqual([{ tenantId: ACME, name: 'Acme Store' }]);
  });

  test('a binding without renameTenant: no route, and GET still answers', async () => {
    const patch = tenantApp(undefined);
    const r = await patch({ name: 'Acme Store' });
    expect(r.status).toBe(404);
    const app = createApp({
      ...createStubAppBindings(),
      tenantHierarchyBinding: hierarchy(undefined),
      resolveToken: async () => ({ tenantId: ACME, userId }),
      runHandler,
    });
    const got = await app.request('/v1/tenant', { headers: { authorization: 'Bearer t' } });
    expect(got.status).toBe(200);
  });
});

/** System keys by their capabilities. */
const KEYS: Record<string, string[]> = {
  kgi_sy_full: ['kindgi:system'],
  kgi_sy_tenants: ['system:tenants'],
  /** Sign-up on the public surface: create only. */
  kgi_sy_web: ['system:tenants:create'],
  kgi_sy_support: ['system:suspend'],
};

function systemApp(
  renameTenant: TenantHierarchyBinding['renameTenant'],
  states: Record<string, SystemTenantState> = { [ACME]: 'active' },
) {
  const audit: SystemAccessRecord[] = [];
  const directory: SystemTenantDirectory = {
    get: async (id) => {
      const state = states[id as unknown as string];
      return state === undefined ? null : { id, state };
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    tenantHierarchyBinding: hierarchy(renameTenant),
    tenancy: 'multi',
    tenantStates: { of: async () => undefined },
    resolveToken: async (token) => {
      if (token === 'acme-token') return { tenantId: ACME, userId };
      const caps = KEYS[token];
      return caps === undefined
        ? null
        : { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: caps };
    },
    runHandler,
    systemTenants: {} as SystemTenantsBinding,
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
  const patch = (tenantId: string, body: unknown, token = 'kgi_sy_tenants') =>
    send(app, token, 'PATCH', `/v1/system/tenants/${tenantId}`, body);
  return { patch, audit };
}

describe('PATCH /v1/system/tenants/{tenantId}', () => {
  test('system:tenants renames it: 204, the tenant named on the access record', async () => {
    const { calls, renameTenant } = renamer();
    const { patch, audit } = systemApp(renameTenant);
    const r = await patch(ACME, { name: 'Acme Store', slug: 'acme-store' });
    expect([r.status, r.text]).toEqual([204, '']);
    expect(calls).toEqual([{ tenantId: ACME, name: 'Acme Store', slug: 'acme-store' }]);
    expect(audit.at(-1)).toMatchObject({ keyId: 'kgi_sy_tenants', tenantId: ACME, status: 204 });
    expect((await patch(ACME, { name: 'Acme' }, 'kgi_sy_full')).status).toBe(204);
  });

  test('a key without system:tenants, or a tenant’s own key, is refused before the binding', async () => {
    const { calls, renameTenant } = renamer();
    const { patch } = systemApp(renameTenant);
    for (const token of ['kgi_sy_web', 'kgi_sy_support']) {
      const r = await patch(ACME, { name: 'Globex' }, token);
      expect([r.status, r.error?.code], token).toEqual([403, 'system-scope-missing']);
    }
    const own = await patch(ACME, { name: 'Globex' }, 'acme-token');
    expect([own.status, own.error?.code]).toEqual([403, 'system-principal-required']);
    expect(calls).toEqual([]);
  });

  test('a closing, purged or unknown tenant is refused before the binding', async () => {
    const closing = randomUUID();
    const purged = randomUUID();
    const { calls, renameTenant } = renamer();
    const { patch } = systemApp(renameTenant, { [closing]: 'closing', [purged]: 'purged' });
    const c = await patch(closing, { name: 'Globex' });
    expect([c.status, c.error?.code]).toEqual([409, 'tenant-closing']);
    for (const id of [purged, randomUUID(), 'not-a-uuid']) {
      const r = await patch(id, { name: 'Globex' });
      expect([r.status, r.error?.code], id).toEqual([404, 'tenant-not-found']);
    }
    expect(calls).toEqual([]);
  });

  test('an empty body: a closing tenant is refused before the binding, a setup-pending one by it', async () => {
    const closing = randomUUID();
    const refused = renamer();
    const c = await systemApp(refused.renameTenant, { [closing]: 'closing' }).patch(closing, {});
    expect([c.status, c.error?.code]).toEqual([409, 'tenant-closing']);
    expect(refused.calls).toEqual([]);
    const pending = renamer({ kind: 'tenant-setup-pending' });
    const p = await systemApp(pending.renameTenant).patch(ACME, {});
    expect([p.status, p.error?.code]).toEqual([409, 'tenant-setup-pending']);
    expect(pending.calls).toEqual([{ tenantId: ACME }]);
  });

  test("the body's rules and the binding's refusals are the tenant route's", async () => {
    const { patch } = systemApp(renamer({ kind: 'slug-taken' }).renameTenant);
    const taken = await patch(ACME, { slug: 'globex' });
    expect([taken.status, taken.error?.code]).toEqual([409, 'tenant-slug-taken']);
    expect(taken.error?.message).toBe('Another tenant has the slug "globex".');
    const bad = await patch(ACME, { slug: 'Globex' });
    expect([bad.status, bad.error?.code]).toEqual([400, 'bad-input']);
    const extra = await patch(ACME, { slug: 'globex', state: 'active' });
    expect([extra.status, extra.error?.code]).toEqual([400, 'unknown-field']);
    // A tenant that starts closing after the directory's read: the binding's answer.
    const late = systemApp(renamer({ kind: 'tenant-closing' }).renameTenant);
    const r = await late.patch(ACME, { name: 'Globex' });
    expect([r.status, r.error?.code]).toEqual([409, 'tenant-closing']);
  });

  test('a binding without renameTenant: no route', async () => {
    const { patch } = systemApp(undefined);
    expect((await patch(ACME, { name: 'Globex' })).status).toBe(404);
  });
});
