// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Changing an item more than one project serves (an environment order
 * carries it from staging to prod). A change in one project needs the
 * right on that project only, never the item's own on top (a pin
 * or an unpin there). A change that reaches every project (a
 * tenant's or an org's pinned version, unregistering or reinstating a
 * version) needs it on every project that version can run in. Deriving a
 * version is `write` where the item's new versions are made. A version
 * the caller can't see is asked as one that doesn't exist. An item with
 * one project is checked as before, check for check. A deployment's
 * promotion that pins what it moved asks the agent pin routes' one check
 * (`agentPinChangeRefusal`).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { userPrincipal } from '@kindgi/authz';
import type { AgentPinScope, ProjectId, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';
import { Hono } from 'hono';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinnedVersion,
  CreateAppInput,
  OrderItemKind,
  Pin,
  TokenResolver,
} from '../src/index.js';
import { agentPinChangeRefusal, itemRightsOf } from '../src/item-rights.js';
import { type Authorizer, createAuthorizer } from '../src/middleware/authorize.js';
import type { AppEnv } from '../src/types.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;
const OTHER = randomUUID() as ProjectId;
const ORG = randomUUID();
const NOW = '2026-10-01T00:00:00.000Z' as Timestamp;

/** The item an order carries (`acme.desk`), and one in a single project (`acme.solo`). */
const SERVED = 'acme.desk';
const SOLO = 'acme.solo';

/** Each kind with versions to unregister: its route, its registry, its id field, what a change asks. */
const KINDS = [
  {
    kind: 'agent',
    path: '/v1/agents',
    registry: 'agentRegistry',
    idKey: 'agentId',
    change: 'admin',
  },
  { kind: 'flow', path: '/v1/flows', registry: 'flowRegistry', idKey: 'flowId', change: 'admin' },
  { kind: 'tool', path: '/v1/tools', registry: 'toolRegistry', idKey: 'toolId', change: 'admin' },
  {
    kind: 'test_set',
    path: '/v1/test-sets',
    registry: 'testSetRegistry',
    idKey: 'testSetId',
    change: 'admin',
  },
  // Blocks are content agents pin: changing one is `write` (on every project it serves).
  {
    kind: 'block',
    path: '/v1/blocks',
    registry: 'blockRegistry',
    idKey: 'blockId',
    change: 'write',
  },
] as const;

/**
 * `0.9.0` was made in prod, before the order; `1.0.0` was made in staging
 * and pinned in prod; `1.1.0` is in staging only, the newest.
 */
function rows(): ItemRow[] {
  return [
    ...[...KINDS.map((k) => k.kind), 'guardrail' as const].flatMap((kind): ItemRow[] => [
      {
        kind: kind as OrderItemKind,
        id: SERVED,
        projects: [STAGING, PROD],
        ...(kind !== 'guardrail' && {
          versions: [
            { version: '0.9.0', projects: [PROD] },
            { version: '1.0.0', projects: [STAGING, PROD] },
            { version: '1.1.0', projects: [STAGING] },
          ],
        }),
      },
      {
        kind: kind as OrderItemKind,
        id: SOLO,
        projects: [OTHER],
        ...(kind !== 'guardrail' && { versions: [{ version: '1.0.0', projects: [OTHER] }] }),
      },
    ]),
  ];
}

const on = (project: ProjectId, ...actions: string[]) =>
  actions.map((a) => `${a} project:${project}` as Grant);

const PEOPLE: Record<string, readonly Grant[]> = {
  /** Runs both environments. */
  both: [...on(STAGING, 'read', 'write', 'admin'), ...on(PROD, 'read', 'write', 'admin')],
  /** Runs staging, and reads prod. */
  'staging-admin': [...on(STAGING, 'read', 'write', 'admin'), ...on(PROD, 'read')],
  /** Runs prod, and doesn't see staging. */
  'prod-admin': on(PROD, 'read', 'write', 'admin'),
  /** Reads prod. */
  'prod-reader': on(PROD, 'read'),
  /** The one-project item's admin, granted on the item as today. */
  solo: [
    ...on(OTHER, 'read', 'write', 'admin'),
    ...[...KINDS.map((k) => k.kind), 'guardrail'].flatMap((type) =>
      ['read', 'write', 'admin', 'publish', 'pin'].map((a) => `${a} ${type}:${SOLO}` as Grant),
    ),
  ],
};

