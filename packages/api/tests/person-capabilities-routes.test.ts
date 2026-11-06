// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Giving and taking back a person's capabilities
 * (`POST /v1/identity/users/:userId/capabilities`, `DELETE
 * …/capabilities/:capability`): the route's own checks in their order
 * (who may ask, then the input, then a runtime without the routes), what
 * it passes the binding, and the answer: the person's grants with what
 * the binding says they hold. The binding's refusals reach the caller
 * with their status. In-memory doubles; the runtime's binding checks the
 * rest under the tenant's admins lock.
 */

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  PersonCapabilitiesBinding,
  PersonCapabilityError,
  PersonCapabilityErrorCode,
  PersonGrantsBinding,
  RunHandlerBinding,
  TokenResolution,
} from '../src/index.js';

const tenantId = '00000000-0000-4000-8000-0000000000c1' as TenantId;
const runHandler = {} as RunHandlerBinding;
const alice = 'alice' as UserId;
const bob = 'bob' as UserId;

/** Who each token is. Alice is a tenant admin; Bob isn't. */
const TOKENS: Readonly<Record<string, Omit<TokenResolution, 'tenantId'>>> = {
  'alice-key': { userId: alice, scopes: ['tenant-admin'] },
  'alice-member': { userId: alice, scopes: ['tenant-admin'], tokenRole: 'member' },
  'alice-project': { userId: alice, scopes: ['tenant-admin'], tokenProjectId: 'p-1' },
  'bob-key': { userId: bob, scopes: [] },
  'bob-member': { userId: bob, scopes: [], tokenRole: 'member' },
  'bob-member-session': {
    userId: bob,
    scopes: [],
    tokenRole: 'member',
    sessionId: 'session-bob-member' as SessionId,
  },
  'bob-project': { userId: bob, scopes: [], tokenProjectId: 'p-1' },
  'bob-project-session': {
    userId: bob,
    scopes: [],
    tokenProjectId: 'p-1',
    sessionId: 'session-bob' as SessionId,
  },
  /** Bob's seed id as it was given before 0.3.0, in upper case. */
  'bob-upper': { userId: 'BOB' as UserId, scopes: [] },
  'ci-key': { serviceAccountId: 'ci', scopes: ['tenant-admin'] },
};

function harness(
  options: { changes?: boolean; grants?: boolean; refusal?: PersonCapabilityError } = {},
) {
  const held = new Map<string, readonly string[]>([
    ['alice', ['env:write', 'secrets:write']],
    ['bob', ['env:write']],
  ]);
  const gives: unknown[] = [];
  const takeBacks: unknown[] = [];
  const give: NonNullable<PersonCapabilitiesBinding['give']> = async (input) => {
    gives.push(input);
    if (options.refusal !== undefined) return { kind: 'err', error: options.refusal };
    const after = [...new Set([...(held.get(input.userId) ?? []), ...input.capabilities])].sort();
    held.set(input.userId, after);
    return { kind: 'ok', value: after };
  };
  const takeBack: NonNullable<PersonCapabilitiesBinding['takeBack']> = async (input) => {
    takeBacks.push(input);
    if (options.refusal !== undefined) return { kind: 'err', error: options.refusal };
    const after = (held.get(input.userId) ?? []).filter((c) => c !== input.capability);
    held.set(input.userId, after);
    return { kind: 'ok', value: after };
  };
  const personCapabilities: PersonCapabilitiesBinding = {
    held: async ({ userId }) => held.get(userId) ?? [],
    ...(options.changes !== false && { give, takeBack }),
  };
  // Reports `capabilities` for Alice only, as a runtime that fills them; `gone` was removed meanwhile.
  const personGrants: PersonGrantsBinding = {
    read: async ({ userId }) =>
      userId === 'gone'
        ? null
        : {
            userId,
            tenantAdmin: userId === 'alice',
            projects: [],
            teams: [],
            ...(userId === 'alice' && { capabilities: ['env:write', 'secrets:write'] }),
          },
    grant: async () => {
      throw new Error('unused');
    },
    ungrant: async () => {
      throw new Error('unused');
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: async (token) => {
      const who = TOKENS[token];
      return who === undefined ? null : { tenantId, capabilities: [], ...who };
    },
    runHandler,
    // `/users/*` mounts only beside a directory; these routes don't read it.
    identityDirectory: {
      getUser: async () => null,
      listUsers: async () => ({ data: [] }),
      listSessions: async () => ({ data: [] }),
      revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
    },
    ...(options.grants !== false && { personGrants }),
    personCapabilities,
  });
  const send = async (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    body?: unknown,
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return {
    gives,
    takeBacks,
    give: (userId: string, token: string, body: unknown) =>
      send('POST', `/v1/identity/users/${userId}/capabilities`, token, body),
    takeBack: (userId: string, capability: string, token: string) =>
      send(
        'DELETE',
        `/v1/identity/users/${userId}/capabilities/${encodeURIComponent(capability)}`,
        token,
      ),
    grants: (userId: string, token: string) =>
      send('GET', `/v1/identity/users/${userId}/grants`, token),
  };
}

const code = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code;
const message = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { message?: string } | undefined)?.message;

