// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/agents/:agentId/versions` derives a new agent version from
 * a pinned one with some data-block pins swapped: an expert's edit
 * reaching an agent with no code change. The new version is numbered
 * the next free patch after the agent's highest version and records
 * `derivedFrom: { version, reason: 'edited', label, by }`. Only blocks
 * the version already references swap, to a published, active version
 * of the right kind; tool pins come from code. It needs `publish` on
 * the agent.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Agent, createAgentRegistry, pinsDigest } from '@kindgi/agents';
import type { Action, AuthzCheckBinding, Decision, ResourceRef, TupleIntent } from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  AgentVersionRecord,
  BlockRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'agents-derive-token';

const ACCOUNT_TOKEN = 'agents-derive-account-token';
const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId, userId: 'user-1' as UserId };
  if (token === ACCOUNT_TOKEN) return { tenantId, serviceAccountId: 'sa-ci' };
  return null;
};

/**
 * The agent registry, storing what the route hands it. It records the
 * project each version was published to unless `recordsProject` is false,
 * and reads it back on every record as a store does: the agent's project
 * is its first version's, and each version's `madeInProjectId` is where
 * it was published. A version may be published to another project of the
 * agent's project's order (`orders`), as a store allows. It answers one
 * version a page, so a derive reads every page.
 */