const resolveToken: TokenResolver = async (token) => {
  const [who, keyProject] = token.split('@');
  if (who === undefined || !(who in PEOPLE)) return null;
  return {
    tenantId,
    userId: who as UserId,
    ...(keyProject !== undefined && { tokenProjectId: keyProject }),
  };
};

const rec = (id: string, version: string, projectId: ProjectId) => ({
  id,
  version,
  projectId,
  tenantId,
  name: id,
  publishedAt: NOW,
});

/**
 * A registry of one kind: the versions it reads, and every other method
 * (a change) recorded in `changed` before it fails, so a test sees the
 * request got past the checks to the handler.
 */
function registry(idKey: string, changed: string[]) {
  const records = [
    rec(SERVED, '0.9.0', STAGING),
    rec(SERVED, '1.0.0', STAGING),
    rec(SERVED, '1.1.0', STAGING),
    rec(SOLO, '1.0.0', OTHER),
  ];
  const versionsOf = (id: string) => records.filter((r) => r.id === id);
  const reads: Record<string, (input: Record<string, string>) => Promise<unknown>> = {
    get: async (input) => versionsOf(input[idKey] ?? '').at(-1) ?? null,
    getVersion: async (input) =>
      versionsOf(input[idKey] ?? '').find((r) => r.version === input.version) ?? null,
    headExists: async (input) => versionsOf(input[idKey] ?? '').length > 0,
    listVersions: async (input) => ({ data: versionsOf(input[idKey] ?? '') }),
  };
  return new Proxy(reads, {
    get(target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name in target) return target[name];
      if (name === 'readOnly') return undefined;
      return async () => {
        changed.push(name);
        throw new Error(`test: ${name} reached`);
      };
    },
  });
}

/** Pins and their changes of `acme.desk`: one per version, in the project it runs in. */
function pinsFake(changed: string[]) {
  const pin = (version: string, projectId: ProjectId): AgentPinnedVersion => ({
    agentId: SERVED,
    scope: { kind: 'project', projectId },
    version: version as Semver,
    changeId: `p-${version}`,
    setAt: NOW,
  });
  const change = (from: string, to: string, projectId: ProjectId): Pin => ({
    id: `p-${to}-${projectId === PROD ? 'prod' : 'staging'}`,
    agentId: SERVED,
    scope: { kind: 'project', projectId },
    action: 'pin',
    fromVersion: from as Semver,
    toVersion: to as Semver,
    requestedBy: { kind: 'user', id: 'both' },
    createdAt: NOW,
  });
  const reached = (name: string) => async () => {
    changed.push(name);
    throw new Error(`test: ${name} reached`);
  };
  const pinStore: AgentPinBindings = {
    pinned: {
      async resolve() {
        return null;
      },
      async list({ agentId }) {
        return agentId === SERVED
          ? [pin('0.9.0', PROD), pin('1.0.0', PROD), pin('1.1.0', STAGING)]
          : [];
      },
    },
    changes: {
      pin: reached('pin'),
      unpin: reached('unpin'),
      async list({ agentId }: { agentId: string }) {
        return {
          data:
            agentId === SERVED
              ? [change('1.0.0', '1.1.0', STAGING), change('0.9.0', '1.0.0', PROD)]
              : [],
        };
      },
      async get() {
        return null;
      },
    } as unknown as AgentPinBindings['changes'],
  };
  return pinStore;
}

