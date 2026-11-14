// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The email domains a workspace lets people join from: the routes' gates,
 * what they give the binding, and how they answer it. The rules themselves
 * (the email a sign-in proved, public domains, another workspace's domain,
 * the authorization store) are the binding's, the deployment's: here a fake
 * binding answers each one.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId } from '@kindgi/types';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  JoinDomain,
  JoinDomainAllowOutcome,
  JoinDomainBinding,
  JoinDomainChangeOutcome,
  JoinLookupWorkspace,
  RunHandlerBinding,
  SystemTenantDirectory,
  TokenResolver,
} from '../src/index.js';
import { joinDomainOf, joinEmailOf } from '../src/routes/join-domains.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const USER = randomUUID();
const SESSION = randomUUID() as SessionId;
/** A tenant admin, signed in: a session. */
const PERSON = 'join-person-session';
/** A tenant admin's API key. */
const KEY = 'join-admin-key';
/** The deployment's own token: the runtime resolves it with `kindgi:system`. */
const DEPLOYMENT = 'join-deployment';
/** A member, not an admin. */
const MEMBER = 'join-member';

const resolveTenantToken: TokenResolver = async (t) => {
  switch (t) {
    case PERSON:
      return {
        tenantId,
        userId: USER as never,
        sessionId: SESSION,
        scopes: ['tenant-admin'],
        capabilities: [],
      };
    case KEY:
      return { tenantId, tokenId: 'key-1' as never, scopes: ['tenant-admin'], capabilities: [] };
    case DEPLOYMENT:
      return { tenantId, scopes: ['tenant-admin'], capabilities: ['kindgi:system'] };
    case MEMBER:
      return { tenantId, userId: randomUUID() as never, scopes: [], capabilities: [] };
    default:
      return null;
  }
};

const ACME: JoinDomain = {
  domain: 'acme.com',
  role: 'viewer',
  createdAt: '2026-11-06T00:00:00.000Z' as never,
  createdBy: `user:${USER}`,
};

/** A binding that answers as told, and keeps what each call was given. */
function fakeBinding(
  answers: {
    allow?: JoinDomainAllowOutcome;
    change?: JoinDomainChangeOutcome;
    removed?: boolean;
    lookup?: readonly JoinLookupWorkspace[];
  } = {},
) {
  const calls = {
    allow: [] as Parameters<JoinDomainBinding['allow']>[0][],
    change: [] as Parameters<JoinDomainBinding['change']>[0][],
    remove: [] as Parameters<JoinDomainBinding['remove']>[0][],
    lookup: [] as string[],
  };
  const binding: JoinDomainBinding = {
    list: async () => [ACME],
    allow: async (input) => {
      calls.allow.push(input);
      return (
        answers.allow ?? {
          kind: 'allowed',
          joinDomain: {
            ...ACME,
            domain: input.domain,
            role: input.role,
            createdBy: input.caller.by,
          },
        }
      );
    },
    change: async (input) => {
      calls.change.push(input);
      return answers.change ?? { kind: 'changed', joinDomain: { ...ACME, role: input.role } };
    },
    remove: async (input) => {
      calls.remove.push(input);
      return answers.removed === false ? { kind: 'not-found' } : { kind: 'removed' };
    },
    lookup: async (email) => {
      calls.lookup.push(email);
      return answers.lookup ?? [];
    },
  };
  return { binding, calls };
}

type Fake = ReturnType<typeof fakeBinding>;

function caller(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }) {
  return async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = (text === '' ? {} : JSON.parse(text)) as Record<string, any>;
    return { status: res.status, body: json, code: json.error?.code as string | undefined };
  };
}

function tenantApp(fake: Fake, changes?: 'operator') {
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: resolveTenantToken,
    runHandler: {} as RunHandlerBinding,
    joinDomains: fake.binding,
    ...(changes !== undefined && { identityProviderChanges: changes }),
  });
  return caller(app);
}

