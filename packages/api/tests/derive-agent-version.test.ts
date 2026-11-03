// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `deriveAgentVersion` derives a new agent version from a pinned one
 * with some data-block pins swapped: an expert's edit reaching an agent
 * with no code change. A suggested change's agent version is made this
 * way. The new version is numbered the next free patch after the agent's
 * highest version and records `derivedFrom: { version, reason: 'edited',
 * label, by }`. Only blocks the version already references swap, to a
 * published, active version of the right kind; tool pins come from code.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Agent, type AgentId, createAgentRegistry, pinsDigest } from '@kindgi/agents';
import { type TupleIntent, tuplesForCreate } from '@kindgi/authz';
import type { ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import {
  type DeriveAgentVersionInput,
  type DeriveAgentVersionOutcome,
  type PinSwaps,
  deriveAgentVersion,
} from '../src/derive-agent-version.js';
import { createApp } from '../src/index.js';
import type {
  AgentPublishInput,
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
const agentId = 'acme.intake' as AgentId;
const USER = 'user-1' as UserId;
const TOKEN = 'derive-agent-version-token';

/** When a person's publish made a version Latest, as the registry reads it back. */
const LATEST_AT = '2026-10-30T09:00:00.000Z';

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: USER } : null;

/**
 * The agent registry, storing what a publish hands it. It records the
 * project each version was published to unless `recordsProject` is false,
 * and reads it back on every record as a store does: the agent's project
 * is its first version's, and each version's `madeInProjectId` is where
 * it was published. Every record says what its version was made for
 * (`madeFor`), and `latestAt` and `latestBy` when a person's publish made
 * it Latest, over what the stored manifest has, as a store does. A
 * version may be published to another project of the agent's project's
 * order (`orders`), as a store allows. It answers one version a page, so
 * a derive reads every page.
 */
function agentBinding(
  recordsProject = true,
  orders: readonly (readonly ProjectId[])[] = [],
): AgentRegistryBinding & {
  markUnregistered: (version: string) => void;
  /** The entries each version's publish wrote. */
  written: TupleIntent[];
  /** What each version was made for, and who made it Latest, by version. */
  made: Map<string, Pick<AgentPublishInput, 'madeFor' | 'latestBy'>>;
} {
  const registry = createAgentRegistry();
  const projects = new Map<string, ProjectId>();
  const unregistered = new Set<string>();
  const written: TupleIntent[] = [];
  const made = new Map<string, Pick<AgentPublishInput, 'madeFor' | 'latestBy'>>();
  const asRecord = (agent: AgentVersionRecord): AgentVersionRecord => {
    const version = agent.version as unknown as string;
    const project = projects.get(version);
    const owner = projects.values().next().value;
    const madeOf = made.get(version);
    return {
      ...agent,
      ...(recordsProject &&
        project !== undefined && { projectId: owner ?? project, madeInProjectId: project }),
      ...(madeOf !== undefined && { madeFor: madeOf.madeFor }),
      ...(madeOf?.latestBy !== undefined && { latestAt: LATEST_AT, latestBy: madeOf.latestBy }),
    };
  };
  const active = (agentId: string) =>
    registry
      .list()
      .filter((a) => (a.id as unknown as string) === agentId)
      .filter((a) => !unregistered.has(a.version as unknown as string))
      .map(asRecord);
  return {
    markUnregistered: (version) => unregistered.add(version),
    written,
    made,
    async list() {
      return { data: [] };
    },
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      return got.kind === 'ok' ? asRecord(got.value) : null;
    },
    async getVersion({ agentId, version }) {
      const got = registry.get(agentId, version as unknown as string);
      if (got.kind !== 'ok') return null;
      return {
        ...asRecord(got.value),
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
    async publish({ agent, projectId: project, enqueueTuples, madeFor, latestBy }) {
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
      made.set(agent.version as unknown as string, {
        madeFor,
        ...(latestBy !== undefined && { latestBy }),
      });
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister() {
      return { unregistered: false };
    },
    markLatest: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
  };
}

/** What a test asks of a derive; the harness fills in the rest. */
type Derive = Pick<
  DeriveAgentVersionInput,
  'from' | 'swaps' | 'label' | 'suggestedChangeId' | 'projectId'
>;

async function harness(
  opts: { recordsProject?: boolean; orders?: readonly (readonly ProjectId[])[] } = {},
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

  /**
   * Derive a version of the agent as a suggested change does: `userId` is
   * who derives it, recorded as `by` and made the new version's owner.
   */
  const derive = (input: Derive, userId?: UserId) =>
    deriveAgentVersion({
      agents,
      blocks,
      tenantId,
      agentId,
      ...(userId !== undefined && { by: `user:${userId as unknown as string}` }),
      ...(opts.orders !== undefined && { orders: environmentOrders(opts.orders) }),
      tuplesFor: (landsIn) => (id) =>
        tuplesForCreate({ kind: 'agent', id: id as AgentId, tenantId, projectId: landsIn }, userId),
      ...input,
    });
  const stored = (version: string) =>
    agents.getVersion({ tenantId, agentId, version: version as Semver });
  /**
   * Publish a version of the agent straight to the store, pinned to the
   * first block versions, as a deploy does; with `latestBy`, as a person's
   * publish does, which makes it Latest.
   */
  const publishAgent = async (
    version: string,
    pinned = true,
    extra: Record<string, unknown> = {},
    latestBy?: AgentPublishInput['latestBy'],
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
    await agents.publish({
      tenantId,
      projectId,
      agent,
      madeFor: 'latest',
      ...(latestBy !== undefined && { latestBy }),
      enqueueTuples: () => [],
    });
  };
  return { agents, blocks, prompt, settings, publishAgent, derive, stored };
}

/** The version an outcome names, made or reused. */
const agentOf = (outcome: DeriveAgentVersionOutcome) =>
  outcome.kind === 'ok' || outcome.kind === 'reused' ? outcome.agent : undefined;

describe('deriveAgentVersion derives a version', () => {
  test('swaps the named pins, keeps the rest, and records where it came from and who made it', async () => {
    const { derive, prompt, publishAgent, stored } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');

    const outcome = await derive(
      {
        from: '1.0.0',
        swaps: { prompts: { 'acme.intake-prompt': '1.1.0' } },
        label: 'Tighter tone',
        suggestedChangeId: 'sc-1',
      },
      USER,
    );
    const pins = {
      tools: {},
      prompts: { 'acme.intake-prompt': '1.1.0' },
      settings: { 'acme.weights': '1.0.0', 'acme.model': '1.0.0' },
    };
    expect(outcome).toMatchObject({
      kind: 'ok',
      agent: {
        id: 'acme.intake',
        version: '1.0.1',
        projectId,
        instructions: { prompt: 'acme.intake-prompt', version: '^1.0.0' },
        pins,
        pinsDigest: pinsDigest(pins),
        derivedFrom: {
          version: '1.0.0',
          reason: 'edited',
          label: 'Tighter tone',
          by: 'user:user-1',
          suggestedChangeId: 'sc-1',
        },
      },
    });

    const read = await stored('1.0.1');
    expect(read?.pins).toEqual(pins);
    expect(read?.projectId).toBe(projectId);
  });

  test("is made for its project: never Latest by itself, and no one's Latest add", async () => {
    const { derive, prompt, publishAgent, agents } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');
    const outcome = await derive({
      from: '1.0.0',
      swaps: { prompts: { 'acme.intake-prompt': '1.1.0' } },
    });
    expect(outcome.kind).toBe('ok');
    expect(agents.made.get('1.0.1')).toEqual({ madeFor: 'project' });
  });

  test("is numbered the next free patch after the agent's highest version", async () => {
    const { derive, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await publishAgent('1.3.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    await settings('acme.weights', '1.2.0', { recency: 0.6 });
    const first = await derive({ from: '1.0.0', swaps: { settings: { 'acme.weights': '1.1.0' } } });
    expect(agentOf(first)?.version).toBe('1.3.1');
    const second = await derive({
      from: '1.0.0',
      swaps: { settings: { 'acme.weights': '1.2.0' } },
    });
    expect(agentOf(second)?.version).toBe('1.3.2');
  });

  test('the same swap again is the version that already holds it (reused), not a duplicate', async () => {
    const { derive, agents, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const swap = { from: '1.0.0', swaps: { settings: { 'acme.weights': '1.1.0' } } };
    const first = await derive({ ...swap, label: 'First' });
    expect(first).toMatchObject({ kind: 'ok', agent: { version: '1.0.1' } });
    // The registry's rows say where they're kept: still the same definition.
    const again = await derive({ ...swap, label: 'Again' });
    expect(again).toMatchObject({
      kind: 'reused',
      agent: { version: '1.0.1', projectId, derivedFrom: { version: '1.0.0', label: 'First' } },
    });
    expect(agentOf(again)?.pinsDigest).toBe(agentOf(first)?.pinsDigest);
    expect([...agents.made.keys()]).toEqual(['1.0.0', '1.0.1']);
  });

  test("keeps none of what the registry read on the version it's derived from", async () => {
    const { derive, settings, publishAgent, stored } = await harness();
    await publishAgent('1.0.0', true, {}, { kind: 'user', id: 'user-2' });
    expect(await stored('1.0.0')).toMatchObject({
      madeFor: 'latest',
      latestAt: LATEST_AT,
      latestBy: { kind: 'user', id: 'user-2' },
    });
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const swap = { from: '1.0.0', swaps: { settings: { 'acme.weights': '1.1.0' } } };
    const first = await derive(swap);
    expect(first).toMatchObject({ kind: 'ok', agent: { version: '1.0.1' } });
    for (const field of ['madeFor', 'latestAt', 'latestBy', 'owner']) {
      expect(agentOf(first)).not.toHaveProperty(field);
    }
    // Made for its project, and Latest nowhere: not the version it came from's add.
    const read = await stored('1.0.1');
    expect(read?.madeFor).toBe('project');
    expect(read).not.toHaveProperty('latestAt');
    expect(read).not.toHaveProperty('latestBy');
    expect(await derive(swap)).toMatchObject({ kind: 'reused', agent: { version: '1.0.1' } });
  });

  test('a number an unregistered version holds is skipped', async () => {
    const { derive, agents, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await publishAgent('1.0.1');
    agents.markUnregistered('1.0.1');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const outcome = await derive({
      from: '1.0.0',
      swaps: { settings: { 'acme.weights': '1.1.0' } },
    });
    expect(agentOf(outcome)?.version).toBe('1.0.2');
  });

  test('the project comes from the stored version, else from the input', async () => {
    const { derive, settings, publishAgent } = await harness({ recordsProject: false });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const swap = { from: '1.0.0', swaps: { settings: { 'acme.weights': '1.1.0' } } };
    expect(await derive(swap)).toEqual({ kind: 'no-project' });
    expect(await derive({ ...swap, projectId })).toMatchObject({
      kind: 'ok',
      agent: { version: '1.0.1', projectId, madeInProjectId: projectId },
    });
  });

  test("another project is refused (project-mismatch, naming the agent's): agents don't move", async () => {
    const { derive, agents, settings, publishAgent, stored } = await harness({
      recordsProject: false,
    });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    const outcome = await derive({
      from: '1.0.0',
      swaps: { settings: { 'acme.weights': '1.1.0' } },
      projectId: randomUUID() as ProjectId,
    });
    expect(outcome).toEqual({ kind: 'project-mismatch', projectId });
    expect(await stored('1.0.1')).toBeNull();
    expect(agents.written).toEqual([]);
  });
});

describe('POST /v1/agents: a number a derived version took', () => {
  test('is refused (409), naming the next free version', async () => {
    const { agents, blocks, derive, prompt, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');
    const derived = await derive({
      from: '1.0.0',
      swaps: { prompts: { 'acme.intake-prompt': '1.1.0' } },
    });
    expect(agentOf(derived)?.version).toBe('1.0.1');

    // A developer's later publish of 1.0.1 never overwrites the expert's version.
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      agentRegistry: agents,
      blockRegistry: blocks,
    });
    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'acme.intake',
        version: '1.0.1',
        name: 'Intake',
        instructions: 'Sort the request.',
        capabilities: [{ needs: [{ feature: 'tool-use' }] }],
        tools: [],
        retrieval: [],
        guardrails: [],
        projectId,
      }),
    });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { message: string } };
    expect(error).toMatchObject({
      code: 'agent-already-registered',
      details: { version: '1.0.1', nextFreeVersion: '1.0.2' },
    });
    expect(error.message).toContain('publish it as 1.0.2, the next free version');
  });
});

describe('deriveAgentVersion refuses', () => {
  test('an unknown version (not-found) and one published before pins (unpinned)', async () => {
    const { derive, publishAgent } = await harness();
    const swaps = { prompts: { 'acme.intake-prompt': '1.0.0' } };
    expect(await derive({ from: '9.9.9', swaps })).toEqual({ kind: 'not-found' });

    await publishAgent('1.0.0', false);
    expect(await derive({ from: '1.0.0', swaps })).toEqual({ kind: 'unpinned' });
  });

  test('a swap the version cannot take (invalid), naming each', async () => {
    const { derive, prompt, settings, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');
    await prompt('1.2.0', 'Sort it best.');
    await settings('acme.model', '1.1.0', { volume: 11 });
    const outcome = await derive({
      from: '1.0.0',
      swaps: {
        prompts: { 'acme.intake-prompt': '7.0.0' },
        settings: { 'acme.other': '1.0.0', 'acme.model': '1.1.0' },
      },
    });
    expect(outcome).toEqual({
      kind: 'invalid',
      issues: [
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
          message: expect.stringContaining(
            'block "acme.model" version 1.1.0 isn\'t model settings',
          ),
        },
      ],
    });
  });

  test('model settings that name the model the agent names too, naming both', async () => {
    const { derive, settings, publishAgent } = await harness();
    await publishAgent('1.0.0', true, { preferredModel: 'claude-sonnet-5-5' });
    await settings('acme.model', '1.1.0', { model: 'claude-haiku-4-5' });
    await settings('acme.model', '1.2.0', { temperature: 0.7 });
    expect(await derive({ from: '1.0.0', swaps: { settings: { 'acme.model': '1.1.0' } } })).toEqual(
      {
        kind: 'invalid',
        issues: [
          {
            path: '/pins/settings/acme.model',
            message:
              'block "acme.model" version 1.1.0: it sets model, and the agent version sets preferredModel: name the model in one place, the block or the agent version',
          },
        ],
      },
    );
    const temperature = await derive({
      from: '1.0.0',
      swaps: { settings: { 'acme.model': '1.2.0' } },
    });
    expect(temperature.kind).toBe('ok');
  });

  test('an unregistered block version, no swaps, or swaps that change nothing', async () => {
    const { derive, blocks, prompt, publishAgent } = await harness();
    await publishAgent('1.0.0');
    await prompt('1.1.0', 'Sort it well.');
    await blocks.unregister({ tenantId, blockId: 'acme.intake-prompt', version: '1.1.0' });
    const outcome = (swaps: PinSwaps) => derive({ from: '1.0.0', swaps });
    expect(await outcome({ prompts: { 'acme.intake-prompt': '1.1.0' } })).toEqual({
      kind: 'invalid',
      issues: [
        {
          path: '/pins/prompts/acme.intake-prompt',
          message: 'block "acme.intake-prompt" version 1.1.0 is unregistered',
        },
      ],
    });
    expect(await outcome({})).toEqual({
      kind: 'invalid',
      issues: [{ path: '/pins', message: 'name at least one prompt or settings pin to swap' }],
    });
    expect(await outcome({ prompts: { 'acme.intake-prompt': '1.0.0' } })).toEqual({
      kind: 'invalid',
      issues: [{ path: '/pins', message: 'no pin changes' }],
    });
  });
});

describe("deriveAgentVersion: who is made the derived version's owner", () => {
  const derivePrompt = async (userId?: UserId) => {
    const h = await harness();
    await h.publishAgent('1.0.0');
    await h.prompt('1.1.0', 'Sort it well.');
    const outcome = await h.derive(
      { from: '1.0.0', swaps: { prompts: { 'acme.intake-prompt': '1.1.0' } } },
      userId,
    );
    expect(outcome.kind).toBe('ok');
    const owners = h.agents.written.filter((t) => t.relation === 'owner').map((t) => t.user);
    return { derivedFrom: agentOf(outcome)?.derivedFrom, owners };
  };

  test('the person who derives it is made its owner, and recorded as `by`', async () => {
    const { derivedFrom, owners } = await derivePrompt(USER);
    expect(owners).toEqual(['user:user-1']);
    expect(derivedFrom?.by).toBe('user:user-1');
  });

  test('with no person, no one is made its owner, and no `by` is recorded', async () => {
    const { derivedFrom, owners } = await derivePrompt();
    expect(owners).toEqual([]);
    expect(derivedFrom).not.toHaveProperty('by');
  });
});

describe('deriveAgentVersion in a tenant with environment orders', () => {
  // The agent lives in prod (`projectId`), last of the order; its new
  // versions are made in the order's first environment.
  const STAGING_1 = randomUUID() as ProjectId;
  const STAGING_2 = randomUUID() as ProjectId;
  const ORDER = [[STAGING_1, STAGING_2, projectId]] as const;
  const swap = { from: '1.0.0', swaps: { settings: { 'acme.weights': '1.1.0' } } };

  test('naming a later environment is refused (environment-takes-promotions) and nothing is made', async () => {
    const { derive, settings, publishAgent, stored } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    expect(await derive({ ...swap, projectId: STAGING_2 })).toEqual({
      kind: 'environment-takes-promotions',
      later: { firstProjectId: STAGING_1, position: 1 },
    });
    expect(await stored('1.0.1')).toBeNull();
  });

  test("from a version in prod, it's made in the first environment and stays the agent's", async () => {
    const { derive, agents, settings, publishAgent, stored } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    expect(await derive(swap)).toMatchObject({
      kind: 'ok',
      agent: { version: '1.0.1', projectId, madeInProjectId: STAGING_1 },
    });
    const read = await stored('1.0.1');
    expect(read?.projectId).toBe(projectId);
    expect(read?.madeInProjectId).toBe(STAGING_1);
    // Its tuples are written in the project it's made in.
    const parents = agents.written.filter((t) => t.relation === 'parent').map((t) => t.user);
    expect(parents).toEqual([`project:${STAGING_1}`]);
  });

  test('naming the first environment makes it there', async () => {
    const { derive, settings, publishAgent, stored } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    expect((await derive({ ...swap, projectId: STAGING_1 })).kind).toBe('ok');
    expect((await stored('1.0.1'))?.madeInProjectId).toBe(STAGING_1);
  });

  test('the same swap again is the version made in the first environment (reused)', async () => {
    const { derive, settings, publishAgent } = await harness({ orders: ORDER });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    expect((await derive(swap)).kind).toBe('ok');
    expect(await derive(swap)).toMatchObject({
      kind: 'reused',
      agent: { version: '1.0.1', madeInProjectId: STAGING_1 },
    });
  });

  test('an agent in no order is derived in its own project, as before', async () => {
    const { derive, settings, publishAgent, stored } = await harness({
      orders: [[STAGING_1, STAGING_2]],
    });
    await publishAgent('1.0.0');
    await settings('acme.weights', '1.1.0', { recency: 0.5 });
    expect((await derive(swap)).kind).toBe('ok');
    expect((await stored('1.0.1'))?.madeInProjectId).toBe(projectId);
  });
});
