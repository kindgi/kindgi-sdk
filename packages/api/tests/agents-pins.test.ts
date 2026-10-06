// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A published agent version is pinned: `POST /v1/agents` resolves each
 * tool range once, over the tool's active versions, to the exact
 * version every run of that version uses, and `GET` returns the pins
 * and their digest. A range that matches nothing refuses the publish,
 * naming the tool. Pins are the runtime's to set: a body's `pins` is
 * ignored. Without a tool binding, nothing is pinned (as before).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Agent, createAgentRegistry, pinsDigest } from '@kindgi/agents';
import type { ToolManifest } from '@kindgi/tools';
import type { Cursor, ProjectId, Semver, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { BlockRegistryBinding } from '../src/index.js';
import type {
  AgentRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'agents-pins-token';
const auth = { authorization: `Bearer ${TOKEN}` };

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const notUsed = async () => ({
  kind: 'err' as const,
  error: { code: 'bad-input' as const, message: 'not used in this suite' },
});
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};

/** The agent registry, storing what the route hands it. */
function agentBinding(): AgentRegistryBinding & {
  stored: () => readonly Agent[];
  markUnregistered: (version: string, at: string) => void;
} {
  const registry = createAgentRegistry();
  const unregisteredAt = new Map<string, string>();
  return {
    stored: () => registry.list(),
    markUnregistered: (version, at) => unregisteredAt.set(version, at),
    async list() {
      return { data: [] };
    },
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      return got.kind === 'ok' ? got.value : null;
    },
    async getVersion({ agentId, version }) {
      const got = registry.get(agentId, version as unknown as string);
      if (got.kind !== 'ok') return null;
      const at = unregisteredAt.get(version as unknown as string);
      return at === undefined ? got.value : { ...got.value, unregisteredAt: at };
    },
    async headExists() {
      return false;
    },
    async listVersions() {
      return { data: [] };
    },
    async publish({ agent }) {
      const outcome = registry.register(agent);
      return outcome.kind === 'err'
        ? { kind: 'already-registered', agentId: agent.id, version: agent.version }
        : { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister() {
      return { unregistered: false };
    },
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
  };
}

/**
 * A tool registry holding these active versions per tool id. It answers
 * two versions a page, whatever the limit, so the pins read every page.
 */
function toolBinding(versions: Record<string, readonly string[]>): ToolRegistryBinding {
  const unused = async (): Promise<never> => {
    throw new Error('not used in this suite');
  };
  return {
    list: unused,
    get: unused,
    getVersion: unused,
    headExists: unused,
    resolve: unused,
    publish: unused,
    unregister: unused,
    reinstateVersion: unused,
    async listVersions({ toolId, cursor }: Parameters<ToolRegistryBinding['listVersions']>[0]) {
      const all = versions[toolId as unknown as string] ?? [];
      const start = cursor === undefined ? 0 : Number(cursor);
      const data = all
        .slice(start, start + 2)
        .map((version) => ({ id: toolId, version }) as unknown as ToolManifest);
      return start + 2 < all.length
        ? { data, nextCursor: String(start + 2) as unknown as Cursor }
        : { data };
    },
  } as unknown as ToolRegistryBinding;
}

function makeApp(tools?: Record<string, readonly string[]>, blocks?: BlockRegistryBinding) {
  const agents = agentBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    agentRegistry: agents,
    ...(tools !== undefined && { toolRegistry: toolBinding(tools) }),
    ...(blocks !== undefined && { blockRegistry: blocks }),
  });
  return { app, agents };
}

function body(toolRefs: readonly { id: string; version: string }[], extra = {}) {
  return JSON.stringify({
    id: 'acme.intake',
    version: '1.0.0',
    name: 'Intake',
    instructions: 'Sort the request.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: toolRefs,
    retrieval: [],
    guardrails: [],
    projectId: randomUUID(),
    ...extra,
  });
}

