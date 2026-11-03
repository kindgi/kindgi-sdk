// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Running an item more than one project serves (an environment order
 * carries it from staging to prod), and what its runs leave behind. A run
 * in one of its projects needs that project's right alone: `call` for an
 * agent (its callers and editors), `execute` for a flow or a test set (its
 * executors and editors), and neither the item's own `execute` nor
 * `write` on the project it names. Unnamed, the run lands where the
 * runtime puts it (the conversation's project, else a project-scoped
 * key's own, else the item's first) and is checked there. A project
 * outside the item's, and an item with one project, are checked as
 * before.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  CreateAppInput,
  FlowRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;
const OTHER = randomUUID() as ProjectId;

/** The agent and the flow an order carries (`acme.desk`), and ones in a single project (`acme.solo`). */
const SERVED = 'acme.desk';
const SOLO = 'acme.solo';

/** A conversation with `acme.desk` in prod, one in staging, and one in a project that doesn't serve it. */
const IN_PROD = randomUUID();
const IN_STAGING = randomUUID();
const IN_OTHER = randomUUID();

function rows(): ItemRow[] {
  return (['agent', 'flow', 'test_set'] as const).flatMap((kind): ItemRow[] => [
    {
      kind,
      id: SERVED,
      projects: [STAGING, PROD],
      versions: [{ version: '1.0.0', projects: [STAGING, PROD] }],
    },
    { kind, id: SOLO, projects: [OTHER], versions: [{ version: '1.0.0', projects: [OTHER] }] },
  ]);
}

const on = (project: ProjectId, ...actions: string[]) =>
  actions.map((a) => `${a} project:${project}` as Grant);

const PEOPLE: Record<string, readonly Grant[]> = {
  /** Calls agents and executes flows in prod; not an editor there. */
  prod: on(PROD, 'read', 'call', 'execute'),
  /** Calls agents and executes flows in staging. */
  staging: on(STAGING, 'read', 'call', 'execute'),
  /** Calls agents in prod, and doesn't read it: an app's backend. */
  'prod-caller': on(PROD, 'call'),
  /** Calls in both. */
  both: [...on(STAGING, 'read', 'call', 'execute'), ...on(PROD, 'read', 'call', 'execute')],
  /** Today's rights on `acme.desk` and no project's: no longer enough in its projects. */
  item: [`execute agent:${SERVED}`, `execute flow:${SERVED}`, ...on(PROD, 'write')],
  /** Runs `acme.desk` in a project outside its order, as before: `execute` on it, `write` there. */
  outside: [`execute agent:${SERVED}`, ...on(OTHER, 'read', 'write')],
  /** Runs the one-project items, and may not write their project. */
  'solo-caller': [`execute agent:${SOLO}`, `execute flow:${SOLO}`, ...on(OTHER, 'read')],
  /** Runs the one-project items, as today. */
  solo: [
    `execute agent:${SOLO}`,
    `execute flow:${SOLO}`,
    ...['read', 'write', 'admin', 'execute'].map((a) => `${a} test_set:${SOLO}` as Grant),
    ...on(OTHER, 'read', 'write'),
  ],
  /** Reads and runs evals in prod: execute and call there, write to file its results. */
  'prod-evals': on(PROD, 'read', 'call', 'execute', 'write'),
  /** Runs prod: registers its triggers there, and calls and executes there. */
  'prod-ops': on(PROD, 'read', 'write', 'call', 'execute'),
  /** Writes both projects (an improve schedule in prod makes versions in staging). */
  'writes-both': [...on(STAGING, 'read', 'write'), ...on(PROD, 'read', 'write')],
  /** Edits the flow (today's right to register its event triggers) and executes in staging. */
  'event-maker': [`write flow:${SERVED}`, ...on(STAGING, 'read', 'execute')],
  /** Edits the flow, and executes in prod only. */
  'event-prod': [`write flow:${SERVED}`, ...on(PROD, 'read', 'execute')],
  /** Reads both agents directly, as today. */
  'agent-reader': [`read agent:${SERVED}`, `read agent:${SOLO}`],
  /** Today's rights on the test set: no longer enough for its runs in its projects. */
  'test-set-admin': ['read', 'write', 'admin', 'execute'].map(
    (a) => `${a} test_set:${SERVED}` as Grant,
  ),
  /** Every right on both items and every project: a start's checks show where it landed. */
  all: [
    ...(['agent', 'flow'] as const).flatMap(
      (kind) => [`execute ${kind}:${SERVED}`, `execute ${kind}:${SOLO}`] as Grant[],
    ),
    ...[STAGING, PROD, OTHER].flatMap((p) => on(p, 'read', 'write', 'call', 'execute')),
  ],
};

/** Test runs: of `acme.desk`'s test set in prod and in staging, and of the one-project test set. */
const EVAL_IN_PROD = randomUUID();
const EVAL_IN_STAGING = randomUUID();
const EVAL_SOLO = randomUUID();
const testRun = (testRunId: string, testSetId: string, projectId: ProjectId) => ({
  testRunId,
  tenantId,
  projectId,
  testSetId,
  testSetVersion: '1.0.0',
  kind: 'agent',
  agentRef: { agentId: testSetId },
  status: 'running',
  dryRun: false,
  startedAt: '2026-10-01T00:00:00.000Z',
});
const TEST_RUNS = [
  testRun(EVAL_IN_PROD, SERVED, PROD),
  testRun(EVAL_IN_STAGING, SERVED, STAGING),
  testRun(EVAL_SOLO, SOLO, OTHER),
];

const resolveToken: TokenResolver = async (token) => {
  const [who, keyProject] = token.split('@');
  if (who === undefined || !(who in PEOPLE)) return null;
  return {
    tenantId,
    userId: who as UserId,
    ...(keyProject !== undefined && { tokenProjectId: keyProject }),
  };
};

/** Each item's own project: the one its head row is filed under. */
const homeOf = (id: string) => (id === SERVED ? STAGING : id === SOLO ? OTHER : undefined);
const record = (id: string) =>
  homeOf(id) === undefined ? null : { id, version: '1.0.0', projectId: homeOf(id), tenantId };

