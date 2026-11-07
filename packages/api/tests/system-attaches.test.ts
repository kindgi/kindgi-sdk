// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's attaches (`routes/system-attaches.ts`): written only by a
 * system key holding `system:attaches` itself, and each write's checks name
 * the person and key its body names, never the caller: the route's host,
 * the key read in the path's tenant, the person's `admin` on the project
 * through `canFor`. Then the binding's own answers; the index copy's checks
 * and bounds; the end; and what `createApp` needs to mount them.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS } from '@kindgi/bounds';
import type { ApiTokenId, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import {
  ATTACH_INDEX_MAX_BYTES,
  ATTACH_INDEX_MAX_PRIMITIVES,
  ATTACH_INDEX_MIN_INTERVAL_MS,
  SYSTEM_TENANT_ID,
  createApp,
} from '../src/index.js';
import type {
  ApiTokenRecord,
  CreateAppInput,
  ProjectAttach,
  RunHandlerBinding,
  SystemAccessRecord,
  SystemAttachesBinding,
  TokenAdmin,
} from '../src/index.js';

const live = randomUUID() as TenantId;
const suspended = randomUUID() as TenantId;
const STATES = new Map<string, 'active' | 'suspended'>([
  [live, 'active'],
  [suspended, 'suspended'],
]);
const PROJECT = 'proj-1' as ProjectId;
const ATTACH = randomUUID();
const DANA = 'user-dana';
const KEY = 'tok-dana';
const HOST = 'attach.example.com';
const ROUTE_TOKEN = 'route-secret-1234567890';

/** Bearer tokens: the attach key, one holding the full capability, one with another scope, a tenant's. */
const ATTACH_KEY = 'kgi_sy_attaches';
const FULL_KEY = 'kgi_sy_full';
const OTHER_KEY = 'kgi_sy_deployments';
const TENANT_KEY = 'kgi_ak_tenant';
const SCOPES: Record<string, readonly string[]> = {
  [ATTACH_KEY]: ['system:attaches'],
  [FULL_KEY]: ['kindgi:system'],
  [OTHER_KEY]: ['system:deployments'],
};

const ARTIFACT = '20261107.1';
const TOOL = {
  id: 'acme.verify-citation',
  description: 'Verify a legal citation.',
  version: '1.0.0',
  input: { type: 'object', properties: { citation: { type: 'string' } } },
  output: { type: 'object', properties: { verified: { type: 'boolean' } } },
  modulePath: './tools/legal/verify-citation.js',
};
function index(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    packId: 'acme.aperture',
    packVersion: '1.0.0',
    artifactVersion: ARTIFACT,
    publishedAt: '2026-11-07T08:00:00.000Z',
    tools: [TOOL],
    guardrails: [],
    agents: [],
    flows: [],
    ...over,
  };
}

const NOW = new Date('2026-11-07T09:00:00.000Z');
const keyRecord = (over: Partial<ApiTokenRecord> = {}): ApiTokenRecord => ({
  tokenId: KEY as ApiTokenId,
  principal: { kind: 'user', userId: DANA },
  role: 'member',
  capabilities: [],
  projectId: PROJECT,
  createdAt: NOW,
  ...over,
});

type PutOutcome = Awaited<ReturnType<SystemAttachesBinding['put']>>;
type IndexOutcome = Awaited<ReturnType<SystemAttachesBinding['putIndex']>>;

