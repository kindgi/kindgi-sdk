// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Reading an item more than one project serves (an environment order
 * carries it from staging to prod): the caller reads it through any of its
 * projects, and sees each version that can run in a project it reads. A
 * single read answers the newest such version (or, with `?projectId=`,
 * the newest that can run in that project); a list row is that version
 * too. A version the caller can't see answers as one that doesn't exist.
 * An item with one project reads as before, check for check.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  CreateAppInput,
  IdentityDirectoryBinding,
  OrderItemKind,
  TokenResolver,
} from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;
const OTHER = randomUUID() as ProjectId;
const DEFAULT = randomUUID() as ProjectId;

/** Each kind with a single read: its route, its registry, its id field and its type in grants. */
const KINDS = [
  { kind: 'agent', path: '/v1/agents', registry: 'agentRegistry', idKey: 'agentId', type: 'agent' },
  { kind: 'flow', path: '/v1/flows', registry: 'flowRegistry', idKey: 'flowId', type: 'flow' },
  { kind: 'tool', path: '/v1/tools', registry: 'toolRegistry', idKey: 'toolId', type: 'tool' },
  {
    kind: 'test_set',
    path: '/v1/test-sets',
    registry: 'testSetRegistry',
    idKey: 'testSetId',
    type: 'test_set',
  },
  {
    kind: 'block',
    path: '/v1/blocks',
    registry: 'blockRegistry',
    idKey: 'blockId',
    type: undefined,
  },
] as const;
type Kind = (typeof KINDS)[number];

/** The item an order carries (`acme.desk`), and one in a single project (`acme.solo`). */
const SERVED = 'acme.desk';
const SOLO = 'acme.solo';
/** An agent from before the order, adopted into it: first published in the default project. */
const ADOPTED = 'acme.adopted';

/**
 * `0.9.0` was made in prod, before the order; `1.0.0` was made in staging
 * and promoted to prod; `1.1.0` is in staging only, the newest. With
 * `retired`, every version of the order's item is unregistered.
 */
function rows(retired = false): ItemRow[] {
  return [
    ...KINDS.flatMap(({ kind }): ItemRow[] => [
      {
        kind: kind as OrderItemKind,
        id: SERVED,
        projects: [STAGING, PROD],
        versions: [
          { version: '0.9.0', projects: [PROD] },
          { version: '1.0.0', projects: [STAGING, PROD] },
          { version: '1.1.0', projects: [STAGING] },
        ].map((v) => (retired ? { ...v, active: false } : v)),
      },
      {
        kind: kind as OrderItemKind,
        id: SOLO,
        projects: [OTHER],
        versions: [
          { version: '1.0.0', projects: [OTHER] },
          { version: '2.0.0', projects: [OTHER] },
        ],
      },
    ]),
    {
      kind: 'agent',
      id: ADOPTED,
      projects: [DEFAULT, STAGING],
      versions: [{ version: '1.0.0', projects: [DEFAULT, STAGING] }],
    },
  ];
}

/** Who owns each agent, with `owned`, and the name the directory has for them. */
const OWNER = 'user-acme-owner' as UserId;
const OWNER_NAME = 'Acme Owner';
const directory = {
  async getUser({ userId }: { userId: UserId }) {
    return userId === OWNER
      ? { userId, tenantId, createdAt: '2026-10-01T00:00:00.000Z', displayName: OWNER_NAME }
      : null;
  },
} as unknown as IdentityDirectoryBinding;

/** When the retired item's versions were unregistered. */
const RETIRED_AT = '2026-10-20T00:00:00.000Z';

/**
 * A version record every kind's serializer reads; `projectId` undefined: one
 * that names none; with `unregisteredAt`, an unregistered one.
 */