/** `projects`: the ones that exist; unset, the app has no project binding and checks none. */
function harness(opts: { served?: boolean; projects?: readonly ProjectId[] } = {}) {
  /** Each run started: what, and the project it was filed under. */
  const invoked: string[] = [];
  /** Each conversation opened or closed. */
  const conversations: string[] = [];
  const runHandler = {
    invokeAgent: async (input: { agentId: string; projectId?: string }) => {
      invoked.push(`agent ${input.agentId} in ${input.projectId ?? '-'}`);
      return { kind: 'err', error: { code: 'agent-not-found', message: 'test: stop here' } };
    },
    invokeFlow: async (input: { flowId: string; projectId?: string }) => {
      invoked.push(`flow ${input.flowId} in ${input.projectId ?? '-'}`);
      return { kind: 'err', error: { code: 'flow-not-found', message: 'test: stop here' } };
    },
    resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'x' } }),
  } as unknown as RunHandlerBinding;
  const stubs = createStubAppBindings();
  const conversation = (conversationId: string, projectId: ProjectId, openedBy?: string) => ({
    conversationId,
    tenantId,
    agentId: SERVED,
    agentVersion: '1.0.0',
    projectId,
    scope: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    ...(openedBy !== undefined && { openedBy }),
  });
  const conversationBinding = {
    ...stubs.conversationBinding,
    getConversation: async (_t: TenantId, id: string) =>
      id === IN_PROD
        ? { kind: 'ok', value: conversation(IN_PROD, PROD, 'user:prod') }
        : id === IN_STAGING
          ? { kind: 'ok', value: conversation(IN_STAGING, STAGING) }
          : id === IN_OTHER
            ? { kind: 'ok', value: conversation(IN_OTHER, OTHER) }
            : { kind: 'err', error: { code: 'conversation-not-found', message: 'test: none' } },
    openConversation: async (input: { agentId: string; projectId?: string }) => {
      conversations.push(`open ${input.agentId} in ${input.projectId ?? '-'}`);
      return { kind: 'err', error: { code: 'agent-not-found', message: 'test: stop here' } };
    },
    closeConversation: async (_t: TenantId, id: string) => {
      conversations.push(`close ${id}`);
      return { kind: 'err', error: { code: 'conversation-not-found', message: 'test: stop here' } };
    },
  } as unknown as CreateAppInput['conversationBinding'];
  const registry = {
    get: async (input: Record<string, string>) => record(input.agentId ?? input.flowId ?? ''),
    getVersion: async (input: Record<string, string>) =>
      record(input.agentId ?? input.flowId ?? ''),
  };
  /** Each test run started, cancelled or rescored. */
  const evals: string[] = [];
  const testRunBinding = {
    async start(input: { testSetId: string; projectId: string }) {
      evals.push(`start ${input.testSetId} in ${input.projectId}`);
      return { kind: 'test-set-not-found', testSetId: input.testSetId };
    },
    async get({ testRunId }: { testRunId: string }) {
      return TEST_RUNS.find((r) => r.testRunId === testRunId) ?? null;
    },
    async list({ filter }: { filter?: { testSetId?: string } }) {
      return {
        data: TEST_RUNS.filter(
          (r) => filter?.testSetId === undefined || r.testSetId === filter.testSetId,
        ),
      };
    },
    async cancel({ testRunId }: { testRunId: string }) {
      evals.push(`cancel ${testRunId}`);
      return { kind: 'ok' };
    },
    async rescore({ testRunId }: { testRunId: string }) {
      evals.push(`rescore ${testRunId}`);
      return { kind: 'not-found' };
    },
  } as unknown as CreateAppInput['testRunBinding'];
  const triggers = createInMemoryTriggerRegistry({ defaultProjectId: STAGING });
  const observation = (id: string, agentId: string) => ({
    id,
    tenantId,
    supervisorId: 'acme.watch',
    agentId,
    agentVersion: '1.0.0',
    conversationId: randomUUID(),
    turnNumber: 1,
    status: 'passed',
    violations: [],
    durationMs: 1,
    costUsd: '0',
    observedAt: '2026-10-01T00:00:00.000Z',
  });
  const supervisor = {
    async queryObservations() {
      return {
        kind: 'ok',
        page: { data: [observation(randomUUID(), SERVED), observation(randomUUID(), SOLO)] },
      };
    },
  } as unknown as CreateAppInput['supervisor'];
  const items = itemProjects(rows());
  const authz = grantsAuthz(PEOPLE, {
    [`agent:${SOLO}`]: OTHER,
    [`flow:${SOLO}`]: OTHER,
    [`agent:${SERVED}`]: STAGING,
    [`flow:${SERVED}`]: STAGING,
  });
  const app = createApp({
    ...stubs,
    conversationBinding,
    resolveToken,
    runHandler,
    testRunBinding,
    triggerRegistry: triggers,
    secretsBinding: { get: async () => null } as unknown as CreateAppInput['secretsBinding'],
    supervisor,
    enableObservations: true,
    agentRegistry: registry as unknown as AgentRegistryBinding,
    flowRegistry: registry as unknown as FlowRegistryBinding,
    authz: authz.authz,
    ...(opts.served !== false && { itemProjects: items }),
    ...(opts.projects !== undefined && {
      projectBinding: {
        get: async (_t: TenantId, id: ProjectId) =>
          opts.projects?.includes(id) ? { id } : undefined,
        getDefault: async () => undefined,
      } as unknown as CreateAppInput['projectBinding'],
    }),
    environmentOrders: environmentOrders([[STAGING, PROD]]),
  } as CreateAppInput);
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const before = authz.asked.length;
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        'x-request-id': 'req-order-runs',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: JSON.parse(text) as Record<string, any>,
      asked: authz.asked.slice(before),
    };
  };
  return { call, invoked, conversations, evals, triggers, items };
}

const run = (target: 'agent' | 'flow', id: string, more: Record<string, unknown> = {}) => ({
  [target]: id,
  input: {},
  ...more,
});