function makeApp(
  options: {
    readonly admins?: readonly string[];
    readonly authzThrows?: boolean;
    readonly keys?: ReadonlyMap<string, ApiTokenRecord>;
    readonly put?: PutOutcome['kind'];
    readonly putIndex?: IndexOutcome;
  } = {},
) {
  const audit: SystemAccessRecord[] = [];
  const asked: string[] = [];
  const keyReads: string[] = [];
  const puts: Parameters<SystemAttachesBinding['put']>[0][] = [];
  const indexes: Parameters<SystemAttachesBinding['putIndex']>[0][] = [];
  const ends: Parameters<SystemAttachesBinding['end']>[0][] = [];
  const admins = new Set(options.admins ?? [DANA]);
  const keys = options.keys ?? new Map([[KEY, keyRecord()]]);
  const attach = (tenantId: TenantId, over: Partial<ProjectAttach> = {}): ProjectAttach => ({
    attachId: ATTACH,
    tenantId,
    projectId: PROJECT,
    userId: DANA,
    tokenId: KEY,
    routeUrl: `https://${HOST}/s/1`,
    createdAt: NOW,
    ...over,
  });
  const binding: SystemAttachesBinding = {
    async put(input) {
      puts.push(input);
      const kind = options.put ?? 'ok';
      if (kind === 'ok') return { kind, attach: attach(input.tenantId) };
      if (kind === 'ended') {
        return {
          kind,
          attach: attach(input.tenantId, { endedAt: NOW, endedReason: 'production-on' }),
        };
      }
      return { kind };
    },
    async putIndex(input) {
      indexes.push(input);
      return (
        options.putIndex ?? {
          kind: 'ok',
          revision: { attachId: input.attachId, revision: 3, hash: input.hash, createdAt: NOW },
        }
      );
    },
    async end(input) {
      ends.push(input);
      if (input.attachId !== ATTACH) return { kind: 'not-found' };
      return {
        kind: 'ok',
        attach: attach(input.tenantId, { endedAt: NOW, endedReason: 'ended' }),
      };
    },
  };
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (principal, action, resource) => {
      const actor = principal.actor;
      asked.push(
        `${actor.tenantId} ${actor.kind}:${actor.id} ${action} ${resource.type}:${resource.id}`,
      );
      if (options.authzThrows === true) {
        throw Object.assign(new Error('fga down'), { code: 'authz-backend-unavailable' });
      }
      const allowed = actor.kind !== 'user' || admins.has(actor.id);
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not an admin',
        evidence: { action, relation: '', resource: resource.id, actorSubject: actor.id },
      } satisfies Decision;
    },
    checkBatch: async () => [],
  };
  // Only `get` is read on these routes.
  const tokenAdmin = {
    async get(input: { readonly tenantId: TenantId; readonly tokenId: ApiTokenId }) {
      keyReads.push(`${input.tenantId} ${input.tokenId}`);
      return input.tenantId === live ? keys.get(input.tokenId) : undefined;
    },
  } as unknown as TokenAdmin;
  const input: CreateAppInput = {
    ...createStubAppBindings(),
    tenancy: 'multi',
    runHandler: {} as RunHandlerBinding,
    resolveToken: async (token) => {
      const scopes = SCOPES[token];
      if (scopes !== undefined) {
        return { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: scopes };
      }
      if (token === TENANT_KEY) {
        return { tenantId: live, scopes: ['tenant-admin'], capabilities: ['kindgi:system'] };
      }
      return null;
    },
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    tokenAdmin,
    systemAccessAudit: {
      async record(e) {
        audit.push(e);
      },
      async begin(attempt) {
        audit.push({ ...attempt, status: 0 });
        return String(audit.length - 1);
      },
      async finish(id, outcome) {
        audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
    tenantStates: { of: async () => undefined },
    systemTenantDirectory: {
      async get(id) {
        const state = STATES.get(id);
        return state === undefined ? null : { id, state };
      },
    },
    systemAttaches: { binding, routeHostAllowed: (host) => host === HOST },
  };
  const app = createApp(input);
  const call = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
    raw?: Uint8Array,
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...((body !== undefined || raw !== undefined) && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(raw !== undefined && { body: raw }),
    });
    const text = await res.text();
    const json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { call, input, audit, asked, keyReads, puts, indexes, ends };
}

const code = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code;
const details = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { details?: Record<string, unknown> } | undefined)?.details;
const attachPath = (t: string, a: string = ATTACH) =>
  `/v1/system/tenants/${t}/projects/${PROJECT}/attaches/${a}`;
