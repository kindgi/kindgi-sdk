// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A published flow version is pinned: `POST /v1/flows` pins each tool
 * the flow runs (tool nodes, fanout branches, loop bodies) and each
 * agent it runs at no named version to its latest version, and `GET`
 * returns the pins and their digest. A tool or agent with no published
 * version refuses the publish. An agent node with its own version keeps
 * it. Without the tool and agent registries, nothing is pinned.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Agent } from '@kindgi/agents';
import { type Flow, flowPinsDigest } from '@kindgi/flow';
import type { ToolManifest } from '@kindgi/tools';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  FlowRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'flows-pins-token';
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

const unused = async (): Promise<never> => {
  throw new Error('not used in this suite');
};

function flowBinding(): FlowRegistryBinding & { stored: () => Flow[] } {
  const rows = new Map<string, Flow>();
  return {
    stored: () => [...rows.values()],
    list: unused,
    get: unused,
    headExists: unused,
    listVersions: unused,
    unregister: unused,
    reinstateVersion: unused,
    async getVersion({ version }: Parameters<FlowRegistryBinding['getVersion']>[0]) {
      return rows.get(version as unknown as string) ?? null;
    },
    async publish({ flow }: Parameters<FlowRegistryBinding['publish']>[0]) {
      rows.set(flow.version, flow);
      return { kind: 'ok', flowId: flow.id, version: flow.version };
    },
  } as unknown as FlowRegistryBinding & { stored: () => Flow[] };
}

/** Tools with these active versions, and agents whose latest version is this. */
function registries(tools: Record<string, readonly string[]>, agents: Record<string, string>) {
  const toolRegistry = {
    async listVersions({ toolId }: Parameters<ToolRegistryBinding['listVersions']>[0]) {
      const versions = tools[toolId as unknown as string] ?? [];
      return {
        data: versions.map((version) => ({ id: toolId, version }) as unknown as ToolManifest),
      };
    },
  } as unknown as ToolRegistryBinding;
  const agentRegistry = {
    async get({ agentId }: Parameters<AgentRegistryBinding['get']>[0]) {
      const version = agents[agentId as unknown as string];
      return version === undefined ? null : ({ id: agentId, version } as unknown as Agent);
    },
  } as unknown as AgentRegistryBinding;
  return { toolRegistry, agentRegistry };
}

function makeApp(pinning?: ReturnType<typeof registries>) {
  const flows = flowBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    flowRegistry: flows,
    ...pinning,
  });
  return { app, flows };
}

function body() {
  return JSON.stringify({
    id: 'acme.review',
    version: '2.0.0',
    nodes: [
      { id: 'score', kind: 'tool', ref: 'acme.score' },
      { id: 'match', kind: 'agent', ref: 'acme.matcher' },
      { id: 'audit', kind: 'agent', ref: 'acme.auditor', config: { version: '0.9.0' } },
      {
        id: 'each',
        kind: 'loop',
        loopKind: 'foreach',
        iterateOver: { path: 'runInput.items' },
        maxIterations: 10,
        body: {
          nodes: [{ id: 'lookup', kind: 'tool', ref: 'acme.lookup' }],
          edges: [
            { id: 'b0', from: '$loop-start', to: 'lookup' },
            { id: 'b1', from: 'lookup', to: '$loop-end' },
          ],
        },
        outputSchema: { type: 'object' },
      },
    ],
    edges: [
      { id: 'e0', from: '$start', to: 'score' },
      { id: 'e1', from: 'score', to: 'match' },
      { id: 'e2', from: 'match', to: 'audit' },
      { id: 'e3', from: 'audit', to: 'each' },
      { id: 'e4', from: 'each', to: '$end' },
    ],
    projectId: randomUUID(),
  });
}

async function publish(app: ReturnType<typeof makeApp>['app']) {
  return app.request('/v1/flows', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: body(),
  });
}

describe('POST /v1/flows pins the version', () => {
  test('each tool, and each agent with no version of its own, pins to its latest; GET returns them', async () => {
    const { app } = makeApp(
      registries(
        { 'acme.score': ['1.0.0', '1.1.0'], 'acme.lookup': ['0.2.0'] },
        { 'acme.matcher': '1.4.1', 'acme.auditor': '1.0.0' },
      ),
    );
    const res = await publish(app);
    expect(res.status).toBe(201);
    const got = await app.request('/v1/flows/acme.review/versions/2.0.0', { headers: auth });
    expect(got.status).toBe(200);
    const flow = (await got.json()) as { pins: Flow['pins']; pinsDigest: string };
    const pins = {
      tools: { 'acme.lookup': '0.2.0', 'acme.score': '1.1.0' },
      agents: { 'acme.matcher': '1.4.1' },
    };
    expect(flow.pins).toEqual(pins);
    expect(flow.pinsDigest).toBe(flowPinsDigest(pins));
  });

  test('a tool or agent with no published version refuses the publish, naming each', async () => {
    const { app, flows } = makeApp(registries({ 'acme.score': ['1.0.0'] }, {}));
    const res = await publish(app);
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; details: { issues: { path: string; message: string }[] } };
    };
    expect(err.error.code).toBe('validation-failed');
    expect(err.error.details.issues.map((i) => i.message)).toEqual([
      'tool "acme.lookup" has no published version; publish the tool first',
      'agent "acme.matcher" has no published version; publish the agent first',
    ]);
    expect(flows.stored()).toEqual([]);
  });

  test('without the tool and agent registries, nothing is pinned', async () => {
    const { app, flows } = makeApp();
    const res = await publish(app);
    expect(res.status).toBe(201);
    expect(flows.stored()[0]?.pins).toBeUndefined();
  });
});
