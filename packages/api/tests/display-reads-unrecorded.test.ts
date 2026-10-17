// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a response shows the caller about its own access records no
 * decision: whoami's `tenantAdmin`, `/me/permissions`' `tenant.admin` and
 * the judging queue's `can`. A console reads them on every poll, and each
 * read left a row in the tenant's access audit: allowed for an admin,
 * refused for everyone else. They're decided as before, through the
 * binding's `probe`. Every check that decides a request is recorded as
 * before, allowed or refused.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { ApiTokenId, ProjectId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  IdentityDirectoryBinding,
  JudgingQueueBinding,
  JudgingQueueItem,
  MyAccessBinding,
  RunHandlerBinding,
  Session,
  SessionStoreBinding,
  TokenResolution,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID();
const ann = 'user-ann' as UserId; // a tenant admin, who changes the project
const bo = 'user-bo' as UserId; // reads the project, changes nothing

/** The keys, by token. */
const KEYS: Record<string, TokenResolution> = {
  kgi_ann_admin: {
    tenantId,
    userId: ann,
    tokenId: 'tok-ann' as ApiTokenId,
    tokenRole: 'admin',
    scopes: ['tenant-admin'],
  },
  kgi_bo_full: { tenantId, userId: bo, tokenId: 'tok-bo' as ApiTokenId, scopes: [] },
  kgi_ann_member: {
    tenantId,
    userId: ann,
    tokenId: 'tok-ann-m' as ApiTokenId,
    tokenRole: 'member',
    scopes: ['tenant-admin'],
  },
  kgi_ann_project: {
    tenantId,
    userId: ann,
    tokenId: 'tok-ann-p' as ApiTokenId,
    tokenProjectId: PROJECT,
    scopes: ['tenant-admin'],
  },
};

/** A console's sessions, by token: full ones, and ones with a key's limits. */
const SESSIONS: Record<string, Session> = {};
function session(name: string, userId: UserId, limits: Partial<Session> = {}): string {
  const id = randomUUID() as unknown as SessionId;
  const token = `${SESSION_TOKEN_PREFIX}${id}.${name}`;
  SESSIONS[token] = {
    id,
    tenantId,
    userId,
    providerId: 'oidc',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() as Timestamp,
    scopes: [],
    createdAt: new Date().toISOString() as Timestamp,
    ...limits,
  };
  return token;
}
const annSession = session('ann', ann);
const boSession = session('bo', bo);
const annMemberSession = session('ann-member', ann, { role: 'member' });
const annProjectSession = session('ann-project', ann, {
  projectId: PROJECT as unknown as ProjectId,
});

const sessionStore: SessionStoreBinding = {
  create: async () => {
    throw new Error('not used');
  },
  resolveToken: async ({ token }) => SESSIONS[token] ?? null,
  get: async ({ sessionId }) => Object.values(SESSIONS).find((s) => s.id === sessionId) ?? null,
  list: async () => ({ data: [] }),
  revoke: async () => ({ revoked: false }),
  revokeAllForUser: async () => ({ revokedCount: 0 }),
};

/** Every caller: whether it's a tenant admin as the admin routes decide it, and whether it changes the project. */
interface Caller {
  readonly who: string;
  readonly token: string;
  readonly user: UserId;
  readonly admin: boolean;
  readonly writes: boolean;
  /** A key's limits, which refuse a tenant admin's action before the store is asked. */
  readonly limited: boolean;
}
const CALLERS: readonly Caller[] = [
  {
    who: "an admin's full session",
    token: annSession,
    user: ann,
    admin: true,
    writes: true,
    limited: false,
  },
  {
    who: "a non-admin's full session",
    token: boSession,
    user: bo,
    admin: false,
    writes: false,
    limited: false,
  },
  {
    who: "an admin's member session",
    token: annMemberSession,
    user: ann,
    admin: false,
    writes: true,
    limited: true,
  },
  {
    who: "an admin's session limited to a project",
    token: annProjectSession,
    user: ann,
    admin: false,
    writes: true,
    limited: true,
  },
  {
    who: "an admin's admin key",
    token: 'kgi_ann_admin',
    user: ann,
    admin: true,
    writes: true,
    limited: false,
  },
  {
    who: "a non-admin's full key",
    token: 'kgi_bo_full',
    user: bo,
    admin: false,
    writes: false,
    limited: false,
  },
  {
    who: "an admin's member key",
    token: 'kgi_ann_member',
    user: ann,
    admin: false,
    writes: true,
    limited: true,
  },
  {
    who: "an admin's key limited to a project",
    token: 'kgi_ann_project',
    user: ann,
    admin: false,
    writes: true,
    limited: true,
  },
];

/**
 * The store: Ann is a tenant admin; Bo reads, and changes nothing. Each
 * `check` is recorded, as the runtime's records every decision; `probe`
 * decides the same and records nothing. The API layer's own refusals
 * arrive through `recordDecision`.
 */
function store(options: { readonly probe?: boolean; readonly unreachable?: boolean } = {}) {
  const rows: string[] = [];
  const probed: string[] = [];
  const decide = (p: Principal, action: Action, r: ResourceRef): Decision => {
    if (options.unreachable === true) throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
    const allowed = p.actor.id === ann || action === 'read';
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: {
        action,
        relation: '',
        resource: `${r.type}:${r.id}`,
        actorSubject: `user:${p.actor.id}`,
      },
    };
  };
  const binding: AuthzCheckBinding = {
    check: async (p, action, r) => {
      rows.push(`check ${action} ${r.type} ${p.actor.id}`);
      return decide(p, action, r);
    },
    checkBatch: async (p, action, rs) =>
      rs.map((r) => {
        rows.push(`check ${action} ${r.type} ${p.actor.id}`);
        return decide(p, action, r);
      }),
    inProject: async () => false,
    recordDecision: (p, action, r, d) => {
      rows.push(`refused ${action} ${r.type} ${p.actor.id} (${d.failing})`);
    },
    ...(options.probe !== false && {
      probe: async (p: Principal, action: Action, r: ResourceRef) => {
        probed.push(`${action} ${r.type} ${p.actor.id}`);
        return decide(p, action, r);
      },
    }),
  };
  return { binding, rows, probed };
}