const BODY = {
  userId: DANA,
  tokenId: KEY,
  routeUrl: `https://${HOST}/s/1`,
  routeToken: ROUTE_TOKEN,
};
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('PUT …/attaches/:attachId', () => {
  test("makes the attach for the body's person and key, answering it without its route token, on record", async () => {
    const { call, puts, asked, keyReads, audit } = makeApp();
    const res = await call(ATTACH_KEY, 'PUT', attachPath(live), BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      attachId: ATTACH,
      projectId: PROJECT,
      userId: DANA,
      tokenId: KEY,
      routeUrl: `https://${HOST}/s/1`,
      createdAt: NOW.toISOString(),
    });
    expect(res.text).not.toContain(ROUTE_TOKEN);
    expect(puts).toEqual([
      {
        tenantId: live,
        projectId: PROJECT,
        attachId: ATTACH,
        userId: DANA,
        tokenId: KEY,
        routeUrl: `https://${HOST}/s/1`,
        routeToken: ROUTE_TOKEN,
      },
    ]);
    // The person's admin and the person's key, in the path's tenant: never the caller's.
    expect(asked).toEqual([`${live} user:${DANA} admin project:${PROJECT}`]);
    expect(keyReads).toEqual([`${live} ${KEY}`]);
    expect(audit.at(-1)).toMatchObject({
      scope: 'system:attaches',
      keyId: ATTACH_KEY,
      tenantId: live,
      status: 200,
    });
  });

  test('the route kept is the parsed one: its host lower-cased, its default port dropped', async () => {
    const { call, puts } = makeApp();
    const res = await call(ATTACH_KEY, 'PUT', attachPath(live), {
      ...BODY,
      routeUrl: 'https://ATTACH.Example.com:443/s/1',
    });
    expect(res.status).toBe(200);
    expect(puts.map((p) => p.routeUrl)).toEqual([`https://${HOST}/s/1`]);
  });

  test("only a key holding system:attaches itself: kindgi:system doesn't stand in, nor does another scope or a tenant's key", async () => {
    const { call, puts } = makeApp();
    for (const [token, want] of [
      [FULL_KEY, 'system-scope-missing'],
      [OTHER_KEY, 'system-scope-missing'],
      [TENANT_KEY, 'system-principal-required'],
    ] as const) {
      const res = await call(token, 'PUT', attachPath(live), BODY);
      expect([token, res.status, code(res)]).toEqual([token, 403, want]);
    }
    expect(puts).toEqual([]);
  });

  test("the path and body: an attach id that isn't a UUID, a missing field, a route that isn't https with no query", async () => {
    const { call, puts } = makeApp();
    const cases: [string, unknown][] = [
      [attachPath(live, 'not-a-uuid'), BODY],
      [`/v1/system/tenants/${live}/projects/${'p'.repeat(129)}/attaches/${ATTACH}`, BODY],
      [attachPath(live), { ...BODY, userId: '' }],
      [attachPath(live), { ...BODY, tokenId: undefined }],
      [attachPath(live), { ...BODY, tokenId: 'k'.repeat(129) }],
      [attachPath(live), { ...BODY, routeToken: '' }],
      [attachPath(live), { ...BODY, routeToken: 't'.repeat(4097) }],
      [attachPath(live), { ...BODY, routeUrl: `http://${HOST}/s/1` }],
      [attachPath(live), { ...BODY, routeUrl: `https://u:p@${HOST}/s/1` }],
      [attachPath(live), { ...BODY, routeUrl: `https://:p@${HOST}/s/1` }],
      [attachPath(live), { ...BODY, routeUrl: `https://${HOST}/s/1?x=1` }],
      // An empty query or fragment, which the parsed URL drops.
      [attachPath(live), { ...BODY, routeUrl: `https://${HOST}/s/1?` }],
      [attachPath(live), { ...BODY, routeUrl: `https://${HOST}/s/1#` }],
      [attachPath(live), [BODY]],
    ];
    for (const [path, body] of cases) {
      const res = await call(ATTACH_KEY, 'PUT', path, body);
      expect([body, res.status, code(res)]).toEqual([body, 400, 'bad-input']);
    }
    expect(puts).toEqual([]);
  });

  test('an unknown tenant is a 404, a suspended one a 409, before anything is read', async () => {
    const { call, keyReads, asked } = makeApp();
    const unknown = await call(ATTACH_KEY, 'PUT', attachPath(randomUUID()), BODY);
    expect([unknown.status, code(unknown)]).toEqual([404, 'tenant-not-found']);
    const held = await call(ATTACH_KEY, 'PUT', attachPath(suspended), BODY);
    expect([held.status, code(held)]).toEqual([409, 'tenant-suspended']);
    expect([keyReads, asked]).toEqual([[], []]);
  });

  test("a route host off the operator's list is refused before the key or the person is read", async () => {
    const { call, keyReads, asked, puts } = makeApp();
    const res = await call(ATTACH_KEY, 'PUT', attachPath(live), {
      ...BODY,
      routeUrl: 'https://elsewhere.example.com/s/1',
    });
    expect([res.status, code(res)]).toEqual([409, 'attach-route-host-not-allowed']);
    expect([keyReads, asked, puts]).toEqual([[], [], []]);
  });

  test("the body's key: unknown, revoked or expired is not usable; someone else's, or not limited to this project, isn't limited to it", async () => {
    const { principal: _principal, ...noPrincipal } = keyRecord();
    const { projectId: _projectId, ...noProject } = keyRecord();
    const cases: [ApiTokenRecord | undefined, string, string][] = [
      [undefined, 'attach-key-not-usable', "isn't a key of this tenant's"],
      [keyRecord({ revokedAt: NOW }), 'attach-key-not-usable', 'is revoked'],
      [
        keyRecord({ expiresAt: new Date(Date.now() - 1000) }),
        'attach-key-not-usable',
        'has expired',
      ],
      [
        keyRecord({ principal: { kind: 'user', userId: 'user-erin' } }),
        'attach-key-not-limited-to-project',
        `doesn't act for user ${DANA}`,
      ],
      [
        keyRecord({ principal: { kind: 'service-account', serviceAccountId: DANA } }),
        'attach-key-not-limited-to-project',
        `doesn't act for user ${DANA}`,
      ],
      [noPrincipal, 'attach-key-not-limited-to-project', `doesn't act for user ${DANA}`],
      [noProject, 'attach-key-not-limited-to-project', "isn't limited to a project"],
      [
        keyRecord({ projectId: 'proj-2' as ProjectId }),
        'attach-key-not-limited-to-project',
        'is limited to another project',
      ],
    ];
    for (const [record, want, words] of cases) {
      const keys = new Map(record === undefined ? [] : [[KEY, record]]);
      const { call, asked, puts } = makeApp({ keys });
      const res = await call(ATTACH_KEY, 'PUT', attachPath(live), BODY);
      expect([res.status, code(res)]).toEqual([409, want]);
      expect((res.body.error as { message: string }).message).toContain(words);
      expect([asked, puts]).toEqual([[], []]);
    }
    // A key that expires later is live.
    const later = makeApp({
      keys: new Map([[KEY, keyRecord({ expiresAt: new Date(Date.now() + 60_000) })]]),
    });
    expect((await later.call(ATTACH_KEY, 'PUT', attachPath(live), BODY)).status).toBe(200);
  });

  test("the person's admin on the project, asked for them: none is refused; a store that can't be reached is a 503, nothing written", async () => {
    const notAdmin = makeApp({ admins: [] });
    const res = await notAdmin.call(ATTACH_KEY, 'PUT', attachPath(live), BODY);
    expect([res.status, code(res)]).toEqual([409, 'attach-needs-project-admin']);
    expect(notAdmin.puts).toEqual([]);

    const down = makeApp({ authzThrows: true });
    const unavailable = await down.call(ATTACH_KEY, 'PUT', attachPath(live), BODY);
    expect([unavailable.status, code(unavailable)]).toEqual([503, 'authz-backend-unavailable']);
    expect(unavailable.headers.get('retry-after')).not.toBeNull();
    expect(down.puts).toEqual([]);
  });

  test("the binding's answers: no project, production, someone else's test project, another person or key, ended", async () => {
    const cases: [PutOutcome['kind'], number, string][] = [
      ['project-not-found', 404, 'project-not-found'],
      ['in-production', 409, 'attach-project-in-production'],
      ['test-project-not-theirs', 409, 'attach-test-project-not-theirs'],
      ['mismatch', 409, 'attach-mismatch'],
      ['ended', 409, 'attach-ended'],
    ];
    for (const [put, status, want] of cases) {
      const { call } = makeApp({ put });
      const res = await call(ATTACH_KEY, 'PUT', attachPath(live), BODY);
      expect([put, res.status, code(res)]).toEqual([put, status, want]);
      if (put === 'ended') expect(details(res)).toEqual({ endedReason: 'production-on' });
    }
  });
});