/** The app over every kind. Without `served`, no item-projects binding: every item has one project. */
function harness(opts: { served?: boolean } = {}) {
  const changed: string[] = [];
  const registries = Object.fromEntries([
    ...KINDS.map((k) => [k.registry, registry(k.idKey, changed)]),
    ['guardrailRegistry', registry('guardrailId', changed)],
  ]) as unknown as Partial<CreateAppInput>;
  const items = itemProjects(rows());
  const authz = grantsAuthz(PEOPLE);
  const app = createApp({
    ...createStubAppBindings(),
    ...registries,
    agentPins: pinsFake(changed),
    // Mounts the test-set build; without `listCorrectedRuns` it answers 501
    // once its checks pass.
    correctionRegistry: {},
    evalCaseStore: {},
    resolveToken,
    authz: authz.authz,
    ...(opts.served !== false && { itemProjects: items }),
    environmentOrders: environmentOrders([[STAGING, PROD]]),
  } as CreateAppInput);
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const before = authz.asked.length;
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        'x-request-id': 'req-order-changes',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: JSON.parse(text) as Record<string, any>,
      /** The checks this request asked. */
      asked: authz.asked.slice(before),
    };
  };
  return { call, changed, items: items.asked };
}

const project = (projectId: ProjectId) => ({ kind: 'project', projectId });
const PIN_SCOPES = [
  {
    name: "prod's",
    scope: project(PROD),
    allowed: 'prod-admin',
    refused: 'staging-admin',
    on: [PROD],
  },
  {
    name: "a segment's in prod",
    scope: { kind: 'segment', projectId: PROD, path: [{ key: 'region', value: 'eu' }] },
    allowed: 'prod-admin',
    refused: 'staging-admin',
    on: [PROD],
  },
  {
    name: "the tenant's",
    scope: { kind: 'tenant' },
    allowed: 'both',
    refused: 'prod-admin',
    on: [STAGING, PROD],
  },
  {
    name: "an org's",
    scope: { kind: 'org', orgId: ORG },
    allowed: 'both',
    refused: 'staging-admin',
    on: [STAGING, PROD],
  },
] as const;

const PIN_CHANGES = [
  { path: 'pinned/pin', method: 'pin', body: { version: '1.0.0' } },
  { path: 'pinned/unpin', method: 'unpin', body: {} },
] as const;

describe.each(PIN_CHANGES)(
  "changing what's pinned for an agent an order carries: $path",
  (change) => {
    test.each(PIN_SCOPES)(
      "$name pinned version: admin there, and not the agent's own on top",
      async (s) => {
        const { call, changed } = harness();
        const path = `/v1/agents/${SERVED}/${change.path}`;
        // A pin (not an unpin) wider than one project would
        // span the order's environments: `409`, after the authorization,
        // so the handler is never reached.
        const spans =
          change.method !== 'unpin' && (s.scope.kind === 'tenant' || s.scope.kind === 'org');
        const ok = await call(s.allowed, 'POST', path, { ...change.body, scope: s.scope });
        // Rule 3/4: the project's right replaces the agent's; the authorization
        // runs (every project) whether or not the width check then refuses.
        expect(ok.asked).toEqual(s.on.map((p) => `${s.allowed} admin project:${p}`));
        if (spans) {
          expect(ok.status, ok.text).toBe(409);
          expect(ok.body.error.code).toBe('pin-scope-spans-environments');
        } else {
          expect(ok.status, ok.text).not.toBe(403);
        }
        expect(changed).toEqual(spans ? [] : [change.method]);

        const no = await call(s.refused, 'POST', path, { ...change.body, scope: s.scope });
        expect(no.status, no.text).toBe(403);
        expect(no.body.error.message).toContain('needs admin on each project it changes');
        expect(changed).toEqual(spans ? [] : [change.method]);
      },
    );
  },
);

describe('a project-scoped key', () => {
  test("a staging key can't pin a version in prod, though its user runs prod", async () => {
    const { call, changed } = harness();
    const res = await call(`both@${STAGING}`, 'POST', `/v1/agents/${SERVED}/pinned/pin`, {
      version: '1.0.0',
      scope: project(PROD),
    });
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toContain(`is limited to project ${STAGING}`);
    expect(changed).toEqual([]);
  });

  test("a staging key can't change what's pinned for the whole tenant", async () => {
    const { call } = harness();
    const res = await call(`both@${STAGING}`, 'POST', `/v1/agents/${SERVED}/pinned/unpin`, {
      scope: { kind: 'tenant' },
    });
    expect(res.status, res.text).toBe(403);
  });

  test('a prod key pins in prod', async () => {
    const { call, changed } = harness();
    const res = await call(`prod-admin@${PROD}`, 'POST', `/v1/agents/${SERVED}/pinned/pin`, {
      version: '1.0.0',
      scope: project(PROD),
    });
    expect(res.status, res.text).not.toBe(403);
    expect(changed).toEqual(['pin']);
  });
});