describe('running an agent an order carries', () => {
  test("a prod caller who isn't an editor runs it in prod: call there, nothing else", async () => {
    const { call, invoked } = harness();
    const res = await call('prod', 'POST', '/v1/runs', run('agent', SERVED, { projectId: PROD }));
    expect(res.status, res.text).not.toBe(403);
    expect(invoked).toEqual([`agent ${SERVED} in ${PROD}`]);
    expect(res.asked).toEqual([`prod call project:${PROD}`]);
  });

  test("today's right on the agent doesn't run it in its projects; the refusal names the right there", async () => {
    const { call, invoked } = harness();
    const res = await call('item', 'POST', '/v1/runs', run('agent', SERVED, { projectId: PROD }));
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toBe(
      `Permission denied: running agent "${SERVED}" in project ${PROD} needs caller or editor on ${PROD} (test: not granted)`,
    );
    expect(invoked).toEqual([]);
  });

  test("named outside the agent's projects: today's checks, execute on it and write there", async () => {
    const { call, invoked } = harness();
    const res = await call(
      'outside',
      'POST',
      '/v1/runs',
      run('agent', SERVED, { projectId: OTHER }),
    );
    expect(res.status, res.text).not.toBe(403);
    expect(res.asked).toEqual([
      `outside execute agent:${SERVED}`,
      `outside write project:${OTHER}`,
    ]);
    expect(invoked).toEqual([`agent ${SERVED} in ${OTHER}`]);
    const prod = await call('prod', 'POST', '/v1/runs', run('agent', SERVED, { projectId: OTHER }));
    expect(prod.status, prod.text).toBe(403);
  });

  test("unnamed, it lands in the agent's first project and is checked there", async () => {
    const { call, invoked } = harness();
    const prod = await call('prod', 'POST', '/v1/runs', run('agent', SERVED));
    expect(prod.status, prod.text).toBe(403);
    expect(prod.body.error.message).toContain(`in project ${STAGING} needs caller or editor`);
    const staging = await call('staging', 'POST', '/v1/runs', run('agent', SERVED));
    expect(staging.status, staging.text).not.toBe(403);
    expect(invoked).toEqual([`agent ${SERVED} in -`]);
  });

  test("a prod key's unnamed run lands in prod, and is filed there", async () => {
    const { call, invoked } = harness();
    const res = await call(`prod@${PROD}`, 'POST', '/v1/runs', run('agent', SERVED));
    expect(res.status, res.text).not.toBe(403);
    expect(res.asked).toEqual([`prod call project:${PROD}`]);
    expect(invoked).toEqual([`agent ${SERVED} in ${PROD}`]);
  });

  test('continuing a conversation runs where the conversation is', async () => {
    const { call, invoked } = harness();
    const turn = (conversationId: string) => run('agent', SERVED, { input: { conversationId } });
    // A staging caller can't continue prod's conversation.
    const staging = await call('staging', 'POST', '/v1/runs', turn(IN_PROD));
    expect(staging.status, staging.text).toBe(403);
    expect(staging.body.error.message).toContain(`in project ${PROD} needs caller or editor`);
    // Prod opened it: their turn takes call there, not write (`turn-access.ts`).
    const prod = await call('prod', 'POST', '/v1/runs', turn(IN_PROD));
    expect(prod.status, prod.text).not.toBe(403);
    expect(invoked).toEqual([`agent ${SERVED} in -`]);
  });

  test("a prod key can't continue staging's conversation, though its user calls in staging", async () => {
    const { call, invoked } = harness();
    const res = await call(
      `both@${PROD}`,
      'POST',
      '/v1/runs',
      run('agent', SERVED, { input: { conversationId: IN_STAGING } }),
    );
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.details.reason).toBe(`the API key is limited to project ${PROD}`);
    expect(invoked).toEqual([]);
  });
});

describe('running a flow an order carries', () => {
  test('a prod executor runs it in prod: execute there, nothing else', async () => {
    const { call, invoked } = harness();
    const res = await call('prod', 'POST', '/v1/runs', run('flow', SERVED, { projectId: PROD }));
    expect(res.status, res.text).not.toBe(403);
    expect(res.asked).toEqual([`prod execute project:${PROD}`]);
    expect(invoked).toEqual([`flow ${SERVED} in ${PROD}`]);
  });

  test('the refusal names the executor right', async () => {
    const { call } = harness();
    const res = await call('staging', 'POST', '/v1/runs', run('flow', SERVED, { projectId: PROD }));
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toContain(`needs executor or editor on ${PROD}`);
  });
});

describe('running an item with one project: as before', () => {
  test.each(['agent', 'flow'] as const)(
    'a %s named in its own project still needs write there',
    async (target) => {
      const withBinding = harness();
      const without = harness({ served: false });
      const body = run(target, SOLO, { projectId: OTHER });
      const a = await withBinding.call('solo-caller', 'POST', '/v1/runs', body);
      const b = await without.call('solo-caller', 'POST', '/v1/runs', body);
      expect(a.status, a.text).toBe(403);
      expect(a.body.error.message).toContain(`naming project ${OTHER} needs write on it`);
      expect(a.text).toBe(b.text);
      expect(a.asked).toEqual(b.asked);
    },
  );

  test.each(['agent', 'flow'] as const)(
    "a key's unnamed %s run isn't placed in the key's project",
    async (target) => {
      const withBinding = harness();
      const without = harness({ served: false });
      const a = await withBinding.call(`solo@${OTHER}`, 'POST', '/v1/runs', run(target, SOLO));
      const b = await without.call(`solo@${OTHER}`, 'POST', '/v1/runs', run(target, SOLO));
      expect(a.text).toBe(b.text);
      expect(a.asked).toEqual(b.asked);
      expect(withBinding.invoked).toEqual([`${target} ${SOLO} in -`]);
      expect(withBinding.invoked).toEqual(without.invoked);
    },
  );
});