describe('giving a person capabilities', () => {
  test('a tenant admin gives: each name once, who asks; the answer is the grants with what the binding holds', async () => {
    const h = harness();
    const r = await h.give('bob', 'alice-key', {
      capabilities: ['secrets:write', 'secrets:write'],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      userId: 'bob',
      tenantAdmin: false,
      projects: [],
      teams: [],
      capabilities: ['env:write', 'secrets:write'],
    });
    expect(h.gives).toEqual([
      { tenantId, userId: 'bob', capabilities: ['secrets:write'], by: 'user:alice' },
    ]);
  });

  test("only a tenant admin's full key gives, refused before the body is read", async () => {
    const h = harness();
    for (const token of ['bob-key', 'alice-member', 'alice-project']) {
      const r = await h.give('bob', token, { nothing: true });
      expect([token, r.status, code(r)]).toEqual([token, 403, 'permission-denied']);
    }
    expect(h.gives).toEqual([]);
  });

  test('the body: 1 to 32 names counted as sent, each a name of at most 100 characters', async () => {
    const h = harness();
    const refused = [
      {},
      { capabilities: 'env:write' },
      { capabilities: [] },
      { capabilities: Array.from({ length: 33 }, () => 'env:write') },
      { capabilities: [''] },
      { capabilities: ['x'.repeat(101)] },
      { capabilities: [7] },
      { capabilities: ['env:write'], also: true },
    ];
    for (const body of refused) {
      const r = await h.give('bob', 'alice-key', body);
      expect([body, r.status, code(r)]).toEqual([body, 400, 'bad-input']);
    }
    expect(h.gives).toEqual([]);
    const most = await h.give('bob', 'alice-key', {
      capabilities: Array.from({ length: 32 }, () => 'x'.repeat(100)),
    });
    expect(most.status).toBe(200);
    expect(h.gives).toEqual([
      { tenantId, userId: 'bob', capabilities: ['x'.repeat(100)], by: 'user:alice' },
    ]);
  });

  test("a service account's key passes the route, and the binding hears who asks", async () => {
    const h = harness();
    await h.give('bob', 'ci-key', { capabilities: ['env:write'] });
    expect(h.gives).toEqual([
      { tenantId, userId: 'bob', capabilities: ['env:write'], by: 'service_account:ci' },
    ]);
  });

  test("the person's grants are read after the change: none there is 404", async () => {
    const r = await harness().give('gone', 'alice-key', { capabilities: ['env:write'] });
    expect([r.status, code(r)]).toEqual([404, 'identity-user-not-found']);
  });
});