const directory: IdentityDirectoryBinding = {
  getUser: async () => null,
  listUsers: async () => ({ data: [] }),
  listSessions: async () => ({ data: [] }),
  revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
};

const myAccess: MyAccessBinding = {
  read: async () => ({ projects: [], orgs: [], teams: [], capabilities: {} }),
};

const ITEM: JudgingQueueItem = {
  runId: 'run-1',
  projectId: PROJECT,
  flowId: 'flow-1',
  runStatus: 'completed',
  completedAt: '2026-10-17T00:00:00.000Z' as Timestamp,
  rules: [],
  wantedClassIds: [],
  anyJudgment: false,
  progress: { total: 0, byClass: [] },
  addedAt: '2026-10-17T00:00:00.000Z' as Timestamp,
  state: 'open',
} as unknown as JudgingQueueItem;

const judgingQueue = {
  listQueue: async () => ({ data: [ITEM], hasMore: false, total: 1 }),
} as unknown as JudgingQueueBinding;

function harness(options: { readonly probe?: boolean; readonly unreachable?: boolean } = {}) {
  const s = store(options);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: async (token) => KEYS[token] ?? null,
    runHandler: {} as RunHandlerBinding,
    sessionStore,
    identityDirectory: directory,
    myAccess,
    judgingQueue,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: s.binding },
  });
  /** One request, and the rows it left in the audit. */
  const get = async (token: string, path: string) => {
    const before = s.rows.length;
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as Record<string, any>;
    return { status: res.status, body, rows: s.rows.slice(before) };
  };
  return { ...s, get };
}

describe('what a response shows the caller about its own access records nothing', () => {
  test.each(CALLERS)("whoami's tenantAdmin, for $who", async (caller) => {
    const h = harness();
    const r = await h.get(caller.token, '/v1/identity/whoami');
    expect(r.status).toBe(200);
    expect(r.body.tenantAdmin).toBe(caller.admin);
    expect(r.rows).toEqual([]);
    // A limited caller is refused before the store is asked.
    expect(h.probed).toEqual(caller.limited ? [] : [`admin tenant ${caller.user}`]);
  });

  test.each(CALLERS)("/me/permissions' tenant.admin, for $who", async (caller) => {
    const h = harness();
    const r = await h.get(caller.token, '/v1/identity/me/permissions');
    expect(r.status).toBe(200);
    expect(r.body.tenant).toMatchObject({ admin: caller.admin });
    expect(r.rows).toEqual([]);
  });

  test.each(CALLERS)(
    "the judging queue's can, for $who: only the list's own check is recorded",
    async (caller) => {
      const h = harness();
      const r = await h.get(caller.token, `/v1/projects/${PROJECT}/judging-queue`);
      expect(r.status).toBe(200);
      expect(r.body.data[0].can).toEqual({ dismiss: caller.writes, reopen: false });
      // Only the list's own check (`read` on the project) is recorded; the
      // hint (`write`) adds nothing.
      expect(r.rows.length).toBeGreaterThan(0);
      expect(new Set(r.rows)).toEqual(new Set([`check read project ${caller.user}`]));
    },
  );
});

describe('every check that decides a request is recorded as before', () => {
  test.each(CALLERS)(
    'an admin route, for $who: answered as whoami said, and recorded',
    async (caller) => {
      const h = harness();
      const me = await h.get(caller.token, '/v1/identity/whoami');
      const r = await h.get(caller.token, '/v1/identity/users');
      expect(r.status).toBe(caller.admin ? 200 : 403);
      expect(me.body.tenantAdmin).toBe(caller.admin);
      expect(r.rows).toEqual([
        caller.limited
          ? `refused admin tenant ${caller.user} (scope)`
          : `check admin tenant ${caller.user}`,
      ]);
    },
  );
});

describe('a binding without probe', () => {
  test("whoami asks check, which records, as before; a limited caller's refusal records nothing", async () => {
    const h = harness({ probe: false });
    const full = await h.get(annSession, '/v1/identity/whoami');
    expect(full.body.tenantAdmin).toBe(true);
    expect(full.rows).toEqual([`check admin tenant ${ann}`]);
    const limited = await h.get(annMemberSession, '/v1/identity/whoami');
    expect(limited.body.tenantAdmin).toBe(false);
    expect(limited.rows).toEqual([]);
  });
});

describe("a store that can't answer", () => {
  test('whoami still answers, without tenantAdmin, and records nothing', async () => {
    const h = harness({ unreachable: true });
    const r = await h.get(annSession, '/v1/identity/whoami');
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('tenantAdmin');
    expect(r.rows).toEqual([]);
  });
});