describe.each(KINDS)('unregistering a version of a $kind an order carries', (k) => {
  const at = (version: string, verb = 'unregister') =>
    `${k.path}/${SERVED}/versions/${version}/${verb}`;

  test(`a version in staging and prod: ${k.change} on both, not only where it was made`, async () => {
    const { call, changed } = harness();
    const no = await call('staging-admin', 'POST', at('1.0.0'));
    expect(no.status, no.text).toBe(403);
    expect(no.body.error.message).toContain(`refused on project ${PROD}`);
    expect(changed).toEqual([]);

    const ok = await call('both', 'POST', at('1.0.0'));
    expect(ok.status, ok.text).not.toBe(403);
    expect(ok.asked).toEqual(
      expect.arrayContaining([
        `both ${k.change} project:${STAGING}`,
        `both ${k.change} project:${PROD}`,
      ]),
    );
    expect(changed.length).toBeGreaterThan(0);
  });

  test("a version in staging only: staging's right, though prod serves the item", async () => {
    const { call, changed } = harness();
    const res = await call('staging-admin', 'POST', at('1.1.0'));
    expect(res.status, res.text).not.toBe(403);
    expect(res.asked).not.toContain(`staging-admin ${k.change} project:${PROD}`);
    expect(changed.length).toBeGreaterThan(0);
  });

  test('reinstating is checked the same way', async () => {
    const { call } = harness();
    expect((await call('staging-admin', 'POST', at('1.0.0', 'reinstate'))).status).toBe(403);
    expect((await call('both', 'POST', at('1.0.0', 'reinstate'))).status).not.toBe(403);
  });

  test("a version the caller can't see answers as one that isn't there, byte for byte", async () => {
    const { call, changed } = harness();
    // 1.1.0 runs in staging only, which a prod admin doesn't see.
    const hidden = await call('prod-admin', 'POST', at('1.1.0'));
    const missing = await call('prod-admin', 'POST', at('9.9.9'));
    expect(hidden.status, hidden.text).toBe(missing.status);
    expect(hidden.text.replaceAll('1.1.0', '9.9.9')).toBe(missing.text);
    expect(hidden.asked).toEqual(missing.asked);
    expect(changed).toEqual([]);
  });

  test('an item with one project: the same answers and checks as without an order', async () => {
    const withBinding = harness();
    const without = harness({ served: false });
    for (const path of [
      `${k.path}/${SOLO}/versions/1.0.0/unregister`,
      `${k.path}/${SOLO}/versions/1.0.0/reinstate`,
    ]) {
      const a = await withBinding.call('solo', 'POST', path);
      const b = await without.call('solo', 'POST', path);
      expect(a.text).toBe(b.text);
      expect(a.asked).toEqual(b.asked);
    }
    expect(withBinding.changed).toEqual(without.changed);
  });
});

describe('unregistering a guardrail an order carries', () => {
  const path = `/v1/guardrails/${SERVED}/unregister`;

  test('admin on every project that serves it', async () => {
    const { call, changed } = harness();
    const no = await call('prod-admin', 'POST', path);
    expect(no.status, no.text).toBe(403);
    expect(no.body.error.message).toContain(`refused on project ${STAGING}`);
    expect(changed).toEqual([]);
    const ok = await call('both', 'POST', path);
    expect(ok.status, ok.text).not.toBe(403);
    expect(ok.asked).toEqual([`both admin project:${STAGING}`, `both admin project:${PROD}`]);
  });

  test('a guardrail with one project: as before', async () => {
    const a = await harness().call('solo', 'POST', `/v1/guardrails/${SOLO}/unregister`);
    const b = await harness({ served: false }).call(
      'solo',
      'POST',
      `/v1/guardrails/${SOLO}/unregister`,
    );
    expect(a.text).toBe(b.text);
    expect(a.asked).toEqual(b.asked);
  });
});