function rec(
  id: string,
  version: string,
  projectId: ProjectId | undefined,
  unregisteredAt?: string,
) {
  return {
    id,
    version,
    ...(projectId !== undefined && { projectId }),
    ...(unregisteredAt !== undefined && { unregisteredAt }),
    tenantId,
    name: id,
    description: id,
    instructions: 'Answer the desk.',
    capabilities: [],
    tools: [],
    retrieval: [],
    guardrails: [],
    nodes: [],
    edges: [],
    input: {},
    output: {},
    kind: 'prompt',
    spec: {},
    content: 'hello',
    publishedAt: '2026-10-01T00:00:00.000Z',
  };
}
type Rec = ReturnType<typeof rec>;

/**
 * A registry of one kind over `records` (oldest first), as each read route
 * asks it. Its list leaves out an item whose every version is unregistered,
 * unless `includeRetired`.
 */
function registry(idKey: string, records: readonly Rec[]) {
  const versionsOf = (id: string) => records.filter((r) => r.id === id);
  const latest = (id: string) => versionsOf(id).at(-1) ?? null;
  const ids = () => [...new Set(records.map((r) => r.id))].sort();
  const inUse = (id: string) => versionsOf(id).some((r) => r.unregisteredAt === undefined);
  return {
    async list(input: { includeRetired?: boolean } = {}) {
      return {
        data: ids()
          .filter((id) => input.includeRetired === true || inUse(id))
          .map((id) => latest(id))
          .filter((r) => r !== null),
      };
    },
    async get(input: Record<string, string>) {
      return latest(input[idKey] ?? '');
    },
    async getVersion(input: Record<string, string>) {
      return versionsOf(input[idKey] ?? '').find((r) => r.version === input.version) ?? null;
    },
    async headExists(input: Record<string, string>) {
      return versionsOf(input[idKey] ?? '').length > 0;
    },
    async listVersions(input: Record<string, string>) {
      return { data: versionsOf(input[idKey] ?? '') };
    },
  };
}