describe('where a start lands, and what it asks there', () => {
  const NAMES: Record<string, string> = {
    [STAGING]: 'STAGING',
    [PROD]: 'PROD',
    [OTHER]: 'OTHER',
    [IN_PROD]: 'IN_PROD',
    [IN_STAGING]: 'IN_STAGING',
    [IN_OTHER]: 'IN_OTHER',
  };
  const named = (text: string) =>
    Object.entries(NAMES).reduce((out, [id, name]) => out.replaceAll(id, name), text);

  // Every way a start lands (named, a conversation's, a key's project, or
  // none) for an item two projects serve and one with one.
  const starts = () =>
    (['agent', 'flow'] as const).flatMap((target) =>
      [SERVED, SOLO].flatMap((id) =>
        [undefined, STAGING, PROD, OTHER].flatMap((projectId) =>
          (target === 'agent' && projectId === undefined
            ? [undefined, IN_PROD, IN_STAGING, IN_OTHER]
            : [undefined]
          ).flatMap((conversationId) =>
            [undefined, STAGING, PROD, OTHER].map((key) => ({
              target,
              id,
              projectId,
              conversationId,
              key,
            })),
          ),
        ),
      ),
    );

  // The answers are #1036's, which asked the item's whole set of projects:
  // asking only the project a start lands in gives the same checks, the
  // same refusals and the same filing.
  test('every case answers as with the whole set', async () => {
    const { call, invoked, items } = harness();
    const out: string[] = [];
    for (const { target, id, projectId, conversationId, key } of starts()) {
      const ran = invoked.length;
      const res = await call(
        key === undefined ? 'all' : `all@${key}`,
        'POST',
        '/v1/runs',
        run(target, id, {
          ...(projectId !== undefined && { projectId }),
          ...(conversationId !== undefined && { input: { conversationId } }),
        }),
      );
      const filed = invoked.slice(ran).join(', ') || 'nothing ran';
      const refused = res.status === 403 ? ` (${res.body.error.message})` : '';
      out.push(
        named(
          `${target} ${id} named ${projectId ?? '-'} conversation ${conversationId ?? '-'} key ${key ?? '-'}: ${res.status}${refused} asked [${res.asked.join(', ')}], ${filed}`,
        ),
      );
    }
    expect(out).toEqual(WHOLE_SET_ANSWERS);
    expect(items.asked.filter((asked) => !/^(servesIn|servedElsewhere) /.test(asked))).toEqual([]);
  });

  // What a start asks of which projects serve the item: whether the project
  // it lands in does, and whether another does when that's the item's
  // first. Never every project it's in. (A key outside the project it
  // lands in is refused there, as the whole set's answers show.)
  test.each([
    [
      'named, not its first',
      'agent',
      SERVED,
      { projectId: PROD },
      undefined,
      ['servesIn agent acme.desk PROD'],
    ],
    [
      'named, its first',
      'agent',
      SERVED,
      { projectId: STAGING },
      undefined,
      ['servesIn agent acme.desk STAGING', 'servedElsewhere agent acme.desk'],
    ],
    [
      'named, one project serving it',
      'agent',
      SOLO,
      { projectId: OTHER },
      undefined,
      ['servesIn agent acme.solo OTHER', 'servedElsewhere agent acme.solo'],
    ],
    [
      'named outside its projects',
      'agent',
      SERVED,
      { projectId: OTHER },
      undefined,
      ['servesIn agent acme.desk OTHER'],
    ],
    ['unnamed', 'flow', SERVED, {}, undefined, ['servedElsewhere flow acme.desk']],
    [
      'unnamed, one project serving it',
      'flow',
      SOLO,
      {},
      undefined,
      ['servedElsewhere flow acme.solo'],
    ],
    [
      "a conversation's, not its first",
      'agent',
      SERVED,
      { input: { conversationId: IN_PROD } },
      undefined,
      ['servedElsewhere agent acme.desk', 'servesIn agent acme.desk PROD'],
    ],
    [
      "a conversation's, its first",
      'agent',
      SERVED,
      { input: { conversationId: IN_STAGING } },
      undefined,
      ['servedElsewhere agent acme.desk'],
    ],
    [
      "a conversation's, outside its projects",
      'agent',
      SERVED,
      { input: { conversationId: IN_OTHER } },
      undefined,
      ['servedElsewhere agent acme.desk', 'servesIn agent acme.desk OTHER'],
    ],
    [
      "a key's, not its first",
      'flow',
      SERVED,
      {},
      PROD,
      ['servedElsewhere flow acme.desk', 'servesIn flow acme.desk PROD'],
    ],
    ["a key's, its first", 'flow', SERVED, {}, STAGING, ['servedElsewhere flow acme.desk']],
    [
      "a key's, outside its projects",
      'flow',
      SERVED,
      {},
      OTHER,
      ['servedElsewhere flow acme.desk', 'servesIn flow acme.desk OTHER'],
    ],
    ["a key's, one project serving it", 'flow', SOLO, {}, PROD, ['servedElsewhere flow acme.solo']],
  ] as const)('%s: asks only that', async (_, target, id, more, key, expected) => {
    const { call, items } = harness();
    await call(key === undefined ? 'all' : `all@${key}`, 'POST', '/v1/runs', run(target, id, more));
    expect(items.asked.map(named)).toEqual(expected);
  });
});

