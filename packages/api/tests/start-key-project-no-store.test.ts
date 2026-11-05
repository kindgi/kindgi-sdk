// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A key or session limited to a project, and the work it starts on an
 * item: a run, a conversation, a test-set run, an Improve run or its
 * check, a suggested change or its check. Without an authorization store,
 * a start on an item the key's project doesn't serve is refused,
 * `403 key-project-mismatch`, before anything runs or is written, as a
 * store refuses it (`permission-denied`).
 *
 * What it reaches is what a store asks. A run, a conversation or a
 * test-set run: an item the key's project serves (each of a test-set
 * run's test set and what it runs), and for a run that continues a
 * conversation, in a store's order, the item where the run lands, then the
 * conversation's project. Unnamed, a start on an item the key's project
 * serves lands there, as a store places it. A change that makes new
 * versions of an agent: where they are made. Each refusal names the right
 * a store asks, and a store asks it.
 *
 * A start on an item the key's project serves, on one that isn't there
 * or records no project, and by a key limited to no project, is not
 * refused.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { OPERATIONS, createApp } from '../src/index.js';
import type { CreateAppInput, TokenResolver } from '../src/index.js';
import { LIMITED_START_PROJECT } from '../src/openapi/operations.js';
import { environmentOrders } from './support/environment-orders.js';
import { fullAppInput } from './support/full-app.js';
import { type ItemRow, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const USER = randomUUID() as UserId;
/** The key's project. */
const P1 = randomUUID() as ProjectId;
/** Another project. */
const P2 = randomUUID() as ProjectId;
/** The first environment of P1's order, where a shared agent's new versions are made. */
const P0 = randomUUID() as ProjectId;
const NOW = '2026-10-01T00:00:00.000Z' as Timestamp;
const LIMITED = 'kgi_ak_test_limited_to_p1';
const SESSION = 'kgi_ak_test_session_limited_to_p1';
const UNLIMITED = 'kgi_ak_test_not_limited';

const caller = { tenantId, userId: USER };
const resolveToken: TokenResolver = async (token) => {
  if (token === LIMITED) return { ...caller, tokenProjectId: P1 } as never;
  if (token === SESSION) return { ...caller, tokenProjectId: P1, sessionId: 'ses-acme' } as never;
  return token === UNLIMITED ? (caller as never) : null;
};

/** In another project alone, and in the key's. */
const AWAY = 'acme.away';
const HOME = 'acme.home';
/** Served in P1 and P2, its own P1, the later environment of an order that starts at P0. */
const SHARED = 'acme.shared';
/** Served in P2 and P1, its own P2: an unnamed start lands in the key's project. */
const SPREAD = 'acme.spread';
/** Served in two projects, neither of them the key's. */
const WIDE = 'acme.wide';
/** Its record names no project. */
const UNFILED = 'acme.unfiled';

/** Each id is an agent, a flow and a test set, with these projects. */
const ITEMS: Record<string, readonly ProjectId[]> = {
  [AWAY]: [P2],
  [HOME]: [P1],
  [SHARED]: [P1, P2],
  [SPREAD]: [P2, P1],
  [WIDE]: [P2, P0],
  [UNFILED]: [],
};

function rows(): ItemRow[] {
  return (['agent', 'flow', 'test_set'] as const).flatMap((kind) =>
    Object.entries(ITEMS).map(([id, projects]) => ({
      kind,
      id,
      projects,
      versions: [{ version: '1.0.0', projects }],
    })),
  );
}

/** An item's newest version as its registry records it: its own project. */
const versionOf = (id: string) => ({
  id,
  version: '1.0.0',
  tenantId,
  name: id,
  publishedAt: NOW,
  ...(ITEMS[id]?.[0] !== undefined && { projectId: ITEMS[id][0] }),
});

const id = () => randomUUID();
/** Conversations a run continues, by their agent and project. */
const CONVERSATIONS = {
  away: { id: id(), agentId: HOME, projectId: P2 },
  home: { id: id(), agentId: HOME, projectId: P1 },
  /** From before projects: it records none. */
  unfiled: { id: id(), agentId: HOME },
  /** In the key's project, its agent served in two others. */
  wideHome: { id: id(), agentId: WIDE, projectId: P1 },
  /** In another of the projects that serve its agent, the key's among them. */
  sharedAway: { id: id(), agentId: SHARED, projectId: P2 },
  /** In its agent's one project, another. */
  awayThere: { id: id(), agentId: AWAY, projectId: P2 },
  /** In a third project, its agent's one project another. */
  awayElsewhere: { id: id(), agentId: AWAY, projectId: P0 },
};
/** Suggested changes at the key's project, by their agent. */
const CARDS: Record<string, { readonly id: string; readonly agentId: string }> = {
  [AWAY]: { id: id(), agentId: AWAY },
  [HOME]: { id: id(), agentId: HOME },
  [SHARED]: { id: id(), agentId: SHARED },
};

const byKey = <T, K extends keyof T>(records: Record<string, T>, key: K, value: unknown) =>
  Object.values(records).find((r) => r[key] === value) ?? null;

/** A store that refuses beyond the key's project, as the runtime's does, and grants the rest. */
const granted = (action: Action, r: ResourceRef): Decision => ({
  allowed: true,
  reason: 'granted',
  evidence: { action, relation: '', resource: r.id, actorSubject: '' },
});

type Mode = 'served' | 'recorded' | 'store';

function harness(mode: Mode) {
  const changed: string[] = [];
  /** The project each start was filed in, as the binding got it. */
  const placed: (string | undefined)[] = [];
  /** A write the route makes: recorded, then it fails, so a test sees it got that far. */
  const write =
    (name: string) =>
    async (input?: unknown): Promise<never> => {
      changed.push(name);
      placed.push((input as { projectId?: string } | undefined)?.projectId);
      throw new Error(`${name}: recorded`);
    };
  const { authz, sites, ...base } = fullAppInput();
  const known = (itemId: string) => ITEMS[itemId] !== undefined;
  const input = {
    ...base,
    resolveToken,
    runHandler: {
      invokeAgent: write('runs.invokeAgent'),
      invokeFlow: write('runs.invokeFlow'),
      resumeRun: write('runs.resumeRun'),
    },
    projectBinding: {
      ...base.projectBinding,
      get: async (_t: TenantId, projectId: ProjectId) =>
        [P0, P1, P2].includes(projectId) ? { id: projectId, tenantId, name: 'acme' } : undefined,
    },
    agentRegistry: {
      ...base.agentRegistry,
      get: async ({ agentId }: { agentId: string }) => (known(agentId) ? versionOf(agentId) : null),
      headExists: async ({ agentId }: { agentId: string }) => known(agentId),
      listVersions: async ({ agentId }: { agentId: string }) => ({
        data: known(agentId) ? [versionOf(agentId)] : [],
      }),
      getVersion: async ({ agentId }: { agentId: string }) =>
        known(agentId) ? versionOf(agentId) : null,
    },
    flowRegistry: {
      ...base.flowRegistry,
      get: async ({ flowId }: { flowId: string }) => (known(flowId) ? versionOf(flowId) : null),
      listVersions: async ({ flowId }: { flowId: string }) => ({
        data: known(flowId) ? [versionOf(flowId)] : [],
      }),
    },
    testSetRegistry: {
      ...base.testSetRegistry,
      listVersions: async ({ testSetId }: { testSetId: string }) => ({
        data: known(testSetId) ? [versionOf(testSetId)] : [],
      }),
    },
    environmentOrders: environmentOrders([[P0, P1]]),
    conversationBinding: {
      ...base.conversationBinding,
      getConversation: async (_t: TenantId, conversationId: string) => {
        const v = byKey(CONVERSATIONS, 'id', conversationId);
        return v === null
          ? { kind: 'err', error: { code: 'conversation-not-found', message: 'none' } }
          : {
              kind: 'ok',
              value: {
                ...v,
                tenantId,
                agentVersion: '1.0.0',
                title: 'acme',
                scope: { tenantId },
                openedAt: NOW,
                openedBy: `user:${USER}`,
                turnCount: 1,
              },
            };
      },
      openConversation: write('conversations.openConversation'),
    },
    testRunBinding: { ...base.testRunBinding, start: write('testRuns.start') },
    supervisor: {
      ...base.supervisor,
      getSuggestedChange: async ({ suggestedChangeId }: { suggestedChangeId: string }) => {
        const k = byKey(CARDS, 'id', suggestedChangeId);
        return k === null
          ? null
          : {
              ...k,
              tenantId,
              scope: { kind: 'project', projectId: P1 },
              fromVersion: '1.0.0',
              revision: 1,
              steps: [],
              createdAt: NOW,
            };
      },
      createSuggestedChange: write('cards.create'),
      recordSuggestedChange: write('cards.record'),
    },
    improveRuns: {
      get: async () => null,
      list: async () => ({ data: [] }),
      start: write('improve.start'),
      check: write('improve.check'),
      cancel: write('improve.cancel'),
    },
    ...(mode === 'served' && { itemProjects: itemProjects(rows()) }),
    ...(mode === 'store' && {
      sites,
      itemProjects: itemProjects(rows()),
      authz: {
        ...authz,
        authzCheckBinding: {
          inProject: async (_p, r, projectId) =>
            ITEMS[r.id]?.includes(projectId as ProjectId) ?? false,
          check: async (_p, action, r) => granted(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => granted(action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  };
  const app = createApp(input as unknown as CreateAppInput);
  const send = async (token: string, method: string, path: string, body?: unknown) => {
    changed.length = 0;
    placed.length = 0;
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Body = {};
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as Body) : {};
    } catch {
      // Not JSON: no error code to read.
    }
    return { status: res.status, body: parsed, changed: [...changed], placed: [...placed] };
  };
  return { send };
}

type Harness = ReturnType<typeof harness>;
type Sent = Awaited<ReturnType<Harness['send']>>;

type Body = {
  error?: { code: string; message?: string; details?: Record<string, unknown> };
};

type Row = {
  readonly label: string;
  /** The operation, as `METHOD /openapi/path`. */
  readonly op: string;
  /** What the refusal names. */
  readonly word: string;
  /** The right a store asks, refused, on an item one other project serves. */
  readonly action: Action;
  /** On one two other projects serve, when that isn't `action` and the runtime knows both. */
  readonly wide?: Action;
  /** The start, on the item with this id. */
  readonly to: (item: string) => { path: string; body: unknown };
};

const SUGGESTED = { block: 'acme.scorer-prompt', template: 'Score it.', why: 'acme' };

/** One row per start a store holds on its item and, until now, nothing held without one. */
const STARTS: readonly Row[] = [
  {
    label: 'run of an agent',
    op: 'POST /v1/runs',
    word: 'the agent',
    action: 'execute',
    wide: 'call',
    to: (item) => ({ path: '/v1/runs', body: { agent: item, input: {} } }),
  },
  {
    label: 'run of an agent, in the project named',
    op: 'POST /v1/runs',
    word: 'the agent',
    action: 'execute',
    to: (item) => ({ path: '/v1/runs', body: { agent: item, projectId: P1, input: {} } }),
  },
  {
    label: 'run of a flow',
    op: 'POST /v1/runs',
    word: 'the flow',
    action: 'execute',
    to: (item) => ({ path: '/v1/runs', body: { flow: item, input: {} } }),
  },
  {
    label: 'conversation',
    op: 'POST /v1/conversations',
    word: 'the agent',
    action: 'execute',
    wide: 'call',
    to: (item) => ({ path: '/v1/conversations', body: { agentId: item, agentVersion: '1.0.0' } }),
  },
  {
    label: 'conversation, in the project named',
    op: 'POST /v1/conversations',
    word: 'the agent',
    action: 'execute',
    to: (item) => ({
      path: '/v1/conversations',
      body: { agentId: item, agentVersion: '1.0.0', projectId: P1 },
    }),
  },
  {
    label: 'test-set run, for its test set',
    op: 'POST /v1/test-sets/{testSetId}/runs',
    word: 'the test set',
    action: 'execute',
    to: (item) => ({
      path: `/v1/test-sets/${item}/runs`,
      body: { projectId: P1, agentRef: { agentId: HOME } },
    }),
  },
  {
    label: 'test-set run, for the agent it runs',
    op: 'POST /v1/test-sets/{testSetId}/runs',
    word: 'the agent',
    action: 'execute',
    to: (item) => ({
      path: `/v1/test-sets/${HOME}/runs`,
      body: { projectId: P1, agentRef: { agentId: item } },
    }),
  },
  {
    label: 'test-set run, for the flow it runs',
    op: 'POST /v1/test-sets/{testSetId}/runs',
    word: 'the flow',
    action: 'execute',
    to: (item) => ({
      path: `/v1/test-sets/${HOME}/runs`,
      body: { projectId: P1, flowRef: { flowId: item } },
    }),
  },
  {
    label: 'Improve run',
    op: 'POST /v1/improve-runs',
    word: 'the agent',
    action: 'publish',
    to: (item) => ({ path: '/v1/improve-runs', body: { agentId: item, projectId: P1 } }),
  },
  {
    label: 'Improve check',
    op: 'POST /v1/improve-runs/check',
    word: 'the agent',
    action: 'publish',
    to: (item) => ({ path: '/v1/improve-runs/check', body: { agentId: item, projectId: P1 } }),
  },
  {
    label: 'suggested change',
    op: 'POST /v1/suggested-changes',
    word: 'the agent',
    action: 'publish',
    to: (item) => ({
      path: '/v1/suggested-changes',
      body: { agentId: item, projectId: P1, ...SUGGESTED },
    }),
  },
  {
    label: 'suggested change check',
    op: 'POST /v1/suggested-changes/{suggestedChangeId}/check',
    word: 'the agent',
    action: 'publish',
    to: (item) => ({ path: `/v1/suggested-changes/${CARDS[item]?.id ?? id()}/check`, body: {} }),
  },
];

/** The starts that run the item (not those that make its new versions). */
const RUNS = STARTS.filter((r) => !/^(Improve|suggested)/.test(r.label));

/**
 * Runs continuing a conversation whose item is refused too, as a store
 * refuses them, in its order: the item where the run lands, then the
 * conversation. An agent more than one project serves, continuing a
 * conversation in one of them, lands there.
 */
const CONTINUED = [
  {
    where: "in the key's project, of an agent two other projects serve",
    target: { agent: WIDE },
    conversation: CONVERSATIONS.wideHome,
    word: 'the agent',
    projectId: P2,
    action: 'execute',
  },
  {
    where: "in another of the projects that serve its agent, the key's among them",
    target: { agent: SHARED },
    conversation: CONVERSATIONS.sharedAway,
    word: 'the conversation',
    projectId: P2,
    action: 'call',
    /** Its record names the key's project alone: the agent passes, then the conversation. */
    unbound: { word: 'the conversation', action: 'write' },
  },
  {
    where: "in another project, its agent's one",
    target: { agent: AWAY },
    conversation: CONVERSATIONS.awayThere,
    word: 'the agent',
    projectId: P2,
    action: 'execute',
  },
  {
    where: 'in a third project, of an agent in another one',
    target: { agent: AWAY },
    conversation: CONVERSATIONS.awayElsewhere,
    word: 'the agent',
    projectId: P2,
    action: 'execute',
  },
  {
    where: "in another project, by a flow that project's alone",
    target: { flow: AWAY },
    conversation: CONVERSATIONS.awayThere,
    word: 'the flow',
    projectId: P2,
    action: 'execute',
  },
] as const satisfies readonly {
  readonly where: string;
  readonly target: { readonly agent: string } | { readonly flow: string };
  readonly conversation: { readonly id: string };
  readonly word: string;
  readonly projectId: ProjectId;
  readonly action: Action;
  readonly unbound?: { readonly word: string; readonly action: Action };
}[];

const send = (h: Harness, token: string, r: Row, item: string) => {
  const { path, body } = r.to(item);
  return h.send(token, 'POST', path, body);
};

const refusedWith = (res: Sent, message: string, projectId: string, action: Action) => {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body.error).toMatchObject({
    code: 'key-project-mismatch',
    message,
    details: { keyProjectId: P1, projectId, action },
  });
  expect(res.changed).toEqual([]);
};

const notRefused = (res: Sent) =>
  expect(res.body.error?.code, JSON.stringify(res.body)).not.toBe('key-project-mismatch');

const keyWords = (rest: string) => `This API key is limited to project ${P1}; ${rest}`;

const served = harness('served');
const recorded = harness('recorded');
const withStore = harness('store');

test('every operation whose 403 names this refusal has a row, and no other', () => {
  const documented = OPERATIONS.filter((o) =>
    JSON.stringify(o.responses['403'] ?? '').includes(LIMITED_START_PROJECT),
  ).map((o) => `${o.method.toUpperCase()} ${o.openapiPath}`);
  expect([...new Set(STARTS.map((r) => r.op))].sort()).toEqual(documented.sort());
});

describe.each([
  ['the host says which projects serve each item', served, true],
  ['each item records its own project', recorded, false],
] as const)("a start on another project's item, with no store, where %s", (_where, h, several) => {
  test.each(STARTS)('$label: 403 key-project-mismatch, nothing started', async (r) => {
    const res = await send(h, LIMITED, r, AWAY);
    refusedWith(res, keyWords(`${r.word} is in project ${P2}`), P2, r.action);
  });

  test.each(STARTS)("$label, on the key project's own item: not refused", async (r) => {
    notRefused(await send(h, LIMITED, r, HOME));
  });

  test.each(STARTS)('$label, by a key limited to no project: not refused', async (r) => {
    notRefused(await send(h, UNLIMITED, r, AWAY));
  });

  test.each(STARTS)('$label, by a session limited to a project: the same refusal', async (r) => {
    const res = await send(h, SESSION, r, AWAY);
    refusedWith(
      res,
      `This session is limited to project ${P1}; ${r.word} is in project ${P2}`,
      P2,
      r.action,
    );
  });

  // `call` for an unnamed start of an agent more than one project serves,
  // which lands in the first of them, as a store's `runIn` asks it;
  // `execute` on the item for the rest, as a store asks it outside the
  // item's projects. Either way, the first of its projects.
  test.each(RUNS)(
    '$label, on an item two other projects serve: refused for the first',
    async (r) => {
      const res = await send(h, LIMITED, r, WIDE);
      // Its record names its own project alone: one project serves it, as far as the runtime knows.
      const action = several ? (r.wide ?? r.action) : r.action;
      refusedWith(res, keyWords(`${r.word} is in project ${P2}`), P2, action);
    },
  );

  test.each(STARTS)('$label, on an item that is not there: not refused', async (r) => {
    notRefused(await send(h, LIMITED, r, 'acme.none'));
  });

  test.each(STARTS)('$label, on an item that records no project: not refused', async (r) => {
    notRefused(await send(h, LIMITED, r, UNFILED));
  });

  test("a run continuing a conversation in another project is refused for the conversation, before it's placed", async () => {
    const res = await h.send(LIMITED, 'POST', '/v1/runs', {
      agent: HOME,
      input: { conversationId: CONVERSATIONS.away.id },
    });
    refusedWith(res, keyWords(`the conversation is in project ${P2}`), P2, 'write');
  });

  test.each(CONTINUED)(
    'a run continuing a conversation $where: refused as a store refuses it, the target first',
    async (k) => {
      const res = await h.send(LIMITED, 'POST', '/v1/runs', {
        ...k.target,
        input: { conversationId: k.conversation.id },
      });
      const want = !several && 'unbound' in k ? { ...k, ...k.unbound } : k;
      refusedWith(
        res,
        keyWords(`${want.word} is in project ${k.projectId}`),
        k.projectId,
        want.action,
      );
    },
  );

  test.each([
    ["in the key's project", CONVERSATIONS.home.id],
    ['that records no project', CONVERSATIONS.unfiled.id],
  ])('a run continuing a conversation %s: not refused', async (_where, conversationId) => {
    const res = await h.send(LIMITED, 'POST', '/v1/runs', {
      agent: HOME,
      input: { conversationId },
    });
    notRefused(res);
    expect(res.changed).toEqual(['runs.invokeAgent']);
  });
});

describe('an item more than one project serves, with no store: placed as a store places it', () => {
  test.each([
    ['run', '/v1/runs', { agent: SPREAD, input: {} }, 'runs.invokeAgent'],
    ['run of a flow', '/v1/runs', { flow: SPREAD, input: {} }, 'runs.invokeFlow'],
    [
      'conversation',
      '/v1/conversations',
      { agentId: SPREAD, agentVersion: '1.0.0' },
      'conversations.openConversation',
    ],
  ])(
    "an unnamed %s, of an item the key's project serves and another has as its own, lands in the key's project",
    async (_label, path, body, made) => {
      const res = await served.send(LIMITED, 'POST', path, body);
      notRefused(res);
      expect(res.changed).toEqual([made]);
      expect(res.placed).toEqual([P1]);
    },
  );

  test.each(['run', 'conversation'])(
    'an unnamed %s by a key limited to no project is placed as before',
    async (what) => {
      const res = await served.send(
        UNLIMITED,
        'POST',
        what === 'run' ? '/v1/runs' : '/v1/conversations',
        what === 'run' ? { agent: SPREAD, input: {} } : { agentId: SPREAD, agentVersion: '1.0.0' },
      );
      notRefused(res);
      expect(res.placed).not.toContain(P1);
    },
  );

  test.each(RUNS)("$label, on an item the key's project serves too: not refused", async (r) => {
    notRefused(await send(served, LIMITED, r, SHARED));
  });

  test.each(STARTS.filter((r) => !RUNS.includes(r)))(
    '$label, of an agent made in another project: refused where its new versions are made',
    async (r) => {
      const res = await send(served, LIMITED, r, SHARED);
      refusedWith(
        res,
        keyWords(`new versions of the agent are made in project ${P0}`),
        P0,
        'write',
      );
    },
  );
});

// Where the host says which projects serve each item, as a store's runtime knows it.
describe('the right a refusal names, with no store, is the one a store asks', () => {
  const starts: readonly (readonly [string, (h: Harness) => Promise<Sent>])[] = [
    ...RUNS.flatMap((r) =>
      [AWAY, WIDE].map(
        (item) => [`${r.label}, on ${item}`, (h: Harness) => send(h, LIMITED, r, item)] as const,
      ),
    ),
    ...CONTINUED.map(
      (k) =>
        [
          `a run continuing a conversation ${k.where}`,
          (h: Harness) =>
            h.send(LIMITED, 'POST', '/v1/runs', {
              ...k.target,
              input: { conversationId: k.conversation.id },
            }),
        ] as const,
    ),
  ];

  test.each(starts)('%s', async (_label, start) => {
    const store = await start(withStore);
    expect(store.status, JSON.stringify(store.body)).toBe(403);
    expect(store.body.error?.code).toBe('permission-denied');
    const held = await start(served);
    expect(held.body.error?.code, JSON.stringify(held.body)).toBe('key-project-mismatch');
    expect(held.body.error?.details?.action).toBe(store.body.error?.details?.action);
  });
});

describe("a start on another project's item, by a key limited to a project, with a store", () => {
  test.each(STARTS)('$label: refused by the store, as before', async (r) => {
    const res = await send(withStore, LIMITED, r, AWAY);
    expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
    expect(res.changed).toEqual([]);
  });
});