async function publish(app: ReturnType<typeof makeApp>['app'], payload: string) {
  return app.request('/v1/agents', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: payload,
  });
}

const PUBLISHED = {
  'acme.lookup': ['2.0.0', '1.2.0', '1.0.0', '1.1.3', '0.9.0'],
  'acme.score': ['0.3.1'],
};

describe('POST /v1/agents pins the version', () => {
  test('each range resolves to the highest version it allows; GET returns the pins and digest', async () => {
    const { app } = makeApp(PUBLISHED);
    const res = await publish(
      app,
      body([
        { id: 'acme.lookup', version: '^1.0.0' },
        { id: 'acme.score', version: '0.3.1' },
      ]),
    );
    expect(res.status).toBe(201);

    const got = await app.request('/v1/agents/acme.intake/versions/1.0.0', { headers: auth });
    expect(got.status).toBe(200);
    const agent = (await got.json()) as { pins: Agent['pins']; pinsDigest: string };
    const pins = {
      tools: { 'acme.lookup': '1.2.0', 'acme.score': '0.3.1' },
      prompts: {},
      settings: {},
    };
    expect(agent.pins).toEqual(pins);
    expect(agent.pinsDigest).toBe(pinsDigest(pins));
  });

  test('a range that matches nothing refuses the publish, naming each tool; nothing is stored', async () => {
    const { app, agents } = makeApp(PUBLISHED);
    const res = await publish(
      app,
      body([
        { id: 'acme.lookup', version: '^3.0.0' },
        { id: 'acme.score', version: '^0.3.0' },
        { id: 'acme.missing', version: '^1.0.0' },
      ]),
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; details: { issues: { path: string; message: string }[] } };
    };
    expect(err.error.code).toBe('validation-failed');
    expect(err.error.details.issues).toEqual([
      {
        path: '/tools/0/version',
        message: expect.stringContaining('tool "acme.lookup" has no published version in "^3.0.0"'),
      },
      {
        path: '/tools/2/version',
        message: 'tool "acme.missing" has no published version; publish the tool first',
      },
    ]);
    expect(agents.stored()).toEqual([]);
  });

  test("a body's own pins are ignored: the runtime sets them", async () => {
    const { app } = makeApp(PUBLISHED);
    const forged = { tools: { 'acme.lookup': '2.0.0' }, prompts: {}, settings: {} };
    const res = await publish(
      app,
      body([{ id: 'acme.lookup', version: '~1.1.0' }], { pins: forged, pinsDigest: 'sha256:00' }),
    );
    expect(res.status).toBe(201);
    const got = await app.request('/v1/agents/acme.intake/versions/1.0.0', { headers: auth });
    const agent = (await got.json()) as { pins: Agent['pins']; pinsDigest: string };
    expect(agent.pins?.tools).toEqual({ 'acme.lookup': '1.1.3' });
    expect(agent.pinsDigest).toBe(pinsDigest(agent.pins as NonNullable<Agent['pins']>));
  });

  test('without a tool binding, nothing is pinned (ranges resolve per run)', async () => {
    const { app, agents } = makeApp();
    const res = await publish(app, body([{ id: 'acme.lookup', version: '^1.0.0' }]));
    expect(res.status).toBe(201);
    const [stored] = agents.stored();
    expect(stored?.version).toBe('1.0.0' as Semver);
    expect(stored?.pins).toBeUndefined();
    const got = await app.request('/v1/agents/acme.intake/versions/1.0.0', { headers: auth });
    expect(await got.json()).not.toHaveProperty('pins');
  });

  test('GET reads an unregistered version too, saying so', async () => {
    const { app, agents } = makeApp(PUBLISHED);
    const res = await publish(app, body([{ id: 'acme.lookup', version: '^1.0.0' }]));
    expect(res.status).toBe(201);
    agents.markUnregistered('1.0.0', '2026-10-05T12:00:00.000Z');
    const got = await app.request('/v1/agents/acme.intake/versions/1.0.0', { headers: auth });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      version: '1.0.0',
      unregisteredAt: '2026-10-05T12:00:00.000Z',
      pins: { tools: { 'acme.lookup': '1.2.0' } },
    });
  });
});