describe('conversations with an agent an order carries', () => {
  const open = (more: Record<string, unknown> = {}) => ({
    agentId: SERVED,
    agentVersion: '1.0.0',
    ...more,
  });

  test('a prod caller opens one in prod: call there, not execute on the agent', async () => {
    const { call, conversations } = harness();
    const res = await call('prod', 'POST', '/v1/conversations', open({ projectId: PROD }));
    expect(res.status, res.text).not.toBe(403);
    expect(res.asked).toEqual([`prod call project:${PROD}`]);
    expect(conversations).toEqual([`open ${SERVED} in ${PROD}`]);
  });

  test('named one of its projects, a caller without call there gets the same answer whether it exists or not', async () => {
    // PROD gone, as a project deleted while still in the order: the
    // existence check refuses prod, who may open one there.
    const present = harness({ projects: [STAGING, PROD] });
    const gone = harness({ projects: [STAGING] });
    const prod = await gone.call('prod', 'POST', '/v1/conversations', open({ projectId: PROD }));
    expect(prod.status, prod.text).toBe(400);
    const a = await present.call('staging', 'POST', '/v1/conversations', open({ projectId: PROD }));
    const b = await gone.call('staging', 'POST', '/v1/conversations', open({ projectId: PROD }));
    expect(a.status, a.text).toBe(403);
    expect(b.text).toBe(a.text);
    expect(a.asked).toEqual([`staging call project:${PROD}`]);
    expect(b.asked).toEqual(a.asked);
    expect(present.conversations).toEqual([]);
    expect(gone.conversations).toEqual([]);
  });

  test("unnamed, it opens in the agent's own project, checked there; a prod key's opens in prod", async () => {
    const { call, conversations } = harness();
    const prod = await call('prod', 'POST', '/v1/conversations', open());
    expect(prod.status, prod.text).toBe(403);
    expect(prod.body.error.message).toBe(
      `Permission denied: opening a conversation with agent "${SERVED}" in project ${STAGING} needs caller or editor on ${STAGING} (test: not granted)`,
    );
    const key = await call(`prod@${PROD}`, 'POST', '/v1/conversations', open());
    expect(key.status, key.text).not.toBe(403);
    expect(conversations).toEqual([`open ${SERVED} in ${PROD}`]);
  });

  test("today's execute on the agent doesn't open one in its projects", async () => {
    const { call } = harness();
    const res = await call('item', 'POST', '/v1/conversations', open({ projectId: PROD }));
    expect(res.status, res.text).toBe(403);
  });

  test('closing one is call where it is', async () => {
    const { call, conversations } = harness();
    // Reads prod, and doesn't call there.
    const reader = await call('event-prod', 'POST', `/v1/conversations/${IN_PROD}/close`);
    expect(reader.status, reader.text).toBe(403);
    expect(reader.body.error.message).toContain(
      `closing a conversation with agent "${SERVED}" in project ${PROD}`,
    );
    // Can't read prod: as if there were no such conversation.
    const staging = await call('staging', 'POST', `/v1/conversations/${IN_PROD}/close`);
    expect(staging.status, staging.text).toBe(404);
    expect(staging.body.error.message).toBe(`No conversation with id "${IN_PROD}"`);
    expect(conversations).toEqual([]);
    // Closing one doesn't take reading it: each close reaches the store.
    const caller = await call('prod-caller', 'POST', `/v1/conversations/${IN_PROD}/close`);
    expect(conversations, caller.text).toEqual([`close ${IN_PROD}`]);
    const prod = await call('prod', 'POST', `/v1/conversations/${IN_PROD}/close`);
    expect(conversations, prod.text).toEqual([`close ${IN_PROD}`, `close ${IN_PROD}`]);
  });

  test('an agent with one project: execute on it, as before', async () => {
    const body = { agentId: SOLO, agentVersion: '1.0.0' };
    const a = await harness().call('solo', 'POST', '/v1/conversations', body);
    const b = await harness({ served: false }).call('solo', 'POST', '/v1/conversations', body);
    expect(a.text).toBe(b.text);
    expect(a.asked).toEqual(b.asked);
    expect(a.asked).toEqual([`solo execute agent:${SOLO}`]);
  });
});

describe('test runs of a test set an order carries', () => {
  const start = (projectId: ProjectId, testSetId = SERVED) => ({
    projectId,
    agentRef: { agentId: testSetId },
  });

  test('a prod member runs it in prod: execute there for the test set, call for the agent, write to file the results', async () => {
    const { call, evals } = harness();
    const res = await call('prod-evals', 'POST', `/v1/test-sets/${SERVED}/runs`, start(PROD));
    expect(res.status, res.text).not.toBe(403);
    expect(res.asked).toEqual([
      `prod-evals execute project:${PROD}`,
      `prod-evals write project:${PROD}`,
      `prod-evals call project:${PROD}`,
    ]);
    expect(evals).toEqual([`start ${SERVED} in ${PROD}`]);
  });

  test("today's rights on the test set don't run it in its projects", async () => {
    const { call, evals } = harness();
    const res = await call('test-set-admin', 'POST', `/v1/test-sets/${SERVED}/runs`, start(PROD));
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toContain(
      `running test set "${SERVED}" in project ${PROD} needs executor or editor`,
    );
    expect(evals).toEqual([]);
  });

  test("a prod member reads, cancels and rescores prod's runs, and lists only those", async () => {
    const { call, evals } = harness();
    const read = await call('prod-evals', 'GET', `/v1/test-runs/${EVAL_IN_PROD}`);
    expect(read.status, read.text).toBe(200);
    expect(read.asked).toEqual([`prod-evals read project:${PROD}`]);
    const cancel = await call('prod-evals', 'POST', `/v1/test-runs/${EVAL_IN_PROD}/cancel`);
    expect(cancel.status, cancel.text).not.toBe(403);
    expect(cancel.asked).toEqual([`prod-evals execute project:${PROD}`]);
    const rescore = await call('prod-evals', 'POST', `/v1/test-runs/${EVAL_IN_PROD}/rescore`);
    expect(rescore.status, rescore.text).not.toBe(403);
    expect(rescore.asked[0]).toBe(`prod-evals execute project:${PROD}`);
    expect(evals[0]).toBe(`cancel ${EVAL_IN_PROD}`);
    const listed = await call('prod-evals', 'GET', '/v1/test-runs');
    expect(listed.body.data.map((r: { testRunId: string }) => r.testRunId)).toEqual([EVAL_IN_PROD]);
  });

  test("a staging member doesn't read, cancel or rescore prod's runs", async () => {
    const { call, evals } = harness();
    expect((await call('staging', 'GET', `/v1/test-runs/${EVAL_IN_PROD}`)).status).toBe(403);
    expect((await call('staging', 'GET', `/v1/test-runs/${EVAL_IN_PROD}/events`)).status).toBe(403);
    expect((await call('staging', 'POST', `/v1/test-runs/${EVAL_IN_PROD}/cancel`)).status).toBe(
      403,
    );
    expect((await call('staging', 'POST', `/v1/test-runs/${EVAL_IN_PROD}/rescore`)).status).toBe(
      403,
    );
    expect(evals).toEqual([]);
    const listed = await call('staging', 'GET', '/v1/test-runs');
    expect(listed.body.data.map((r: { testRunId: string }) => r.testRunId)).toEqual([
      EVAL_IN_STAGING,
    ]);
  });

  test("today's rights on the test set don't reach its runs in its projects", async () => {
    const { call } = harness();
    expect((await call('test-set-admin', 'GET', `/v1/test-runs/${EVAL_IN_PROD}`)).status).toBe(403);
    expect((await call('test-set-admin', 'GET', '/v1/test-runs')).body.data).toEqual([]);
  });

  test('a test set with one project: its runs are checked as before', async () => {
    const withBinding = harness();
    const without = harness({ served: false });
    for (const [method, path, body] of [
      ['POST', `/v1/test-sets/${SOLO}/runs`, start(OTHER, SOLO)],
      ['GET', `/v1/test-runs/${EVAL_SOLO}`, undefined],
      ['POST', `/v1/test-runs/${EVAL_SOLO}/cancel`, undefined],
      ['POST', `/v1/test-runs/${EVAL_SOLO}/rescore`, undefined],
      ['GET', `/v1/test-runs?testSetId=${SOLO}`, undefined],
    ] as const) {
      const a = await withBinding.call('solo', method, path, body);
      const b = await without.call('solo', method, path, body);
      expect(a.text, path).toBe(b.text);
      expect(a.asked, path).toEqual(b.asked);
    }
    expect(withBinding.evals).toEqual(without.evals);
  });
});