describe('/v1/auth/join-domains', () => {
  test('GET: the allowed domains, which a member reads too', async () => {
    const call = tenantApp(fakeBinding());
    const r = await call(MEMBER, 'GET', '/v1/auth/join-domains');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [ACME], hasMore: false });
  });

  test("POST from a tenant admin's session: the binding gets the person, their session, and the domain as an A-label", async () => {
    const fake = fakeBinding();
    const call = tenantApp(fake);
    const r = await call(PERSON, 'POST', '/v1/auth/join-domains', {
      domain: ' @Bücher.DE. ',
      role: 'runner',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      domain: 'xn--bcher-kva.de',
      role: 'runner',
      createdBy: `user:${USER}`,
    });
    expect(fake.calls.allow).toEqual([
      {
        tenantId,
        domain: 'xn--bcher-kva.de',
        role: 'runner',
        caller: { kind: 'person', userId: USER, sessionId: SESSION, by: `user:${USER}` },
      },
    ]);
  });

  test('POST: the role is viewer unless given', async () => {
    const fake = fakeBinding();
    const r = await tenantApp(fake)(PERSON, 'POST', '/v1/auth/join-domains', {
      domain: 'acme.com',
    });
    expect(r.status).toBe(201);
    expect(fake.calls.allow[0]?.role).toBe('viewer');
  });

  test("POST from an API key is no person's, and the deployment's own token is the operator's", async () => {
    const fake = fakeBinding();
    const call = tenantApp(fake);
    await call(KEY, 'POST', '/v1/auth/join-domains', { domain: 'acme.com' });
    await call(DEPLOYMENT, 'POST', '/v1/auth/join-domains', { domain: 'acme.com' });
    expect(fake.calls.allow.map((c) => c.caller.kind)).toEqual(['other', 'operator']);
  });

  test.each([
    [{ kind: 'not-yours', reason: 'not-a-person' }, 403, 'join-domain-not-yours'],
    [{ kind: 'not-yours', reason: 'no-proved-email' }, 403, 'join-domain-not-yours'],
    [{ kind: 'public' }, 400, 'join-domain-public'],
    [{ kind: 'verified-elsewhere' }, 409, 'join-domain-verified-elsewhere'],
    [{ kind: 'needs-authorization' }, 409, 'domain-join-needs-authorization'],
    [{ kind: 'exists', joinDomain: ACME }, 409, 'join-domain-exists'],
  ] as const)('POST: the binding says %j -> %i %s', async (outcome, status, code) => {
    const r = await tenantApp(fakeBinding({ allow: outcome as JoinDomainAllowOutcome }))(
      PERSON,
      'POST',
      '/v1/auth/join-domains',
      { domain: 'acme.com' },
    );
    expect([r.status, r.code]).toEqual([status, code]);
  });

  test.each([
    ['no domain', {}],
    ['a word, not a domain', { domain: 'acme' }],
    ['an empty label', { domain: 'acme..com' }],
    ['an email', { domain: 'lee@acme.com' }],
    ['a URL', { domain: 'https://acme.com' }],
    ['a user before a non-ASCII name', { domain: 'bücher.de@evil.com' }],
    ['a wildcard', { domain: '*.acme.com' }],
    ['an admin role', { domain: 'acme.com', role: 'admin' }],
    ['an unknown field', { domain: 'acme.com', domains: ['acme.com'] }],
    ['not JSON', '{"domain":'],
  ])('POST with %s: 400 bad-input, the binding not asked', async (_name, body) => {
    const fake = fakeBinding();
    const r = await tenantApp(fake)(PERSON, 'POST', '/v1/auth/join-domains', body);
    expect([r.status, r.code]).toEqual([400, 'bad-input']);
    expect(fake.calls.allow).toEqual([]);
  });

  test('a member changes nothing: 403, the binding not asked', async () => {
    const fake = fakeBinding();
    const call = tenantApp(fake);
    expect(
      (await call(MEMBER, 'POST', '/v1/auth/join-domains', { domain: 'acme.com' })).status,
    ).toBe(403);
    expect(
      (await call(MEMBER, 'PATCH', '/v1/auth/join-domains/acme.com', { role: 'none' })).status,
    ).toBe(403);
    expect((await call(MEMBER, 'POST', '/v1/auth/join-domains/acme.com/unregister')).status).toBe(
      403,
    );
    expect([fake.calls.allow, fake.calls.change, fake.calls.remove]).toEqual([[], [], []]);
  });

  test('PATCH: the role and the caller go to the binding, a raise not refused while tenants manage sign-in', async () => {
    const fake = fakeBinding();
    const r = await tenantApp(fake)(PERSON, 'PATCH', '/v1/auth/join-domains/ACME.com', {
      role: 'runner',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ domain: 'acme.com', role: 'runner' });
    expect(fake.calls.change).toEqual([
      {
        tenantId,
        domain: 'acme.com',
        role: 'runner',
        caller: { kind: 'person', userId: USER, sessionId: SESSION, by: `user:${USER}` },
        raiseRefused: false,
      },
    ]);
  });

  test.each([
    [{ kind: 'unchanged', joinDomain: ACME }, 200, undefined],
    [{ kind: 'not-found' }, 404, 'join-domain-not-found'],
    [{ kind: 'not-yours', reason: 'not-your-domain' }, 403, 'join-domain-not-yours'],
    [{ kind: 'verified-elsewhere' }, 409, 'join-domain-verified-elsewhere'],
    [{ kind: 'operator-managed' }, 403, 'join-domains-operator-managed'],
  ] as const)('PATCH: the binding says %j -> %i %s', async (outcome, status, code) => {
    const r = await tenantApp(fakeBinding({ change: outcome as JoinDomainChangeOutcome }))(
      KEY,
      'PATCH',
      '/v1/auth/join-domains/acme.com',
      { role: 'viewer' },
    );
    expect([r.status, r.code]).toEqual([status, code]);
  });

  test.each([
    ['no role', {}],
    ['an admin role', { role: 'admin' }],
    ['another field', { role: 'viewer', domain: 'other.com' }],
  ])('PATCH with %s: 400 bad-input', async (_name, body) => {
    const fake = fakeBinding();
    const r = await tenantApp(fake)(KEY, 'PATCH', '/v1/auth/join-domains/acme.com', body);
    expect([r.status, r.code]).toEqual([400, 'bad-input']);
    expect(fake.calls.change).toEqual([]);
  });

  test('unregister: any admin, an API key too; who did it goes to the binding; an unknown domain is 404', async () => {
    const fake = fakeBinding();
    const call = tenantApp(fake);
    const r = await call(PERSON, 'POST', '/v1/auth/join-domains/acme.com/unregister');
    expect([r.status, r.body]).toEqual([200, { domain: 'acme.com', unregistered: true }]);
    expect(fake.calls.remove).toEqual([{ tenantId, domain: 'acme.com', by: `user:${USER}` }]);
    const gone = await tenantApp(fakeBinding({ removed: false }))(
      KEY,
      'POST',
      '/v1/auth/join-domains/acme.com/unregister',
    );
    expect([gone.status, gone.code]).toEqual([404, 'join-domain-not-found']);
  });
});