const PEOPLE: Record<string, readonly Grant[]> = {
  /** A prod member who isn't in staging. */
  prod: [`read project:${PROD}`],
  /** A staging member who isn't in prod. */
  staging: [`read project:${STAGING}`],
  /** A direct grant on each item, and no project. */
  direct: KINDS.flatMap((k) => (k.type === undefined ? [] : [`read ${k.type}:${SERVED}` as Grant])),
  /** A reader of the one-project items. */
  solo: [
    `read project:${OTHER}`,
    ...KINDS.flatMap((k) => (k.type === undefined ? [] : [`read ${k.type}:${SOLO}` as Grant])),
  ],
  /** Reads `acme.desk` directly, with a key limited to another project. */
  'other-key': [`read agent:${SERVED}`, `read project:${OTHER}`],
  /** Reads prod, with a key limited to prod. */
  'prod-key': [`read project:${PROD}`],
  /** May run in prod, and reads nothing: everyone may run there. */
  'prod-runner': [`run project:${PROD}`],
  /** May run the one-project items' project, and reads nothing. */
  'solo-runner': [`run project:${OTHER}`],
  nobody: [],
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

/**
 * The app over every kind's records: the order's item at its three
 * versions (all filed under staging, its first project), the one-project
 * item in `other`, and the adopted agent in the default. Without `served`, no
 * item-projects binding: every item has one project. Without `authorized`,
 * no authorizer. With `projectless`, no record names a project, as
 * `kindgi dev`'s pack read from disk. With `retired`, every version of the
 * order's item is unregistered. With `owned`, every agent has an owner the
 * directory names.
 */
function harness(
  opts: {
    served?: boolean;
    ordered?: boolean;
    soloOnly?: boolean;
    authorized?: boolean;
    projectless?: boolean;
    retired?: boolean;
    owned?: boolean;
  } = {},
) {
  const at = (projectId: ProjectId) => (opts.projectless === true ? undefined : projectId);
  const off = opts.retired === true ? RETIRED_AT : undefined;
  const records = (prefix: string) =>
    [
      rec(SERVED, '0.9.0', at(STAGING), off),
      rec(SERVED, '1.0.0', at(STAGING), off),
      rec(SERVED, '1.1.0', at(STAGING), off),
      rec(SOLO, '1.0.0', at(OTHER)),
      rec(SOLO, '2.0.0', at(OTHER)),
      ...(prefix === 'agent' ? [rec(ADOPTED, '1.0.0', at(DEFAULT))] : []),
    ]
      .filter((r) => opts.soloOnly !== true || r.id === SOLO)
      // A test set's kind is an eval kind, and the list holds those it lists.
      .map((r) => (prefix === 'test_set' ? { ...r, kind: 'custom' } : r))
      .map((r) =>
        prefix === 'agent' && opts.owned === true ? { ...r, owner: { userId: OWNER } } : r,
      );
  const registries = Object.fromEntries(
    KINDS.map((k) => [k.registry, registry(k.idKey, records(k.kind))]),
  ) as unknown as Partial<CreateAppInput>;
  const items = itemProjects(rows(opts.retired === true));
  const authz = grantsAuthz(PEOPLE, { [`agent:${SERVED}`]: STAGING, [`agent:${SOLO}`]: OTHER });
  const app = createApp({
    ...createStubAppBindings(),
    ...registries,
    resolveToken,
    ...(opts.authorized !== false && { authz: authz.authz }),
    ...(opts.served !== false && { itemProjects: items }),
    ...(opts.ordered !== false && { environmentOrders: environmentOrders([[STAGING, PROD]]) }),
    ...(opts.owned === true && { identityDirectory: directory }),
  } as CreateAppInput);
  const get = async (who: string, path: string) => {
    const res = await app.request(path, {
      headers: { authorization: `Bearer ${who}`, 'x-request-id': 'req-order-items' },
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  const head = async (who: string, path: string) =>
    (
      await app.request(path, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${who}`, 'x-request-id': 'req-order-items' },
      })
    ).status;
  return { get, head, asked: authz.asked, batches: authz.batches, items: items.asked };
}

const pathOf = (k: Kind, id: string, rest = '') => `${k.path}/${id}${rest}`;

describe.each(KINDS)('a $kind that an order carries: GET /:id', (k) => {
  test("a prod member gets prod's newest version, not staging's newer one", async () => {
    const { get } = harness();
    const res = await get('prod', pathOf(k, SERVED));
    expect(res.status, res.text).toBe(200);
    expect(res.body.version).toBe('1.0.0');
  });

  test("a staging member gets staging's newest", async () => {
    const { get } = harness();
    expect((await get('staging', pathOf(k, SERVED))).body.version).toBe('1.1.0');
  });

  test('?projectId=prod: the newest that can run in prod, for a prod member', async () => {
    const { get } = harness();
    const res = await get('prod', pathOf(k, SERVED, `?projectId=${PROD}`));
    expect(res.status, res.text).toBe(200);
    expect(res.body.version).toBe('1.0.0');
    expect((await get('staging', pathOf(k, SERVED, `?projectId=${STAGING}`))).body.version).toBe(
      '1.1.0',
    );
  });

  test('?projectId= a project the caller does not read: 404, the same bytes whether or not the item runs there', async () => {
    const { get } = harness();
    const servedThere = await get('staging', pathOf(k, SERVED, `?projectId=${PROD}`));
    expect(servedThere.status, servedThere.text).toBe(404);
    const notThere = await get('staging', pathOf(k, SERVED, `?projectId=${OTHER}`));
    expect(servedThere.text).toBe(notThere.text);
  });

  test("?projectId= a project outside the item's: 404", async () => {
    const { get } = harness();
    const res = await get('prod', pathOf(k, SERVED, `?projectId=${OTHER}`));
    expect(res.status, res.text).toBe(404);
  });

  test('?projectId= that is not a project id: 400 bad-input', async () => {
    const { get } = harness();
    const res = await get('prod', pathOf(k, SERVED, '?projectId=prod'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });

  test('a one-project item: its latest, ?projectId= its own project the same, any other 404', async () => {
    const { get } = harness();
    expect((await get('solo', pathOf(k, SOLO))).body.version).toBe('2.0.0');
    expect((await get('solo', pathOf(k, SOLO, `?projectId=${OTHER}`))).body.version).toBe('2.0.0');
    expect((await get('solo', pathOf(k, SOLO, `?projectId=${PROD}`))).status).toBe(404);
  });

  test('a version the caller can see answers; one it cannot answers exactly as a missing one', async () => {
    const { get } = harness();
    expect((await get('prod', pathOf(k, SERVED, '/versions/0.9.0'))).status).toBe(200);
    expect((await get('staging', pathOf(k, SERVED, '/versions/1.1.0'))).status).toBe(200);
    const hidden = await get('prod', pathOf(k, SERVED, '/versions/1.1.0'));
    const missing = await get(
      'prod',
      pathOf(k, SERVED, '/versions/1.1.0'.replace('1.1.0', '9.9.9')),
    );
    expect(hidden.status, hidden.text).toBe(404);
    // Byte for byte, but for the version each names.
    expect(hidden.text.replaceAll('1.1.0', 'V')).toBe(missing.text.replaceAll('9.9.9', 'V'));
  });

  test('the versions list holds only the versions the caller can see', async () => {
    const { get } = harness();
    const versions = async (who: string) =>
      ((await get(who, pathOf(k, SERVED, '/versions'))).body.data as { version: string }[]).map(
        (v) => v.version,
      );
    expect(await versions('prod')).toEqual(['0.9.0', '1.0.0']);
    expect(await versions('staging')).toEqual(['1.0.0', '1.1.0']);
  });

  test("a list row is the caller's newest version", async () => {
    const { get } = harness();
    const row = async (who: string) =>
      ((await get(who, k.path)).body.data as { id: string; version: string }[]).find(
        (r) => r.id === SERVED,
      );
    expect((await row('prod'))?.version).toBe('1.0.0');
    expect((await row('staging'))?.version).toBe('1.1.0');
    expect(await row('nobody')).toBeUndefined();
  });

  test("a retired item: listed only with ?includeRetired=true, its row the caller's newest version", async () => {
    const { get } = harness({ retired: true });
    const row = async (who: string, query = '') =>
      ((await get(who, `${k.path}${query}`)).body.data as { id: string }[]).find(
        (r) => r.id === SERVED,
      );
    expect(await row('prod')).toBeUndefined();
    expect(await row('prod', '?includeRetired=true')).toMatchObject({
      version: '1.0.0',
      unregisteredAt: RETIRED_AT,
    });
    expect(await row('staging', '?includeRetired=true')).toMatchObject({
      version: '1.1.0',
      unregisteredAt: RETIRED_AT,
    });
    expect(await row('nobody', '?includeRetired=true')).toBeUndefined();
  });

  test('a list page asks the binding once for its projects and checks its projects in one batch per action', async () => {
    const { get, items, batches } = harness();
    await get('prod', k.path);
    expect(items.filter((a) => a.startsWith('projectsOfMany'))).toHaveLength(1);
    expect(items.filter((a) => a.startsWith('newestVisibleOfMany'))).toHaveLength(1);
    const onProjects = (action: string) =>
      batches.filter(
        (b) => b.startsWith(`${action} `) && (b.includes(STAGING) || b.includes(PROD)),
      );
    expect(onProjects('read')).toHaveLength(1);
    // The agent and flow lists hold what the caller may run too: one `run`
    // batch, on the projects it doesn't read.
    expect(onProjects('run')).toHaveLength(k.kind === 'agent' || k.kind === 'flow' ? 1 : 0);
  });

  test('a page of one-project items: no project batch, no newest-version ask, the same checks as before', async () => {
    const withBinding = harness({ soloOnly: true });
    const without = harness({ soloOnly: true, served: false });
    const a = await withBinding.get('solo', k.path);
    const b = await without.get('solo', k.path);
    expect(a.text).toBe(b.text);
    expect(withBinding.asked).toEqual(without.asked);
    expect(withBinding.batches).toEqual(without.batches);
    expect(withBinding.items).toEqual([`projectsOfMany ${k.kind}`]);
  });

  test('after the order is cleared, the item keeps the rules', async () => {
    const { get } = harness({ ordered: false });
    expect((await get('prod', pathOf(k, SERVED))).body.version).toBe('1.0.0');
    expect((await get('prod', pathOf(k, SERVED, '/versions/1.1.0'))).status).toBe(404);
  });
});

describe('agents and flows a person may run, though not read', () => {
  const agent = KINDS.find((k) => k.kind === 'agent') as Kind;
  const flow = KINDS.find((k) => k.kind === 'flow') as Kind;
  const ids = (res: { body: Record<string, any> }) =>
    (res.body.data as { id: string; version: string }[]).map((r) => `${r.id}@${r.version}`);

  test.each([agent, flow])(
    "the $kind list holds those in a project it may run, an order's at that project's newest, and no other",
    async (k) => {
      const { get } = harness();
      expect(ids(await get('solo-runner', k.path))).toEqual([`${SOLO}@2.0.0`]);
      expect(ids(await get('prod-runner', k.path))).toEqual([`${SERVED}@1.0.0`]);
      expect(ids(await get('nobody', k.path))).toEqual([]);
    },
  );

  test.each([agent, flow])(
    "the $kind list's project filter passes on run there, and is read's 403 elsewhere",
    async (k) => {
      const { get } = harness();
      const filtered = (projectId: string) => `${k.path}?scopeKind=project&scopeId=${projectId}`;
      expect((await get('solo-runner', filtered(OTHER))).status).toBe(200);
      expect((await get('solo-runner', filtered(PROD))).status).toBe(403);
    },
  );

  test("a flow reads on run in its project; an order's at the newest that project runs", async () => {
    const { get } = harness();
    const solo = await get('solo-runner', pathOf(flow, SOLO));
    expect(solo.status, solo.text).toBe(200);
    expect(solo.body.version).toBe('2.0.0');
    const served = await get('prod-runner', pathOf(flow, SERVED));
    expect(served.status, served.text).toBe(200);
    expect(served.body.version).toBe('1.0.0');
  });

  test.each([agent, flow])(
    "the $kind's versions and one of them read on run in its project; an order's, those that run there",
    async (k) => {
      const { get, head } = harness();
      const soloList = await get('solo-runner', pathOf(k, SOLO, '/versions'));
      expect(soloList.status, soloList.text).toBe(200);
      expect(ids(soloList)).toEqual([`${SOLO}@1.0.0`, `${SOLO}@2.0.0`]);
      const soloOne = await get('solo-runner', pathOf(k, SOLO, '/versions/2.0.0'));
      expect(soloOne.status, soloOne.text).toBe(200);
      expect(soloOne.body.version).toBe('2.0.0');
      expect(ids(await get('prod-runner', pathOf(k, SERVED, '/versions')))).toEqual([
        `${SERVED}@0.9.0`,
        `${SERVED}@1.0.0`,
      ]);
      expect((await get('prod-runner', pathOf(k, SERVED, '/versions/1.0.0'))).status).toBe(200);
      // Staging's alone: as one that doesn't exist.
      expect((await get('prod-runner', pathOf(k, SERVED, '/versions/1.1.0'))).status).toBe(404);
      for (const rest of ['', '/versions', '/versions/2.0.0']) {
        expect(await head('solo-runner', pathOf(k, SOLO, rest))).toBe(200);
      }
    },
  );

  test.each([agent, flow])(
    "a $kind in a project it may not run is read's 403: by id, its versions, one of them, and their HEAD",
    async (k) => {
      const { get, head } = harness();
      for (const [who, id] of [
        ['prod-runner', SOLO],
        ['solo-runner', SERVED],
      ] as const) {
        for (const rest of ['', '/versions', '/versions/1.0.0']) {
          expect((await get(who, pathOf(k, id, rest))).status).toBe(403);
          expect(await head(who, pathOf(k, id, rest))).toBe(403);
        }
      }
    },
  );

  test('an agent reads on run in its project, its owner by id alone; a reader gets the name', async () => {
    const { get } = harness({ owned: true });
    const solo = await get('solo-runner', pathOf(agent, SOLO));
    expect(solo.status, solo.text).toBe(200);
    expect(solo.body.version).toBe('2.0.0');
    expect(solo.body.owner).toEqual({ userId: OWNER });
    const served = await get('prod-runner', pathOf(agent, SERVED));
    expect(served.status, served.text).toBe(200);
    expect(served.body.version).toBe('1.0.0');
    expect(served.body.owner).toEqual({ userId: OWNER });
    expect((await get('solo', pathOf(agent, SOLO))).body.owner).toEqual({
      userId: OWNER,
      name: OWNER_NAME,
    });
    expect((await get('prod', pathOf(agent, SERVED))).body.owner).toEqual({
      userId: OWNER,
      name: OWNER_NAME,
    });
  });

  test("an agent's other reads stay closed to run: the projects it runs in", async () => {
    const { get } = harness();
    expect((await get('solo-runner', pathOf(agent, SOLO, '/projects'))).status).toBe(403);
  });

  test.each(KINDS.filter((k) => k.kind !== 'agent' && k.kind !== 'flow'))(
    'a $kind stays closed to run: by id, its versions, one of them, and its list',
    async (k) => {
      const { get, head } = harness();
      // A block hides itself from anyone who can't read it: a 404, as before.
      const refused = k.kind === 'block' ? 404 : 403;
      for (const rest of ['', '/versions', '/versions/2.0.0']) {
        expect((await get('solo-runner', pathOf(k, SOLO, rest))).status).toBe(refused);
        expect(await head('solo-runner', pathOf(k, SOLO, rest))).toBe(refused);
      }
      expect(ids(await get('solo-runner', k.path))).toEqual([]);
    },
  );
});

describe.each(KINDS.filter((k) => k.type !== undefined))(
  'a $kind that an order carries, read by a direct grant',
  (k) => {
    test("reads as its first project's readers: staging's versions", async () => {
      const { get } = harness();
      expect((await get('direct', pathOf(k, SERVED))).body.version).toBe('1.1.0');
      const versions = (await get('direct', pathOf(k, SERVED, '/versions'))).body.data as {
        version: string;
      }[];
      expect(versions.map((v) => v.version)).toEqual(['1.0.0', '1.1.0']);
    });

    test('nobody: refused, as today', async () => {
      const { get } = harness();
      expect((await get('nobody', pathOf(k, SERVED))).status).toBe(403);
    });
  },
);

describe('a block that an order carries', () => {
  const block = KINDS.find((k) => k.kind === 'block') as Kind;
  test('a caller who reads none of its projects: 404, as a missing block', async () => {
    const { get } = harness();
    const hidden = await get('nobody', pathOf(block, SERVED));
    const missing = await get('nobody', pathOf(block, 'acme.missing'));
    expect(hidden.status).toBe(404);
    expect(hidden.text.replaceAll(SERVED, 'B')).toBe(missing.text.replaceAll('acme.missing', 'B'));
  });
});

describe('an agent adopted into an order', () => {
  test('a staging-only member sees it, and its version', async () => {
    const { get } = harness();
    const agents = (await get('staging', '/v1/agents')).body.data as { id: string }[];
    expect(agents.map((a) => a.id)).toContain(ADOPTED);
    expect((await get('staging', `/v1/agents/${ADOPTED}`)).body.version).toBe('1.0.0');
  });
});

describe('a key limited to a project, reading an agent an order carries', () => {
  test("a key of one of the agent's projects reads it, though the agent's parent is staging", async () => {
    const { get } = harness();
    const res = await get(`prod-key@${PROD}`, `/v1/agents/${SERVED}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.version).toBe('1.0.0');
  });

  test("a key of a project that doesn't serve it is refused, whatever its owner may read", async () => {
    const { get } = harness();
    const res = await get(`other-key@${OTHER}`, `/v1/agents/${SERVED}`);
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toContain(`limited to project ${OTHER}`);
  });
});

describe('an item with one project', () => {
  test('reads check for check as without the binding: the same answers and the same checks', async () => {
    const paths = KINDS.flatMap((k) => [
      k.path,
      pathOf(k, SOLO),
      pathOf(k, SOLO, `?projectId=${OTHER}`),
      pathOf(k, SOLO, '/versions'),
      pathOf(k, SOLO, '/versions/1.0.0'),
    ]);
    const answers = async (served: boolean) => {
      const h = harness({ served });
      const out: string[] = [];
      for (const who of ['solo', 'nobody']) {
        for (const path of paths) {
          const res = await h.get(who, path);
          // Lists hold the order's item too; only the one-project rows are compared.
          const body =
            Array.isArray(res.body.data) && !path.includes('/versions')
              ? res.body.data.filter((r: { id: string }) => r.id === SOLO)
              : res.body;
          out.push(`${who} ${path} ${res.status} ${JSON.stringify(body)}`);
        }
      }
      const soloChecks = h.asked.filter((a) => !a.includes(SERVED) && !a.includes(ADOPTED));
      return { out, soloChecks };
    };
    const without = await answers(false);
    const withBinding = await answers(true);
    expect(withBinding.out).toEqual(without.out);
    // List pages check the order's item too, so compare the checks of single reads.
    const single = (checks: string[]) => checks.filter((a) => a.includes(SOLO));
    expect(single(withBinding.soloChecks)).toEqual(single(without.soloChecks));
  });
});

describe.each(KINDS)('`?projectId=` on a $kind with no authorizer', (k) => {
  const UNKNOWN = randomUUID();

  test('a row that names no project, with no binding (`kindgi dev`): any project answers the read without one', async () => {
    const { get } = harness({ served: false, authorized: false, projectless: true });
    for (const id of [SOLO, SERVED]) {
      const plain = await get('nobody', pathOf(k, id));
      expect(plain.status, plain.text).toBe(200);
      expect(plain.body.projectId).toBeUndefined();
      for (const p of [OTHER, PROD, UNKNOWN]) {
        expect((await get('nobody', pathOf(k, id, `?projectId=${p}`))).text).toBe(plain.text);
      }
    }
  });

  test('a row with a project, with no binding: its own project answers, any other is a 404', async () => {
    const { get } = harness({ served: false, authorized: false });
    expect((await get('nobody', pathOf(k, SOLO, `?projectId=${OTHER}`))).body.version).toBe(
      '2.0.0',
    );
    expect((await get('nobody', pathOf(k, SOLO, `?projectId=${PROD}`))).status).toBe(404);
    // The order's item is its row's project's alone: no binding says prod serves it.
    expect((await get('nobody', pathOf(k, SERVED, `?projectId=${STAGING}`))).body.version).toBe(
      '1.1.0',
    );
    expect((await get('nobody', pathOf(k, SERVED, `?projectId=${PROD}`))).status).toBe(404);
  });

  test("with the binding and the order [staging, prod]: each project answers the version it runs, for any caller; one outside the item's is a 404", async () => {
    const { get, items } = harness({ authorized: false });
    const prod = await get('nobody', pathOf(k, SERVED, `?projectId=${PROD}`));
    expect(prod.status, prod.text).toBe(200);
    expect(prod.body.version).toBe('1.0.0');
    expect((await get('staging', pathOf(k, SERVED, `?projectId=${PROD}`))).body.version).toBe(
      '1.0.0',
    );
    expect((await get('nobody', pathOf(k, SERVED, `?projectId=${STAGING}`))).body.version).toBe(
      '1.1.0',
    );
    expect((await get('nobody', pathOf(k, SERVED, `?projectId=${OTHER}`))).status).toBe(404);
    expect((await get('nobody', pathOf(k, SERVED, `?projectId=${UNKNOWN}`))).status).toBe(404);
    expect((await get('nobody', pathOf(k, SERVED))).body.version).toBe('1.1.0');
    expect(items).toContain(`projectsOf ${k.kind} ${SERVED}`);
  });
});