describe('schedules of what an order carries', () => {
  const schedule = (target: Record<string, unknown>, projectId: ProjectId = PROD) => ({
    ...target,
    projectId,
    config: { cronExpression: '0 2 * * *' },
  });
  const flow = { flowId: SERVED, flowVersion: '1.0.0' };

  test('a prod member schedules the flow in prod: write there, and execute there for the flow', async () => {
    const { call } = harness();
    const res = await call('prod-ops', 'POST', '/v1/schedules', schedule(flow));
    expect(res.status, res.text).toBe(201);
    expect(res.asked).toEqual([
      `prod-ops write project:${PROD}`,
      `prod-ops execute project:${PROD}`,
    ]);
  });

  test("today's execute on the flow doesn't schedule it in its projects", async () => {
    const { call } = harness();
    const res = await call('item', 'POST', '/v1/schedules', schedule(flow));
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toContain(
      `running flow "${SERVED}" in project ${PROD} needs executor or editor`,
    );
  });

  test("an agent's schedule in prod is call there", async () => {
    const { call } = harness();
    const res = await call('prod-ops', 'POST', '/v1/schedules', {
      ...schedule({ agentId: SERVED }),
      config: { cronExpression: '0 2 * * *', input: { userMessage: 'Summarize the night.' } },
    });
    expect(res.status, res.text).toBe(201);
    expect(res.asked).toEqual([`prod-ops write project:${PROD}`, `prod-ops call project:${PROD}`]);
  });

  test('an improve schedule in prod is write where the agent gets its new versions', async () => {
    const { call } = harness();
    const improve = { improve: { agentId: SERVED, projectId: PROD } };
    const prod = await call('prod-ops', 'POST', '/v1/schedules', schedule(improve));
    expect(prod.status, prod.text).toBe(403);
    expect(prod.body.error.message).toContain(
      `improving agent "${SERVED}" needs write on project ${STAGING}`,
    );
    const both = await call('writes-both', 'POST', '/v1/schedules', schedule(improve));
    expect(both.status, both.text).toBe(201);
  });

  test('a flow with one project: scheduled as before', async () => {
    const body = schedule({ flowId: SOLO, flowVersion: '1.0.0' }, OTHER);
    const a = await harness().call('solo', 'POST', '/v1/schedules', body);
    const b = await harness({ served: false }).call('solo', 'POST', '/v1/schedules', body);
    expect(a.status, a.text).toBe(b.status);
    expect(a.asked).toEqual(b.asked);
    expect(a.asked).toEqual([`solo write project:${OTHER}`, `solo execute flow:${SOLO}`]);
  });
});

describe('webhook triggers of a flow an order carries', () => {
  const hook = (projectId: ProjectId, flowId = SERVED) => ({
    flowId,
    flowVersion: '1.0.0',
    hmacSecretName: 'acme-hmac',
    projectId,
  });

  test('a prod member wires one in prod: write there, and execute there for the flow', async () => {
    const { call } = harness();
    const res = await call('prod-ops', 'POST', '/v1/webhooks', hook(PROD));
    expect(res.status, res.text).not.toBe(403);
    // (What the answer shows is asked after: admin on the project, then the tenant.)
    expect(res.asked.slice(0, 2)).toEqual([
      `prod-ops write project:${PROD}`,
      `prod-ops execute project:${PROD}`,
    ]);
    expect(res.asked).not.toContain(`prod-ops execute flow:${SERVED}`);
  });

  test("today's execute on the flow doesn't wire it in its projects", async () => {
    const { call } = harness();
    const res = await call('item', 'POST', '/v1/webhooks', hook(PROD));
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toContain(`needs executor or editor on ${PROD}`);
  });

  test('a flow with one project: wired as before', async () => {
    const a = await harness().call('solo', 'POST', '/v1/webhooks', hook(OTHER, SOLO));
    const b = await harness({ served: false }).call(
      'solo',
      'POST',
      '/v1/webhooks',
      hook(OTHER, SOLO),
    );
    expect(a.status, a.text).toBe(b.status);
    expect(a.asked).toEqual(b.asked);
  });
});

describe('event triggers of a flow an order carries: their runs land in its first project', () => {
  const trigger = (flowId = SERVED) => ({
    flowId,
    flowVersion: '1.0.0',
    config: { eventKind: 'acme.order.created' },
  });

  test('registering one is write on the flow and execute in its first project', async () => {
    const { call } = harness();
    const ok = await call('event-maker', 'POST', '/v1/event-triggers', trigger());
    expect(ok.status, ok.text).toBe(201);
    expect(ok.asked).toEqual([
      `event-maker write flow:${SERVED}`,
      `event-maker execute project:${STAGING}`,
    ]);
    const prod = await call('event-prod', 'POST', '/v1/event-triggers', trigger());
    expect(prod.status, prod.text).toBe(403);
    expect(prod.body.error.message).toContain(`in project ${STAGING} needs executor or editor`);
  });

  test('reading one is read in its first project', async () => {
    const { call } = harness();
    const made = await call('event-maker', 'POST', '/v1/event-triggers', trigger());
    const id = made.body.triggerId as string;
    expect((await call('staging', 'GET', `/v1/event-triggers/${id}`)).status).toBe(200);
    expect((await call('prod', 'GET', `/v1/event-triggers/${id}`)).status).toBe(403);
    const listed = await call('staging', 'GET', '/v1/event-triggers');
    expect(listed.body.data.map((t: { triggerId: string }) => t.triggerId)).toEqual([id]);
    expect((await call('prod', 'GET', '/v1/event-triggers')).body.data).toEqual([]);
  });
});