describe('deriving a version of an agent an order carries', () => {
  const path = `/v1/agents/${SERVED}/versions`;
  const body = { fromVersion: '1.0.0', changes: {} };

  test("write in the order's first environment, where its new versions are made", async () => {
    const { call } = harness();
    const no = await call('prod-admin', 'POST', path, body);
    expect(no.status, no.text).toBe(403);
    expect(no.body.error.message).toContain(`refused on project ${STAGING}`);
    const ok = await call('staging-admin', 'POST', path, body);
    expect(ok.status, ok.text).not.toBe(403);
    expect(ok.asked).toEqual([`staging-admin write project:${STAGING}`]);
  });

  test('an agent with one project: publish on the agent, as before', async () => {
    const a = await harness().call('solo', 'POST', `/v1/agents/${SOLO}/versions`, body);
    const b = await harness({ served: false }).call(
      'solo',
      'POST',
      `/v1/agents/${SOLO}/versions`,
      body,
    );
    expect(a.text).toBe(b.text);
    expect(a.asked).toEqual(b.asked);
  });
});

describe('building a test set from corrections under a test set an order carries', () => {
  const path = (testSetId: string) => `/v1/test-sets/${testSetId}/versions/from-corrections`;
  const body = (projectId: ProjectId) => ({
    version: '2.0.0',
    projectId,
    agentId: 'acme.matcher',
  });
  /** Past every check: the build itself, which this deployment can't do. */
  const BUILT = 501;

  test('admin in the project whose corrected runs it takes, and nowhere else', async () => {
    const { call } = harness();
    const prod = await call('prod-admin', 'POST', path(SERVED), body(PROD));
    expect(prod.status, prod.text).toBe(BUILT);
    expect(prod.asked).toEqual([
      `prod-admin admin project:${PROD}`,
      `prod-admin admin project:${PROD}`,
    ]);
    const staging = await call('staging-admin', 'POST', path(SERVED), body(STAGING));
    expect(staging.status, staging.text).toBe(BUILT);
    expect(staging.asked).toEqual([
      `staging-admin admin project:${STAGING}`,
      `staging-admin admin project:${STAGING}`,
    ]);
  });

  test("another project's admin is refused, naming the project", async () => {
    const no = await harness().call('prod-admin', 'POST', path(SERVED), body(STAGING));
    expect(no.status, no.text).toBe(403);
    expect(no.body.error.message).toContain(`refused on project ${STAGING}`);
  });

  test("a project the test set isn't in: admin on every project of the test set", async () => {
    const no = await harness().call('prod-admin', 'POST', path(SERVED), body(OTHER));
    expect(no.status, no.text).toBe(403);
    expect(no.body.error.message).toContain(`refused on project ${STAGING}`);
  });

  test('a test set with one project: the same answers and checks as without an order', async () => {
    const a = await harness().call('solo', 'POST', path(SOLO), body(OTHER));
    const b = await harness({ served: false }).call('solo', 'POST', path(SOLO), body(OTHER));
    expect(a.status, a.text).toBe(BUILT);
    expect(a.text).toBe(b.text);
    expect(a.asked).toEqual(b.asked);
  });
});

describe("an agent's pinned versions and pin history, read by a prod member", () => {
  test('pinned-versions lists only the pins of versions that run in prod', async () => {
    const { call } = harness();
    const res = await call('prod-reader', 'GET', `/v1/agents/${SERVED}/pinned-versions`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data.map((p: { version: string }) => p.version)).toEqual(['0.9.0', '1.0.0']);
  });

  test('pin-history lists only those whose versions run in prod', async () => {
    const { call } = harness();
    const res = await call('prod-reader', 'GET', `/v1/agents/${SERVED}/pin-history`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data.map((p: { toVersion: string }) => p.toVersion)).toEqual(['1.0.0']);
  });

  test('a staging admin who reads prod sees every pin', async () => {
    const { call } = harness();
    const res = await call('staging-admin', 'GET', `/v1/agents/${SERVED}/pinned-versions`);
    expect(res.body.data).toHaveLength(3);
  });

  test("a prod member can't see whether a staging-only version is pinned", async () => {
    const { call } = harness();
    const res = await call('prod-reader', 'GET', `/v1/agents/${SERVED}/versions/1.1.0`);
    expect(res.status, res.text).toBe(404);
  });
});