describe('/v1/auth/join-domains while the operator manages sign-in', () => {
  test.each([PERSON, KEY])(
    'POST from a tenant admin (%s): 403 join-domains-operator-managed, before the body is read',
    async (token) => {
      const fake = fakeBinding();
      const call = tenantApp(fake, 'operator');
      const r = await call(token, 'POST', '/v1/auth/join-domains', { domain: 'acme.com' });
      expect([r.status, r.code]).toEqual([403, 'join-domains-operator-managed']);
      const bad = await call(token, 'POST', '/v1/auth/join-domains', '{"domain":');
      expect([bad.status, bad.code]).toEqual([403, 'join-domains-operator-managed']);
      expect(fake.calls.allow).toEqual([]);
    },
  );

  test("POST from the deployment's own token goes to the binding as the operator", async () => {
    const fake = fakeBinding();
    const r = await tenantApp(fake, 'operator')(DEPLOYMENT, 'POST', '/v1/auth/join-domains', {
      domain: 'acme.com',
    });
    expect(r.status).toBe(201);
    expect(fake.calls.allow[0]?.caller.kind).toBe('operator');
  });

  test("PATCH: a tenant admin's raise is refused by the binding's rule, the operator's isn't", async () => {
    const fake = fakeBinding();
    const call = tenantApp(fake, 'operator');
    await call(KEY, 'PATCH', '/v1/auth/join-domains/acme.com', { role: 'runner' });
    await call(DEPLOYMENT, 'PATCH', '/v1/auth/join-domains/acme.com', { role: 'runner' });
    expect(fake.calls.change.map((c) => [c.caller.kind, c.raiseRefused])).toEqual([
      ['other', true],
      ['operator', false],
    ]);
  });

  test('the list and removing are unchanged', async () => {
    const fake = fakeBinding();
    const call = tenantApp(fake, 'operator');
    expect((await call(KEY, 'GET', '/v1/auth/join-domains')).status).toBe(200);
    expect((await call(KEY, 'POST', '/v1/auth/join-domains/acme.com/unregister')).status).toBe(200);
  });
});