describe('taking back a capability', () => {
  test("a tenant admin takes back someone's: the binding hears the name, decoded, and who asks", async () => {
    const h = harness();
    const r = await h.takeBack('bob', 'env:write', 'alice-key');
    expect(r.status).toBe(200);
    expect(r.body.capabilities).toEqual([]);
    expect(h.takeBacks).toEqual([
      { tenantId, userId: 'bob', capability: 'env:write', by: 'user:alice' },
    ]);
  });

  test('the person drops their own with a full key; a member key, or one limited to a project, is refused', async () => {
    const h = harness();
    const own = await h.takeBack('bob', 'env:write', 'bob-key');
    expect(own.status).toBe(200);
    expect(h.takeBacks).toEqual([
      { tenantId, userId: 'bob', capability: 'env:write', by: 'user:bob' },
    ]);
    const limited: [string, string, string][] = [
      ['bob', 'bob-member', 'a member API key'],
      ['bob', 'bob-member-session', 'a member session'],
      ['bob', 'bob-project', 'an API key limited to project p-1'],
      ['bob', 'bob-project-session', 'a session limited to project p-1'],
      // A tenant admin's own, with a limited key: it isn't a tenant admin's either.
      ['alice', 'alice-member', 'a member API key'],
      ['alice', 'alice-project', 'an API key limited to project p-1'],
    ];
    for (const [userId, token, limit] of limited) {
      const r = await h.takeBack(userId, 'env:write', token);
      expect([token, r.status, code(r)]).toEqual([token, 403, 'permission-denied']);
      expect(message(r)).toContain(`and this is ${limit}`);
    }
    expect(h.takeBacks).toHaveLength(1);
  });

  test("someone else's, by anyone but a tenant admin, is refused before the path's name is read", async () => {
    const h = harness();
    for (const capability of ['env:write', 'x'.repeat(101)]) {
      const r = await h.takeBack('alice', capability, 'bob-key');
      expect([r.status, code(r)]).toEqual([403, 'permission-denied']);
      expect(message(r)).toBe("Only a tenant admin takes back someone else's capabilities");
    }
    expect(h.takeBacks).toEqual([]);
  });

  test("the path's name is at most 100 characters, and its 400 names the path", async () => {
    const h = harness();
    const r = await h.takeBack('bob', 'x'.repeat(101), 'alice-key');
    expect([r.status, code(r)]).toEqual([400, 'bad-input']);
    expect(message(r)).toContain('in the path');
    expect(h.takeBacks).toEqual([]);
  });
});

describe('the binding, and a runtime without it', () => {
  test("the binding's refusals reach the caller with their status", async () => {
    const statuses: [PersonCapabilityErrorCode, number][] = [
      ['caller-not-a-person', 403],
      ['permission-denied', 403],
      ['identity-user-not-found', 404],
      ['identity-user-unregistered', 409],
      ['receiver-not-tenant-admin', 409],
      ['capability-not-givable', 403],
      ['capability-not-held', 403],
    ];
    for (const [refused, status] of statuses) {
      const h = harness({ refusal: { code: refused, message: `refused: ${refused}` } });
      const given = await h.give('bob', 'alice-key', { capabilities: ['env:write'] });
      expect([refused, given.status, code(given), message(given)]).toEqual([
        refused,
        status,
        refused,
        `refused: ${refused}`,
      ]);
      const taken = await h.takeBack('bob', 'env:write', 'alice-key');
      expect([refused, taken.status, code(taken)]).toEqual([refused, status, refused]);
    }
  });

  test('without give and take back: 501, after who may ask and the input', async () => {
    const h = harness({ changes: false });
    const given = await h.give('bob', 'alice-key', { capabilities: ['env:write'] });
    expect([given.status, code(given)]).toEqual([501, 'person-capabilities-unsupported']);
    const taken = await h.takeBack('bob', 'env:write', 'bob-key');
    expect([taken.status, code(taken)]).toEqual([501, 'person-capabilities-unsupported']);
    expect((await h.give('bob', 'alice-key', { capabilities: [] })).status).toBe(400);
    expect((await h.give('bob', 'bob-key', { capabilities: ['env:write'] })).status).toBe(403);
  });

  test("without a person's grants: 501 person-grants-unsupported, as the read, with or without give and take back", async () => {
    for (const changes of [true, false]) {
      const h = harness({ grants: false, changes });
      const given = await h.give('bob', 'alice-key', { capabilities: ['env:write'] });
      expect([changes, given.status, code(given)]).toEqual([
        changes,
        501,
        'person-grants-unsupported',
      ]);
      const taken = await h.takeBack('bob', 'env:write', 'alice-key');
      expect([changes, taken.status, code(taken)]).toEqual([
        changes,
        501,
        'person-grants-unsupported',
      ]);
      expect(h.gives).toEqual([]);
      expect(h.takeBacks).toEqual([]);
    }
  });
});

describe("a person's grants carry their capabilities, and their own is theirs in any case", () => {
  test('the read carries `capabilities` when the runtime reports them, and leaves it out when not', async () => {
    const h = harness();
    expect((await h.grants('alice', 'alice-key')).body.capabilities).toEqual([
      'env:write',
      'secrets:write',
    ]);
    expect('capabilities' in (await h.grants('bob', 'alice-key')).body).toBe(false);
  });

  test("a seed id in another case reads, and drops, its person's own", async () => {
    const h = harness();
    expect((await h.grants('bob', 'bob-upper')).status).toBe(200);
    expect((await h.takeBack('bob', 'env:write', 'bob-upper')).status).toBe(200);
    expect((await h.grants('alice', 'bob-upper')).status).toBe(403);
  });
});