describe('PUT …/attaches/:attachId/index', () => {
  const indexPath = (t: string) => `${attachPath(t)}/index`;

  test('copies a checked index in: its sha256, the index itself, the pace; answers the revision', async () => {
    const { call, indexes } = makeApp();
    const raw = bytes(index());
    const res = await call(ATTACH_KEY, 'PUT', indexPath(live), undefined, raw);
    const hash = createHash('sha256').update(raw).digest('hex');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attachId: ATTACH, revision: 3, hash, createdAt: NOW.toISOString() });
    expect(indexes).toEqual([
      {
        tenantId: live,
        projectId: PROJECT,
        attachId: ATTACH,
        hash,
        index: index(),
        minIntervalMs: ATTACH_INDEX_MIN_INTERVAL_MS,
      },
    ]);
    expect(ATTACH_INDEX_MIN_INTERVAL_MS).toBe(2_000);
  });

  test('one a deploy would refuse, with its issues where its primitives are; no artifact version; data blocks', async () => {
    const { call, indexes } = makeApp();
    const invalid = await call(
      ATTACH_KEY,
      'PUT',
      indexPath(live),
      undefined,
      bytes(index({ tools: [{ ...TOOL, input: 7 }] })),
    );
    expect([invalid.status, code(invalid)]).toEqual([400, 'attach-index-invalid']);
    expect((details(invalid)?.issues as unknown[]).length).toBeGreaterThan(0);
    for (const raw of [
      new TextEncoder().encode('{"v": 1,'),
      bytes([index()]),
      bytes(index({ artifactVersion: undefined })),
      bytes(index({ env: { required: 'API_BASE' } })),
    ]) {
      const res = await call(ATTACH_KEY, 'PUT', indexPath(live), undefined, raw);
      expect([res.status, code(res)]).toEqual([400, 'attach-index-invalid']);
      expect(details(res)).toBeUndefined();
    }
    const block = {
      id: 'acme.reply',
      version: '1.0.0',
      kind: 'prompt',
      content: { template: 'Hi.' },
      modulePath: 'blocks/reply.json',
    };
    const blocks = await call(
      ATTACH_KEY,
      'PUT',
      indexPath(live),
      undefined,
      bytes(index({ blocks: [block] })),
    );
    expect([blocks.status, code(blocks)]).toEqual([400, 'attach-index-invalid']);
    expect(details(blocks)?.issues).toMatchObject([{ primitive: 'block' }]);
    expect(indexes).toEqual([]);
  });

  test('past its bounds: its size, before it is parsed, and its primitives', async () => {
    // Below the app's own request limit on both profiles, or that one answers first.
    expect(ATTACH_INDEX_MAX_BYTES).toBeLessThan(
      Math.min(HOSTED_BOUNDS.requestMaxBytes, SELF_HOSTED_BOUNDS.requestMaxBytes),
    );
    const { call, indexes } = makeApp();
    const big = new Uint8Array(ATTACH_INDEX_MAX_BYTES + 1).fill(0x20);
    const size = await call(ATTACH_KEY, 'PUT', indexPath(live), undefined, big);
    expect([size.status, code(size), details(size)]).toEqual([
      413,
      'attach-index-too-large',
      { limit: ATTACH_INDEX_MAX_BYTES },
    ]);
    // At the size bound, it's taken: an index, padded with spaces to it.
    const fits = new Uint8Array(ATTACH_INDEX_MAX_BYTES).fill(0x20);
    fits.set(bytes(index()));
    const atSize = await call(ATTACH_KEY, 'PUT', indexPath(live), undefined, fits);
    expect(atSize.status).toBe(200);
    const tools = Array.from({ length: ATTACH_INDEX_MAX_PRIMITIVES + 1 }, (_, i) => ({
      ...TOOL,
      id: `acme.tool-${i}`,
    }));
    const many = await call(ATTACH_KEY, 'PUT', indexPath(live), undefined, bytes(index({ tools })));
    expect([many.status, code(many), details(many)]).toEqual([
      413,
      'attach-index-too-large',
      { limit: ATTACH_INDEX_MAX_PRIMITIVES },
    ]);
    // At the bound, it's copied.
    const at = await call(
      ATTACH_KEY,
      'PUT',
      indexPath(live),
      undefined,
      bytes(index({ tools: tools.slice(1) })),
    );
    expect(at.status).toBe(200);
    expect(indexes).toHaveLength(2);
  });

  test("the binding's answers: too soon with Retry-After, no such attach, ended", async () => {
    const soon = makeApp({ putIndex: { kind: 'too-soon', retryAfterMs: 1_200 } });
    const res = await soon.call(ATTACH_KEY, 'PUT', indexPath(live), undefined, bytes(index()));
    expect([res.status, code(res), res.headers.get('retry-after')]).toEqual([
      429,
      'attach-index-too-soon',
      '2',
    ]);
    const gone = makeApp({ putIndex: { kind: 'not-found' } });
    const missing = await gone.call(ATTACH_KEY, 'PUT', indexPath(live), undefined, bytes(index()));
    expect([missing.status, code(missing)]).toEqual([404, 'attach-not-found']);
    const ended = makeApp({
      putIndex: {
        kind: 'ended',
        attach: {
          attachId: ATTACH,
          tenantId: live,
          projectId: PROJECT,
          userId: DANA,
          tokenId: KEY,
          routeUrl: `https://${HOST}/s/1`,
          createdAt: NOW,
          endedAt: NOW,
          endedReason: 'key-revoked',
        },
      },
    });
    const over = await ended.call(ATTACH_KEY, 'PUT', indexPath(live), undefined, bytes(index()));
    expect([over.status, code(over), details(over)]).toEqual([
      409,
      'attach-ended',
      { endedReason: 'key-revoked' },
    ]);
  });

  test('only the attach key, and not for a suspended tenant', async () => {
    const { call, indexes } = makeApp();
    const full = await call(FULL_KEY, 'PUT', indexPath(live), undefined, bytes(index()));
    expect([full.status, code(full)]).toEqual([403, 'system-scope-missing']);
    const held = await call(ATTACH_KEY, 'PUT', indexPath(suspended), undefined, bytes(index()));
    expect([held.status, code(held)]).toEqual([409, 'tenant-suspended']);
    expect(indexes).toEqual([]);
  });
});