/** System keys by their capabilities. */
const SYSTEM_KEYS: Record<string, string[]> = {
  kgi_sy_full: ['kindgi:system'],
  kgi_sy_domains: ['system:join-domains'],
  kgi_sy_lookup: ['system:join-domains:read'],
  kgi_sy_other: ['system:tenants'],
};
const TENANT_KEY = 'join-tenant-key';
const CLOSING = randomUUID() as TenantId;

function systemApp(fake: Fake, changes?: 'operator') {
  const directory: SystemTenantDirectory = {
    get: async (id) =>
      id === tenantId
        ? { id: tenantId, state: 'active' }
        : id === CLOSING
          ? { id: CLOSING, state: 'closing' }
          : null,
  };
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
    tenantStates: { of: async () => undefined },
    resolveToken: async (token) => {
      if (token === TENANT_KEY) return { tenantId, scopes: ['tenant-admin'], capabilities: [] };
      const caps = SYSTEM_KEYS[token];
      return caps === undefined
        ? null
        : { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: caps };
    },
    runHandler: {} as RunHandlerBinding,
    joinDomains: fake.binding,
    systemTenantDirectory: directory,
    systemAccessAudit: {
      record: async () => undefined,
      begin: async () => 'attempt',
      finish: async () => undefined,
    },
    ...(changes !== undefined && { identityProviderChanges: changes }),
  });
  return caller(app);
}

describe('/v1/system/tenants/{tenantId}/join-domains', () => {
  const base = `/v1/system/tenants/${tenantId}/join-domains`;

  test('with system:join-domains: the list, and each change as the operator, by its system key', async () => {
    const fake = fakeBinding();
    const call = systemApp(fake);
    expect((await call('kgi_sy_domains', 'GET', base)).body).toEqual({
      data: [ACME],
      hasMore: false,
    });
    expect((await call('kgi_sy_domains', 'POST', base, { domain: 'Acme.com' })).status).toBe(201);
    expect(
      (await call('kgi_sy_domains', 'PATCH', `${base}/acme.com`, { role: 'runner' })).status,
    ).toBe(200);
    expect((await call('kgi_sy_domains', 'POST', `${base}/acme.com/unregister`)).status).toBe(200);
    const by = 'system-key:kgi_sy_domains';
    expect(fake.calls.allow).toEqual([
      { tenantId, domain: 'acme.com', role: 'viewer', caller: { kind: 'operator', by } },
    ]);
    expect(fake.calls.change).toEqual([
      {
        tenantId,
        domain: 'acme.com',
        role: 'runner',
        caller: { kind: 'operator', by },
        raiseRefused: false,
      },
    ]);
    expect(fake.calls.remove).toEqual([{ tenantId, domain: 'acme.com', by }]);
  });

  test("under operator-managed sign-in a system write passes: it's the operator's", async () => {
    const fake = fakeBinding();
    const call = systemApp(fake, 'operator');
    expect((await call('kgi_sy_domains', 'POST', base, { domain: 'acme.com' })).status).toBe(201);
    expect(
      (await call('kgi_sy_domains', 'PATCH', `${base}/acme.com`, { role: 'runner' })).status,
    ).toBe(200);
    expect(fake.calls.change[0]?.raiseRefused).toBe(false);
  });

  test("a system key without the scope, and a tenant's key: 403, nothing asked", async () => {
    const fake = fakeBinding();
    const call = systemApp(fake);
    const scope = await call('kgi_sy_other', 'POST', base, { domain: 'acme.com' });
    expect([scope.status, scope.code]).toEqual([403, 'system-scope-missing']);
    expect((await call('kgi_sy_lookup', 'GET', base)).code).toBe('system-scope-missing');
    const tenant = await call(TENANT_KEY, 'POST', base, { domain: 'acme.com' });
    expect([tenant.status, tenant.code]).toEqual([403, 'system-principal-required']);
    expect(fake.calls.allow).toEqual([]);
  });

  test('an unknown tenant is 404; a closing one is read, not changed', async () => {
    const fake = fakeBinding();
    const call = systemApp(fake);
    const unknown = await call(
      'kgi_sy_domains',
      'GET',
      `/v1/system/tenants/${randomUUID()}/join-domains`,
    );
    expect([unknown.status, unknown.code]).toEqual([404, 'tenant-not-found']);
    const closing = `/v1/system/tenants/${CLOSING}/join-domains`;
    expect((await call('kgi_sy_domains', 'GET', closing)).status).toBe(200);
    const write = await call('kgi_sy_domains', 'POST', closing, { domain: 'acme.com' });
    expect([write.status, write.code]).toEqual([409, 'tenant-closing']);
    expect(fake.calls.allow).toEqual([]);
  });
});