describe('POST /v1/agents pins the data blocks an agent references', () => {
  const projectId = randomUUID() as ProjectId;
  async function withBlocks() {
    const blocks = inMemoryBlocks();
    const put = (block: Parameters<BlockRegistryBinding['publish']>[0]['block']) =>
      blocks.publish({ tenantId, projectId, block });
    await put({
      id: 'acme.intake-prompt',
      version: '1.0.0',
      kind: 'prompt',
      content: { template: 'Sort it.' },
    });
    await put({
      id: 'acme.intake-prompt',
      version: '1.1.0',
      kind: 'prompt',
      content: { template: 'Sort it well.' },
    });
    await put({
      id: 'acme.weights',
      version: '1.0.0',
      kind: 'settings',
      content: { values: { r: 1 } },
    });
    await put({
      id: 'acme.model',
      version: '1.0.0',
      kind: 'settings',
      content: { values: { temperature: 0.2 } },
    });
    await put({
      id: 'acme.loud',
      version: '1.0.0',
      kind: 'settings',
      content: { values: { volume: 11 } },
    });
    return blocks;
  }
  const refs = {
    instructions: { prompt: 'acme.intake-prompt', version: '^1.0.0' },
    settings: [{ id: 'acme.weights', version: '^1.0.0' }],
    modelSettings: { id: 'acme.model', version: '^1.0.0' },
  };

  test('each reference pins the highest version in range, next to the tools', async () => {
    const { app } = makeApp(PUBLISHED, await withBlocks());
    expect((await publish(app, body([{ id: 'acme.score', version: '0.3.1' }], refs))).status).toBe(
      201,
    );
    const got = await app.request('/v1/agents/acme.intake/versions/1.0.0', { headers: auth });
    const agent = (await got.json()) as {
      pins: Agent['pins'];
      instructions: unknown;
      settings: unknown;
    };
    expect(agent.pins).toEqual({
      tools: { 'acme.score': '0.3.1' },
      prompts: { 'acme.intake-prompt': '1.1.0' },
      settings: { 'acme.weights': '1.0.0', 'acme.model': '1.0.0' },
    });
    expect(agent.instructions).toEqual(refs.instructions);
    expect(agent.settings).toEqual(refs.settings);
  });

  test("a missing block, the wrong kind, or model settings that aren't refuse the publish", async () => {
    const { app } = makeApp(PUBLISHED, await withBlocks());
    const res = await publish(
      app,
      body([], {
        instructions: { prompt: 'acme.weights', version: '^1.0.0' },
        settings: [{ id: 'acme.nothing', version: '^1.0.0' }],
        modelSettings: { id: 'acme.loud', version: '^1.0.0' },
      }),
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { message: string; details: { issues: { path: string; message: string }[] } };
    };
    // The headline names what it is, not only tools.
    expect(err.error.message).toBe(
      'Agent "acme.intake" uses tool or data-block versions it can\'t pin (3 issues)',
    );
    expect(err.error.details.issues).toEqual([
      { path: '/instructions/version', message: 'prompt block "acme.weights" is a settings block' },
      {
        path: '/settings/0/version',
        message: 'settings block "acme.nothing" has no published version; publish the block first',
      },
      {
        path: '/modelSettings/version',
        message: expect.stringContaining(
          'model-settings block "acme.loud" version 1.0.0 isn\'t model settings',
        ),
      },
    ]);
  });

  test('a runtime with no block registry refuses an agent that references blocks', async () => {
    const { app } = makeApp(PUBLISHED);
    const res = await publish(app, body([], refs));
    expect(res.status).toBe(400);
  });
});