describe('observations of an agent an order carries', () => {
  test('need read on every project of the agent', async () => {
    const { call } = harness();
    const agents = async (who: string) =>
      (await call(who, 'GET', '/v1/observations')).body.data.map(
        (o: { agentId: string }) => o.agentId,
      );
    expect(await agents('both')).toEqual([SERVED]);
    expect(await agents('prod')).toEqual([]);
    expect(await agents('staging')).toEqual([]);
  });

  test("today's read on the agent isn't enough; a one-project agent's are read as before", async () => {
    const agents = async (h: ReturnType<typeof harness>) =>
      (await h.call('agent-reader', 'GET', '/v1/observations')).body.data.map(
        (o: { agentId: string }) => o.agentId,
      );
    expect(await agents(harness())).toEqual([SOLO]);
    expect(await agents(harness({ served: false }))).toEqual([SERVED, SOLO]);
  });
});

/**
 * `where a start lands`: each case's answer at #1036 (kindgi-sdk 68a40e43), with the whole set,
 * and with #1034's turn checks (`turn-access.ts`): a turn into a conversation `all` didn't open
 * also asks write on its project, and one in a project the key can't read answers as if the
 * conversation weren't there, before anything runs.
 */
const WHOLE_SET_ANSWERS: readonly string[] = [
  'agent acme.desk named - conversation - key -: 404 asked [all call project:STAGING], agent acme.desk in -',
  'agent acme.desk named - conversation - key STAGING: 404 asked [all call project:STAGING], agent acme.desk in STAGING',
  'agent acme.desk named - conversation - key PROD: 404 asked [all call project:PROD], agent acme.desk in PROD',
  'agent acme.desk named - conversation - key OTHER: 403 (Permission denied: running agent "acme.desk" in project STAGING needs caller or editor on STAGING (the API key is limited to project OTHER)) asked [], nothing ran',
  'agent acme.desk named - conversation IN_PROD key -: 404 asked [all call project:PROD, all write project:PROD], agent acme.desk in -',
  'agent acme.desk named - conversation IN_PROD key STAGING: 403 (Permission denied: running agent "acme.desk" in project PROD needs caller or editor on PROD (the API key is limited to project STAGING)) asked [], nothing ran',
  'agent acme.desk named - conversation IN_PROD key PROD: 404 asked [all call project:PROD, all write project:PROD], agent acme.desk in -',
  'agent acme.desk named - conversation IN_PROD key OTHER: 403 (Permission denied: running agent "acme.desk" in project PROD needs caller or editor on PROD (the API key is limited to project OTHER)) asked [], nothing ran',
  'agent acme.desk named - conversation IN_STAGING key -: 404 asked [all call project:STAGING, all write project:STAGING], agent acme.desk in -',
  'agent acme.desk named - conversation IN_STAGING key STAGING: 404 asked [all call project:STAGING, all write project:STAGING], agent acme.desk in -',
  'agent acme.desk named - conversation IN_STAGING key PROD: 403 (Permission denied: running agent "acme.desk" in project STAGING needs caller or editor on STAGING (the API key is limited to project PROD)) asked [], nothing ran',
  'agent acme.desk named - conversation IN_STAGING key OTHER: 403 (Permission denied: running agent "acme.desk" in project STAGING needs caller or editor on STAGING (the API key is limited to project OTHER)) asked [], nothing ran',
  'agent acme.desk named - conversation IN_OTHER key -: 404 asked [all execute agent:acme.desk, all write project:OTHER], agent acme.desk in -',
  'agent acme.desk named - conversation IN_OTHER key STAGING: 404 asked [all execute agent:acme.desk], nothing ran',
  'agent acme.desk named - conversation IN_OTHER key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'agent acme.desk named - conversation IN_OTHER key OTHER: 403 (Permission denied: the API key is limited to project OTHER) asked [], nothing ran',
  'agent acme.desk named STAGING conversation - key -: 404 asked [all call project:STAGING], agent acme.desk in STAGING',
  'agent acme.desk named STAGING conversation - key STAGING: 404 asked [all call project:STAGING], agent acme.desk in STAGING',
  'agent acme.desk named STAGING conversation - key PROD: 403 (This API key is limited to project PROD; the request names project STAGING) asked [], nothing ran',
  'agent acme.desk named STAGING conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project STAGING) asked [], nothing ran',
  'agent acme.desk named PROD conversation - key -: 404 asked [all call project:PROD], agent acme.desk in PROD',
  'agent acme.desk named PROD conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project PROD) asked [], nothing ran',
  'agent acme.desk named PROD conversation - key PROD: 404 asked [all call project:PROD], agent acme.desk in PROD',
  'agent acme.desk named PROD conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project PROD) asked [], nothing ran',
  'agent acme.desk named OTHER conversation - key -: 404 asked [all execute agent:acme.desk, all write project:OTHER], agent acme.desk in OTHER',
  'agent acme.desk named OTHER conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project OTHER) asked [], nothing ran',
  'agent acme.desk named OTHER conversation - key PROD: 403 (This API key is limited to project PROD; the request names project OTHER) asked [], nothing ran',
  'agent acme.desk named OTHER conversation - key OTHER: 403 (Permission denied: the API key is limited to project OTHER) asked [], nothing ran',
  'agent acme.solo named - conversation - key -: 404 asked [all execute agent:acme.solo], agent acme.solo in -',
  'agent acme.solo named - conversation - key STAGING: 403 (Permission denied: the API key is limited to project STAGING) asked [], nothing ran',
  'agent acme.solo named - conversation - key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'agent acme.solo named - conversation - key OTHER: 404 asked [all execute agent:acme.solo], agent acme.solo in -',
  'agent acme.solo named - conversation IN_PROD key -: 404 asked [all execute agent:acme.solo, all write project:PROD], agent acme.solo in -',
  'agent acme.solo named - conversation IN_PROD key STAGING: 403 (Permission denied: the API key is limited to project STAGING) asked [], nothing ran',
  'agent acme.solo named - conversation IN_PROD key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'agent acme.solo named - conversation IN_PROD key OTHER: 404 asked [all execute agent:acme.solo], nothing ran',
  'agent acme.solo named - conversation IN_STAGING key -: 404 asked [all execute agent:acme.solo, all write project:STAGING], agent acme.solo in -',
  'agent acme.solo named - conversation IN_STAGING key STAGING: 403 (Permission denied: the API key is limited to project STAGING) asked [], nothing ran',
  'agent acme.solo named - conversation IN_STAGING key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'agent acme.solo named - conversation IN_STAGING key OTHER: 404 asked [all execute agent:acme.solo], nothing ran',
  'agent acme.solo named - conversation IN_OTHER key -: 404 asked [all execute agent:acme.solo, all write project:OTHER], agent acme.solo in -',
  'agent acme.solo named - conversation IN_OTHER key STAGING: 403 (Permission denied: the API key is limited to project STAGING) asked [], nothing ran',
  'agent acme.solo named - conversation IN_OTHER key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'agent acme.solo named - conversation IN_OTHER key OTHER: 404 asked [all execute agent:acme.solo, all write project:OTHER], agent acme.solo in -',
  'agent acme.solo named STAGING conversation - key -: 404 asked [all execute agent:acme.solo, all write project:STAGING], agent acme.solo in STAGING',
  'agent acme.solo named STAGING conversation - key STAGING: 403 (Permission denied: the API key is limited to project STAGING) asked [], nothing ran',
  'agent acme.solo named STAGING conversation - key PROD: 403 (This API key is limited to project PROD; the request names project STAGING) asked [], nothing ran',
  'agent acme.solo named STAGING conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project STAGING) asked [], nothing ran',
  'agent acme.solo named PROD conversation - key -: 404 asked [all execute agent:acme.solo, all write project:PROD], agent acme.solo in PROD',
  'agent acme.solo named PROD conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project PROD) asked [], nothing ran',
  'agent acme.solo named PROD conversation - key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'agent acme.solo named PROD conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project PROD) asked [], nothing ran',
  'agent acme.solo named OTHER conversation - key -: 404 asked [all execute agent:acme.solo, all write project:OTHER], agent acme.solo in OTHER',
  'agent acme.solo named OTHER conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project OTHER) asked [], nothing ran',
  'agent acme.solo named OTHER conversation - key PROD: 403 (This API key is limited to project PROD; the request names project OTHER) asked [], nothing ran',
  'agent acme.solo named OTHER conversation - key OTHER: 404 asked [all execute agent:acme.solo, all write project:OTHER], agent acme.solo in OTHER',
  'flow acme.desk named - conversation - key -: 404 asked [all execute project:STAGING], flow acme.desk in -',
  'flow acme.desk named - conversation - key STAGING: 404 asked [all execute project:STAGING], flow acme.desk in STAGING',
  'flow acme.desk named - conversation - key PROD: 404 asked [all execute project:PROD], flow acme.desk in PROD',
  'flow acme.desk named - conversation - key OTHER: 403 (Permission denied: running flow "acme.desk" in project STAGING needs executor or editor on STAGING (the API key is limited to project OTHER)) asked [], nothing ran',
  'flow acme.desk named STAGING conversation - key -: 404 asked [all execute project:STAGING], flow acme.desk in STAGING',
  'flow acme.desk named STAGING conversation - key STAGING: 404 asked [all execute project:STAGING], flow acme.desk in STAGING',
  'flow acme.desk named STAGING conversation - key PROD: 403 (This API key is limited to project PROD; the request names project STAGING) asked [], nothing ran',
  'flow acme.desk named STAGING conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project STAGING) asked [], nothing ran',
  'flow acme.desk named PROD conversation - key -: 404 asked [all execute project:PROD], flow acme.desk in PROD',
  'flow acme.desk named PROD conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project PROD) asked [], nothing ran',
  'flow acme.desk named PROD conversation - key PROD: 404 asked [all execute project:PROD], flow acme.desk in PROD',
  'flow acme.desk named PROD conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project PROD) asked [], nothing ran',
  'flow acme.desk named OTHER conversation - key -: 404 asked [all execute flow:acme.desk, all write project:OTHER], flow acme.desk in OTHER',
  'flow acme.desk named OTHER conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project OTHER) asked [], nothing ran',
  'flow acme.desk named OTHER conversation - key PROD: 403 (This API key is limited to project PROD; the request names project OTHER) asked [], nothing ran',
  'flow acme.desk named OTHER conversation - key OTHER: 403 (Permission denied: the API key is limited to project OTHER) asked [], nothing ran',
  'flow acme.solo named - conversation - key -: 404 asked [all execute flow:acme.solo], flow acme.solo in -',
  'flow acme.solo named - conversation - key STAGING: 403 (Permission denied: the API key is limited to project STAGING) asked [], nothing ran',
  'flow acme.solo named - conversation - key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'flow acme.solo named - conversation - key OTHER: 404 asked [all execute flow:acme.solo], flow acme.solo in -',
  'flow acme.solo named STAGING conversation - key -: 404 asked [all execute flow:acme.solo, all write project:STAGING], flow acme.solo in STAGING',
  'flow acme.solo named STAGING conversation - key STAGING: 403 (Permission denied: the API key is limited to project STAGING) asked [], nothing ran',
  'flow acme.solo named STAGING conversation - key PROD: 403 (This API key is limited to project PROD; the request names project STAGING) asked [], nothing ran',
  'flow acme.solo named STAGING conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project STAGING) asked [], nothing ran',
  'flow acme.solo named PROD conversation - key -: 404 asked [all execute flow:acme.solo, all write project:PROD], flow acme.solo in PROD',
  'flow acme.solo named PROD conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project PROD) asked [], nothing ran',
  'flow acme.solo named PROD conversation - key PROD: 403 (Permission denied: the API key is limited to project PROD) asked [], nothing ran',
  'flow acme.solo named PROD conversation - key OTHER: 403 (This API key is limited to project OTHER; the request names project PROD) asked [], nothing ran',
  'flow acme.solo named OTHER conversation - key -: 404 asked [all execute flow:acme.solo, all write project:OTHER], flow acme.solo in OTHER',
  'flow acme.solo named OTHER conversation - key STAGING: 403 (This API key is limited to project STAGING; the request names project OTHER) asked [], nothing ran',
  'flow acme.solo named OTHER conversation - key PROD: 403 (This API key is limited to project PROD; the request names project OTHER) asked [], nothing ran',
  'flow acme.solo named OTHER conversation - key OTHER: 404 asked [all execute flow:acme.solo, all write project:OTHER], flow acme.solo in OTHER',
];