describe('DELETE …/attaches/:attachId', () => {
  test("ends it, a suspended tenant's too; no such attach is a 404; only the attach key", async () => {
    const { call, ends } = makeApp();
    const res = await call(ATTACH_KEY, 'DELETE', attachPath(live));
    expect([res.status, res.body.endedReason]).toEqual([200, 'ended']);
    expect((await call(ATTACH_KEY, 'DELETE', attachPath(suspended))).status).toBe(200);
    const missing = await call(ATTACH_KEY, 'DELETE', attachPath(live, randomUUID()));
    expect([missing.status, code(missing)]).toEqual([404, 'attach-not-found']);
    const full = await call(FULL_KEY, 'DELETE', attachPath(live));
    expect([full.status, code(full)]).toEqual([403, 'system-scope-missing']);
    expect(ends.map((e) => e.tenantId)).toEqual([live, suspended, live]);
  });
});

describe('createApp with systemAttaches', () => {
  test('refuses to start without what its checks read and its record, naming each', () => {
    const { input } = makeApp();
    const without = (...fields: readonly (keyof CreateAppInput)[]): CreateAppInput => {
      const copy: Record<string, unknown> = { ...input };
      for (const field of fields) delete copy[field];
      return copy as unknown as CreateAppInput;
    };
    for (const field of ['tokenAdmin', 'authz', 'systemTenantDirectory'] as const) {
      expect(() => createApp(without(field))).toThrow(`createApp: systemAttaches needs ${field}:`);
    }
    // Serving many tenants, a runtime without the record is refused before
    // this check is reached: so the record's is a runtime serving one.
    expect(() => createApp({ ...without('systemAccessAudit'), tenancy: 'single' })).toThrow(
      'createApp: systemAttaches needs systemAccessAudit:',
    );
    expect(() => createApp(without('tokenAdmin', 'authz'))).toThrow(
      'createApp: systemAttaches needs tokenAdmin, authz:',
    );
  });

  test("without it, the routes aren't there", async () => {
    const { input } = makeApp();
    const { systemAttaches: _systemAttaches, ...rest } = input;
    const app = createApp(rest);
    const res = await app.request(attachPath(live), {
      method: 'PUT',
      headers: { authorization: `Bearer ${ATTACH_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(404);
  });
});