function agentBinding(
  recordsProject = true,
  orders: readonly (readonly ProjectId[])[] = [],
): AgentRegistryBinding & {
  markUnregistered: (version: string) => void;
  /** The entries each version's publish wrote. */
  written: TupleIntent[];
} {
  const registry = createAgentRegistry();
  const projects = new Map<string, ProjectId>();
  const unregistered = new Set<string>();
  const written: TupleIntent[] = [];
  const withProject = (agent: AgentVersionRecord): AgentVersionRecord => {
    const project = projects.get(agent.version as unknown as string);
    const owner = projects.values().next().value;
    return recordsProject && project !== undefined
      ? { ...agent, projectId: owner ?? project, madeInProjectId: project }
      : agent;
  };
  const active = (agentId: string) =>
    registry
      .list()
      .filter((a) => (a.id as unknown as string) === agentId)
      .filter((a) => !unregistered.has(a.version as unknown as string))
      .map(withProject);
  return {
    markUnregistered: (version) => unregistered.add(version),
    written,
    async list() {
      return { data: [] };
    },
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      return got.kind === 'ok' ? withProject(got.value) : null;
    },
    async getVersion({ agentId, version }) {
      const got = registry.get(agentId, version as unknown as string);
      if (got.kind !== 'ok') return null;
      return {
        ...withProject(got.value),
        ...(unregistered.has(version as unknown as string) && {
          unregisteredAt: '2026-10-01T00:00:00.000Z',
        }),
      };
    },
    async headExists() {
      return false;
    },
    async listVersions({ agentId, cursor }) {
      const all = active(agentId as unknown as string);
      const at = cursor === undefined ? 0 : Number(cursor);
      const data = all.slice(at, at + 1);
      return at + 1 < all.length ? { data, nextCursor: String(at + 1) as never } : { data };
    },
    async publish({ agent, projectId: project, enqueueTuples }) {
      // The agent stays in its first version's project, as a store keeps it;
      // a version may be made in another project of that project's order.
      const owner = projects.values().next().value;
      const sameOrder = orders.some(
        (o) => owner !== undefined && o.includes(owner) && o.includes(project),
      );
      if (owner !== undefined && owner !== project && !sameOrder) {
        return {
          kind: 'project-mismatch',
          agentId: agent.id,
          version: agent.version,
          projectId: owner,
        };
      }
      if (registry.get(agent.id, agent.version as unknown as string).kind === 'ok') {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      registry.register(agent);
      projects.set(agent.version as unknown as string, project);
      written.push(...enqueueTuples(agent.id as unknown as string));
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister() {
      return { unregistered: false };
    },
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
  };
}

function decision(grants: readonly string[], action: Action, resource: ResourceRef): Decision {
  const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

async function harness(
  opts: {
    recordsProject?: boolean;
    grants?: readonly string[];
    orders?: readonly (readonly ProjectId[])[];
    token?: string;
  } = {},
) {
  const agents = agentBinding(opts.recordsProject, opts.orders);
  const blocks = inMemoryBlocks([projectId]);
  const put = (block: Parameters<BlockRegistryBinding['publish']>[0]['block']) =>
    blocks.publish({
      publishedBy: { kind: 'user', id: 'user-1' },
      source: { kind: 'api' },
      tenantId,
      projectId,
      block,
    });
  const prompt = (version: string, template: string) =>
    put({ id: 'acme.intake-prompt', version, kind: 'prompt', content: { template } });
  const settings = (id: string, version: string, values: Record<string, unknown>) =>
    put({ id, version, kind: 'settings', content: { values } });
  await prompt('1.0.0', 'Sort it.');
  await settings('acme.weights', '1.0.0', { recency: 0.3 });
  await settings('acme.model', '1.0.0', { temperature: 0.2 });
  await settings('acme.other', '1.0.0', { x: 1 });

  const grants = opts.grants;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentRegistry: agents,
    blockRegistry: blocks,
    ...(opts.orders !== undefined && { environmentOrders: environmentOrders(opts.orders) }),
    ...(grants !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, resource) => decision(grants, action, resource),
          checkBatch: async (_p, action, resources) =>
            resources.map((resource) => decision(grants, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${opts.token ?? TOKEN}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** Publish a version of the agent straight to the store, pinned to the first block versions. */
  const publishAgent = async (
    version: string,
    pinned = true,
    extra: Record<string, unknown> = {},
  ) => {
    const pins = {
      tools: {},
      prompts: { 'acme.intake-prompt': '1.0.0' },
      settings: { 'acme.weights': '1.0.0', 'acme.model': '1.0.0' },
    };
    const agent = {
      id: 'acme.intake',
      version,
      name: 'Intake',
      instructions: { prompt: 'acme.intake-prompt', version: '^1.0.0' },
      settings: [{ id: 'acme.weights', version: '^1.0.0' }],
      modelSettings: { id: 'acme.model', version: '^1.0.0' },
      capabilities: [],
      tools: [],
      retrieval: [],
      guardrails: [],
      ...(pinned && { pins, pinsDigest: pinsDigest(pins) }),
      ...extra,
    } as unknown as Agent;
    await agents.publish({ tenantId, projectId, agent, enqueueTuples: () => [] });
  };
  return { call, agents, prompt, settings, publishAgent };
}

const derive = (body: unknown) => ['POST', '/v1/agents/acme.intake/versions', body] as const;

describe('POST /v1/agents/:agentId/versions derives a version', () => {
  test('swaps the named pins, keeps the rest, and records where it came from and who made it', async () => {
    const { call, prompt, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');

    const res = await call(
      ...derive({
        from: '1.0.0',
        pins: { prompts: { 'acme.intake-prompt': '1.1.0' } },
        label: 'Tighter tone',
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const pins = {
      tools: {},
      prompts: { 'acme.intake-prompt': '1.1.0' },
      settings: { 'acme.weights': '1.0.0', 'acme.model': '1.0.0' },
    };
    expect(res.body).toMatchObject({
      id: 'acme.intake',
      version: '1.0.1',
      projectId,
      instructions: { prompt: 'acme.intake-prompt', version: '^1.0.0' },
      pins,
      pinsDigest: pinsDigest(pins),
      derivedFrom: { version: '1.0.0', reason: 'edited', label: 'Tighter tone', by: 'user:user-1' },
    });

    const read = await call('GET', '/v1/agents/acme.intake/versions/1.0.1');
    expect(read.body.pins).toEqual(pins);
    expect(read.body.projectId).toBe(projectId);
  });

  test("is numbered the next free patch after the agent's highest version", async () => {
    const { call, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await publishAgent('1.3.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    await settings('acme.weights', '1.2.0', { recency: 0.6 });
    const first = await call(
      ...derive({ from: '1.0.0', pins: { settings: { 'acme.weights': '1.1.0' } } }),
    );
    expect(first.body.version).toBe('1.3.1');
    const second = await call(
      ...derive({ from: '1.0.0', pins: { settings: { 'acme.weights': '1.2.0' } } }),
    );
    expect(second.body.version).toBe('1.3.2');
  });

  test('the same swap again returns the version that already holds it (200), not a duplicate', async () => {
    const { call, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const swap = { from: '1.0.0', pins: { settings: { 'acme.weights': '1.1.0' } } };
    const first = await call(...derive({ ...swap, label: 'First' }));
    expect([first.status, first.body.version]).toEqual([201, '1.0.1']);
    // The registry's rows say where they're kept: still the same definition.
    const again = await call(...derive({ ...swap, label: 'Again' }));
    expect([again.status, again.body.version, again.body.projectId]).toEqual([
      200,
      '1.0.1',
      projectId,
    ]);
    expect(again.body.derivedFrom).toMatchObject({ version: '1.0.0', label: 'First' });
    expect(again.body.pinsDigest).toBe(first.body.pinsDigest);
  });

  test('a number an unregistered version holds is skipped', async () => {
    const { call, agents, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await publishAgent('1.0.1');
    agents.markUnregistered('1.0.1');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const res = await call(
      ...derive({ from: '1.0.0', pins: { settings: { 'acme.weights': '1.1.0' } } }),
    );
    expect(res.body.version).toBe('1.0.2');
  });

  test('the project comes from the stored version, else from the body', async () => {
    const { call, settings, publishAgent } = await harness({ recordsProject: false });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const body = { from: '1.0.0', pins: { settings: { 'acme.weights': '1.1.0' } } };
    const missing = await call(...derive(body));
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('`projectId` is required');
    expect((await call(...derive({ ...body, projectId }))).status).toBe(201);
  });

  test("another project in the body is refused (409 agent-project-mismatch): agents don't move", async () => {
    const { call, settings, publishAgent } = await harness({ recordsProject: false });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const elsewhere = randomUUID();
    const res = await call(
      ...derive({
        from: '1.0.0',
        pins: { settings: { 'acme.weights': '1.1.0' } },
        projectId: elsewhere,
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('agent-project-mismatch');
    expect(res.body.error.message).toContain(
      'belongs to another project; derive its versions there',
    );
    expect(res.body.error.details).toEqual({ agentId: 'acme.intake' });
  });
});

describe('POST /v1/agents: a number a derived version took', () => {
  test('is refused (409), naming the next free version', async () => {
    const { call, prompt, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');
    const derived = await call(
      ...derive({ from: '1.0.0', pins: { prompts: { 'acme.intake-prompt': '1.1.0' } } }),
    );
    expect(derived.body.version).toBe('1.0.1');

    // A developer's later publish of 1.0.1 never overwrites the expert's version.
    const res = await call('POST', '/v1/agents', {
      id: 'acme.intake',
      version: '1.0.1',
      name: 'Intake',
      instructions: 'Sort the request.',
      capabilities: [{ needs: [{ feature: 'tool-use' }] }],
      tools: [],
      retrieval: [],
      guardrails: [],
      projectId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'agent-already-registered',
      details: { version: '1.0.1', nextFreeVersion: '1.0.2' },
    });
    expect(res.body.error.message).toContain('publish it as 1.0.2, the next free version');
  });
});

describe('POST /v1/agents/:agentId/versions refuses', () => {
  test('an unknown version (404) and one published before pins', async () => {
    const { call, publishAgent } = await harness();
    const swap = { prompts: { 'acme.intake-prompt': '1.0.0' } };
    const missing = await call(...derive({ from: '9.9.9', pins: swap }));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('agent-not-found');

    await publishAgent('1.0.0', false);
    const unpinned = await call(...derive({ from: '1.0.0', pins: swap }));
    expect(unpinned.status).toBe(400);
    expect(unpinned.body.error.code).toBe('validation-failed');
    expect(unpinned.body.error.message).toContain('has no pins');
  });

  test('a swap the version cannot take, naming each', async () => {
    const { call, prompt, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');
    await prompt('1.2.0', 'Sort it best.');
    await settings('acme.model', '1.1.0', { volume: 11 });
    const res = await call(
      ...derive({
        from: '1.0.0',
        pins: {
          prompts: { 'acme.intake-prompt': '7.0.0' },
          settings: { 'acme.other': '1.0.0', 'acme.model': '1.1.0' },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(res.body.error.details.issues).toEqual([
      {
        path: '/pins/prompts/acme.intake-prompt',
        message: 'block "acme.intake-prompt" version 7.0.0 isn\'t published',
      },
      {
        path: '/pins/settings/acme.other',
        message:
          'agent version 1.0.0 doesn\'t reference settings block "acme.other"; adding a block is a code change',
      },
      {
        path: '/pins/settings/acme.model',
        message: expect.stringContaining('block "acme.model" version 1.1.0 isn\'t model settings'),
      },
    ]);
  });

  test('model settings that name the model the agent names too are refused, naming both', async () => {
    const { call, settings, publishAgent } = await harness();
    await publishAgent('1.0.0', true, { preferredModel: 'claude-sonnet-5-5' });
    await settings('acme.model', '1.1.0', { model: 'claude-haiku-4-5' });
    await settings('acme.model', '1.2.0', { temperature: 0.7 });
    const res = await call(
      ...derive({ from: '1.0.0', pins: { settings: { 'acme.model': '1.1.0' } } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([
      {
        path: '/pins/settings/acme.model',
        message:
          'block "acme.model" version 1.1.0: it sets model, and the agent version sets preferredModel: name the model in one place, the block or the agent version',
      },
    ]);
    const temperature = await call(
      ...derive({ from: '1.0.0', pins: { settings: { 'acme.model': '1.2.0' } } }),
    );
    expect(temperature.status).toBe(201);
  });

  test('an unregistered block version, no swaps, or swaps that change nothing', async () => {
    const { call, prompt, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');
    await call('POST', '/v1/blocks/acme.intake-prompt/versions/1.1.0/unregister');
    const issues = async (pins: object) =>
      (await call(...derive({ from: '1.0.0', pins }))).body.error.details.issues;
    expect(await issues({ prompts: { 'acme.intake-prompt': '1.1.0' } })).toEqual([
      {
        path: '/pins/prompts/acme.intake-prompt',
        message: 'block "acme.intake-prompt" version 1.1.0 is unregistered',
      },
    ]);
    expect(await issues({})).toEqual([
      { path: '/pins', message: 'name at least one prompt or settings pin to swap' },
    ]);
    expect(await issues({ prompts: { 'acme.intake-prompt': '1.0.0' } })).toEqual([
      { path: '/pins', message: 'no pin changes' },
    ]);
  });

  test('a malformed body', async () => {
    const { call } = await harness();
    const noFrom = await call(...derive({ pins: {} }));
    expect(noFrom.status).toBe(400);
    expect(noFrom.body.error.code).toBe('bad-input');
    const badPins = await call(...derive({ from: '1.0.0', pins: { prompts: { a: 1 } } }));
    expect(badPins.body.error.message).toContain(
      '`pins.prompts` must map block ids to exact versions',
    );
    const tools = await call(
      ...derive({ from: '1.0.0', pins: { tools: { 'acme.lookup': '2.0.0' } } }),
    );
    expect(tools.status).toBe(400);
    expect(tools.body.error.message).toContain('tool pins come from code');
  });
});

describe('POST /v1/agents/:agentId/versions is authorized as publish on the agent', () => {
  test('read alone is refused; publish derives', async () => {
    const body = { from: '1.0.0', pins: { prompts: { 'acme.intake-prompt': '1.1.0' } } };
    const reader = await harness({ grants: ['read agent:acme.intake'] });
    await reader.publishAgent('1.0.0');
    await reader.prompt('1.1.0', 'Sort it well.');
    const refused = await reader.call(...derive(body));
    expect(refused.status).toBe(403);
    // The authorizer middleware's denial names the action it needed.
    expect(JSON.stringify(refused.body)).toContain('"action":"publish"');

    const publisher = await harness({ grants: ['publish agent:acme.intake'] });
    await publisher.publishAgent('1.0.0');
    await publisher.prompt('1.1.0', 'Sort it well.');
    expect((await publisher.call(...derive(body))).status).toBe(201);
  });
});

describe("POST /v1/agents/:agentId/versions: who is made the derived version's owner", () => {
  const derivePrompt = async (token?: string) => {
    const h = await harness(token === undefined ? {} : { token });
    await h.publishAgent('1.0.0');
    await h.prompt('1.1.0', 'Sort it well.');
    const res = await h.call(
      ...derive({ from: '1.0.0', pins: { prompts: { 'acme.intake-prompt': '1.1.0' } } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const owners = h.agents.written.filter((t) => t.relation === 'owner').map((t) => t.user);
    return { body: res.body, owners };
  };

  test("a person's key makes them its owner", async () => {
    const { owners } = await derivePrompt();
    expect(owners).toEqual(['user:user-1']);
  });

  test("a service account's key makes no one its owner, and records no `by`", async () => {
    const { body, owners } = await derivePrompt(ACCOUNT_TOKEN);
    expect(owners).toEqual([]);
    expect(body.derivedFrom).not.toHaveProperty('by');
  });
});

describe('POST /v1/agents/:agentId/versions in a tenant with environment orders', () => {
  // The agent lives in prod (`projectId`), last of the order; its new
  // versions are made in the order's first environment.
  const STAGING_1 = randomUUID() as ProjectId;
  const STAGING_2 = randomUUID() as ProjectId;
  const ORDER = [[STAGING_1, STAGING_2, projectId]] as const;
  const swap = { from: '1.0.0', pins: { settings: { 'acme.weights': '1.1.0' } } };

  test('naming a later environment is refused (409 environment-takes-promotions) and nothing is made', async () => {
    const { call, agents, settings, publishAgent } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const res = await call(...derive({ ...swap, projectId: STAGING_2 }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('environment-takes-promotions');
    expect(res.body.error.message).toBe(
      "This project is a later environment of its environment order (position 1), and a later environment takes builds only by promotion from the one before it. A new version of an agent is made in the order's first environment, and reaches the later ones when a build of the agent is promoted. Nothing was made.",
    );
    expect(res.body.error.details).toEqual({ firstProjectId: STAGING_1, position: 1 });
    expect(
      await agents.getVersion({
        tenantId,
        agentId: 'acme.intake' as never,
        version: '1.0.1' as never,
      }),
    ).toBeNull();
  });

  test("from a version in prod, it's made in the first environment and stays the agent's", async () => {
    const { call, agents, settings, publishAgent } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const res = await call(...derive(swap));
    expect(res.status).toBe(201);
    expect(res.body.version).toBe('1.0.1');
    expect(res.body.projectId).toBe(projectId);
    expect(res.body).not.toHaveProperty('madeInProjectId');
    const stored = await agents.getVersion({
      tenantId,
      agentId: 'acme.intake' as never,
      version: '1.0.1' as never,
    });
    expect(stored?.projectId).toBe(projectId);
    expect(stored?.madeInProjectId).toBe(STAGING_1);
  });

  test('naming the first environment makes it there', async () => {
    const { call, agents, settings, publishAgent } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const res = await call(...derive({ ...swap, projectId: STAGING_1 }));
    expect(res.status).toBe(201);
    const stored = await agents.getVersion({
      tenantId,
      agentId: 'acme.intake' as never,
      version: '1.0.1' as never,
    });
    expect(stored?.madeInProjectId).toBe(STAGING_1);
  });

  test('the same swap again returns the version made in the first environment (200)', async () => {
    const { call, settings, publishAgent } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    expect((await call(...derive(swap))).status).toBe(201);
    const again = await call(...derive(swap));
    expect([again.status, again.body.version]).toEqual([200, '1.0.1']);
  });

  test('an agent in no order is derived in its own project, as before', async () => {
    const { call, agents, settings, publishAgent } = await harness({
      orders: [[STAGING_1, STAGING_2]],
    });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    expect((await call(...derive(swap))).status).toBe(201);
    const stored = await agents.getVersion({
      tenantId,
      agentId: 'acme.intake' as never,
      version: '1.0.1' as never,
    });
    expect(stored?.madeInProjectId).toBe(projectId);
  });

  test('without read on the first environment, the refusal leaves it out', async () => {
    const { call, publishAgent, settings } = await harness({
      orders: ORDER,
      grants: ['publish agent:acme.intake'],
    });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const res = await call(...derive({ ...swap, projectId: STAGING_2 }));
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ position: 1 });
  });
});