describe("agentPinChangeRefusal: the one check a change to what's pinned asks", () => {
  /** Asks it as `who` at `scope`, in a request whose body it must leave unread. */
  async function refusal(
    who: string,
    agentId: string,
    scope: AgentPinScope | undefined,
    opts: { served?: boolean; setsPin?: boolean; orders?: ProjectId[][] } = {},
  ) {
    const authz = grantsAuthz(PEOPLE);
    const authorizer = createAuthorizer(authz.authz.authzCheckBinding);
    const rights = itemRightsOf(
      authorizer,
      opts.served === false ? undefined : itemProjects(rows()),
      environmentOrders(opts.orders ?? [[STAGING, PROD]]),
    );
    let bodyRead: boolean | undefined;
    const r = new Hono<AppEnv>();
    r.post('/', async (c) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-pin-change' as never);
      c.set('principal' as never, userPrincipal(who as UserId, tenantId) as never);
      const refused = await agentPinChangeRefusal(c, {
        authorizer,
        rights,
        agentId,
        scope,
        ...(opts.setsPin !== undefined && { setsPin: opts.setsPin }),
      });
      bodyRead = Object.keys(c.req.bodyCache).length > 0;
      return refused ?? c.json({ allowed: true });
    });
    const res = await r.request('/', { method: 'POST', body: 'not a body it reads' });
    const text = await res.text();
    return {
      status: res.status,
      body: JSON.parse(text) as Record<string, any>,
      asked: authz.asked,
      bodyRead,
    };
  }

  test.each(PIN_SCOPES)(
    '$name pinned version: admin there, as the pin routes ask it',
    async (s) => {
      const scope = s.scope as unknown as AgentPinScope;
      const ok = await refusal(s.allowed, SERVED, scope);
      expect(ok.body).toEqual({ allowed: true });
      expect(ok.asked).toEqual(s.on.map((p) => `${s.allowed} admin project:${p}`));
      expect(ok.bodyRead).toBe(false);

      const no = await refusal(s.refused, SERVED, scope);
      expect(no.status).toBe(403);
      expect(no.body.error.message).toContain('needs admin on each project it changes');
      expect(no.bodyRead).toBe(false);
    },
  );

  test.each([true, false])(
    'an agent with one project (an item-projects binding: %s): pin on the agent, as before',
    async (served) => {
      const scope = project(OTHER) as unknown as AgentPinScope;
      const ok = await refusal('solo', SOLO, scope, { served });
      expect(ok.body).toEqual({ allowed: true });
      expect(ok.asked).toEqual([`solo pin agent:${SOLO}`]);

      const no = await refusal('prod-admin', SOLO, scope, { served });
      expect(no.status).toBe(403);
      expect(no.body.error).toMatchObject({
        code: 'permission-denied',
        details: { action: 'pin', resource: `agent:${SOLO}` },
        requestId: 'req-pin-change',
      });
      expect(no.asked).toEqual([`prod-admin pin agent:${SOLO}`]);
      expect(no.bodyRead).toBe(false);
    },
  );

  test.each(PIN_SCOPES.filter((s) => s.scope.kind === 'tenant' || s.scope.kind === 'org'))(
    '$name pin for an agent an order carries: `409` after the authorization passes',
    async (s) => {
      const res = await refusal(s.allowed, SERVED, s.scope as unknown as AgentPinScope, {
        setsPin: true,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('pin-scope-spans-environments');
      // The authorization ran first, on every project, so an unauthorized wide pin is the 403.
      expect(res.asked).toEqual(s.on.map((p) => `${s.allowed} admin project:${p}`));
      expect(res.bodyRead).toBe(false);
    },
  );

  test.each(PIN_SCOPES.filter((s) => s.scope.kind === 'project' || s.scope.kind === 'segment'))(
    '$name pin within one project: allowed, no width refusal',
    async (s) => {
      const res = await refusal(s.allowed, SERVED, s.scope as unknown as AgentPinScope, {
        setsPin: true,
      });
      expect(res.body).toEqual({ allowed: true });
    },
  );

  test('a tenant-wide unpin (not a pin) for an agent an order carries: allowed', async () => {
    const res = await refusal('both', SERVED, { kind: 'tenant' }, { setsPin: false });
    expect(res.body).toEqual({ allowed: true });
    expect(res.asked).toEqual([`both admin project:${STAGING}`, `both admin project:${PROD}`]);
  });

  test('a one-project agent pin tenant-wide: today’s pin check, never a width refusal', async () => {
    const res = await refusal('solo', SOLO, { kind: 'tenant' }, { setsPin: true });
    expect(res.body).toEqual({ allowed: true });
    expect(res.asked).toEqual([`solo pin agent:${SOLO}`]);
  });

  // M1: the width refusal is keyed on order membership, not on project count.
  // One project serves this agent, and that project is an order's first
  // environment, so a tenant- or org-wide pin still spans the order.
  test.each([
    { name: 'tenant-wide', scope: { kind: 'tenant' } as const },
    { name: 'org-wide', scope: { kind: 'org', orgId: ORG } as const },
  ])(
    'a one-project agent whose project is in an order: a $name pin spans it (409), after today’s pin check',
    async ({ scope }) => {
      const res = await refusal('solo', SOLO, scope as unknown as AgentPinScope, {
        setsPin: true,
        orders: [[OTHER, PROD]],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('pin-scope-spans-environments');
      // S1/N5: the message names the scope asked for and the order it spans,
      // so a reword that drops either regresses here.
      expect(res.body.error.message).toContain(
        scope.kind === 'org' ? 'org-wide pin' : 'tenant-wide pin',
      );
      expect(res.body.error.message).toContain('environment order at once');
      // The shape a flow's and a tool's refusal use: it names the agent, and
      // says nothing was pinned.
      expect(res.body.error.message).toContain(`of agent "${SOLO}" would act across`);
      expect(res.body.error.message).toMatch(/Nothing was pinned\.$/);
      // The authorization still ran first (today’s pin on the agent).
      expect(res.asked).toEqual([`solo pin agent:${SOLO}`]);
      expect(res.bodyRead).toBe(false);
    },
  );

  // The inverse: more than one project serves the agent, but none is in any
  // order, so a wide pin is today’s multi-project admin check, not a 409.
  test('a multi-project agent in no order pin tenant-wide: today’s admin check, never a width refusal', async () => {
    const res = await refusal(
      'both',
      SERVED,
      { kind: 'tenant' },
      {
        setsPin: true,
        orders: [[OTHER]],
      },
    );
    expect(res.body).toEqual({ allowed: true });
    expect(res.asked).toEqual([`both admin project:${STAGING}`, `both admin project:${PROD}`]);
  });

  test('an authorizer that neither allows the change nor answers: an error, never allowed', async () => {
    const silent: Authorizer = {
      authorize: () => async () => undefined,
      can: async () => false,
      canFor: async () => {
        throw new Error('unused');
      },
      check: async () => {
        throw new Error('unused');
      },
      filterByCan: async () => [],
    };
    let outcome: unknown;
    const r = new Hono<AppEnv>();
    r.post('/', async (c) => {
      outcome = await agentPinChangeRefusal(c, {
        authorizer: silent,
        rights: undefined,
        agentId: SOLO,
        scope: undefined,
      }).then(
        (answer) => ({ answer }),
        (e: Error) => ({ thrown: e.message }),
      );
      return c.json({});
    });
    await r.request('/', { method: 'POST' });
    expect(outcome).toEqual({
      thrown: 'The authorizer neither allowed the change nor refused it',
    });
  });
});