describe('POST /v1/system/join-domains/lookup', () => {
  const path = '/v1/system/join-domains/lookup';
  const ANSWER: readonly JoinLookupWorkspace[] = [
    { kind: 'join', tenantId, name: 'Acme', role: 'viewer' },
    { kind: 'member', tenantId: randomUUID() as TenantId, name: 'Acme Labs' },
  ];

  test.each(['kgi_sy_lookup', 'kgi_sy_domains', 'kgi_sy_full'])(
    'with %s: the workspaces to join and the ones it is in, each marked',
    async (token) => {
      const fake = fakeBinding({ lookup: ANSWER });
      const r = await systemApp(fake)(token, 'POST', path, { email: 'Lee@Bücher.de' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ data: ANSWER, hasMore: false });
      expect(fake.calls.lookup).toEqual(['Lee@xn--bcher-kva.de']);
    },
  );

  test("neither scope, or a tenant's key: 403", async () => {
    const fake = fakeBinding();
    const call = systemApp(fake);
    expect((await call('kgi_sy_other', 'POST', path, { email: 'lee@acme.com' })).code).toBe(
      'system-scope-missing',
    );
    expect((await call(TENANT_KEY, 'POST', path, { email: 'lee@acme.com' })).code).toBe(
      'system-principal-required',
    );
    expect(fake.calls.lookup).toEqual([]);
  });

  test.each([
    ['no email', {}],
    ['not an email', { email: 'lee' }],
    ['no local part', { email: '@acme.com' }],
    ['a space', { email: 'lee @acme.com' }],
    ['another field', { email: 'lee@acme.com', tenantId }],
  ])('%s: 400 bad-input', async (_name, body) => {
    const fake = fakeBinding();
    const r = await systemApp(fake)('kgi_sy_lookup', 'POST', path, body);
    expect([r.status, r.code]).toEqual([400, 'bad-input']);
    expect(fake.calls.lookup).toEqual([]);
  });
});

describe('joinDomainOf and joinEmailOf', () => {
  test.each([
    ['acme.com', 'acme.com'],
    ['ACME.Com', 'acme.com'],
    ['@acme.com', 'acme.com'],
    ['acme.com.', 'acme.com'],
    ['  mail.acme.co.uk ', 'mail.acme.co.uk'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['xn--bcher-kva.de', 'xn--bcher-kva.de'],
  ])('%j is %j', (raw, domain) => {
    expect(joinDomainOf(raw)).toBe(domain);
  });

  test.each([
    '',
    'acme',
    'acme..com',
    '-acme.com',
    'acme-.com',
    'acme.com/x',
    'acme.com:443',
    '1.2.3.4',
    'bücher.de/x',
    'bücher.de@evil.com',
    7,
  ])('%j is no domain', (raw) => {
    expect(joinDomainOf(raw)).toBeUndefined();
  });

  test('an email keeps its local part, with its domain as joinDomainOf gives it', () => {
    expect(joinEmailOf(' Lee.Ng@ACME.com ')).toBe('Lee.Ng@acme.com');
    expect(joinEmailOf('a@b@acme.com')).toBeUndefined();
    expect(joinEmailOf('lee@acme')).toBeUndefined();
  });
});
