// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A publish whose registry answers `held-version-gone`: a version the new
 * one holds (an agent version a step names, or a pinned agent or tool
 * version) was removed while it was published, and nothing was written.
 * `POST /v1/flows` and `POST /v1/agents` answer it as reach answers a
 * version the project doesn't run, `400 reference-out-of-scope`: one
 * issue for each version, at every path that names it, else at the item
 * itself (`''`).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  FlowRegistryBinding,
  GoneVersion,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'held-version-gone-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** A registry whose every publish finds `gone` removed, recording each publish. */
function goneRegistry(idField: 'agentId' | 'flowId', gone: readonly GoneVersion[]) {
  const published: string[] = [];
  const publish = async (input: {
    readonly agent?: { readonly id: string; readonly version: string };
    readonly flow?: { readonly id: string; readonly version: string };
  }) => {
    const item = input.agent ?? input.flow;
    if (item === undefined) throw new Error('nothing to publish');
    published.push(`${item.id}@${item.version}`);
    return { kind: 'held-version-gone', [idField]: item.id, version: item.version, gone };
  };
  return { binding: { publish }, published };
}

async function send(
  registry: { readonly agentRegistry: unknown } | { readonly flowRegistry: unknown },
  path: string,
  body: unknown,
) {
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...(registry as {
      readonly agentRegistry?: AgentRegistryBinding;
      readonly flowRegistry?: FlowRegistryBinding;
    }),
  });
  const res = await app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      error?: { code?: string; message?: string; details?: { issues?: unknown[] } };
    },
  };
}

describe('a publish whose registry found a version it holds removed', () => {
  test('POST /v1/flows: 400 reference-out-of-scope, at each step naming the version, else at the flow', async () => {
    const registry = goneRegistry('flowId', [
      { kind: 'agent', id: 'acme.desk', version: '1.1.0' },
      { kind: 'tool', id: 'acme.lookup', version: '1.0.0' },
    ]);
    const res = await send({ flowRegistry: registry.binding }, '/v1/flows', {
      id: 'acme.flow',
      version: '1.0.0',
      projectId: randomUUID(),
      nodes: [
        { id: 'draft', kind: 'agent', ref: 'acme.desk', config: { version: '1.1.0' } },
        {
          id: 'each',
          kind: 'loop',
          loopKind: 'foreach',
          iterateOver: { path: 'runInput.items' },
          maxIterations: 10,
          body: {
            nodes: [{ id: 'again', kind: 'agent', ref: 'acme.desk', config: { version: '1.1.0' } }],
            edges: [
              { id: 'b0', from: '$loop-start', to: 'again' },
              { id: 'b1', from: 'again', to: '$loop-end' },
            ],
          },
          outputSchema: { type: 'object' },
        },
      ],
      edges: [
        { id: 'e0', from: '$start', to: 'draft' },
        { id: 'e1', from: 'draft', to: 'each' },
        { id: 'e2', from: 'each', to: '$end' },
      ],
    });
    const agentGone = 'agent "acme.desk" 1.1.0 was removed while this flow was published';
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('reference-out-of-scope');
    expect(res.body.error?.message).toBe(
      `flow "acme.flow" 1.0.0 wasn't published: agent "acme.desk" 1.1.0, tool "acme.lookup" 1.0.0 were removed while it was published. Try again: a version it names is then refused, and one it pins is pinned afresh`,
    );
    expect(res.body.error?.details?.issues).toEqual([
      { path: '/nodes/draft', kind: 'agent', id: 'acme.desk', message: agentGone },
      { path: '/nodes/each/body/nodes/again', kind: 'agent', id: 'acme.desk', message: agentGone },
      // No step names the tool: the issue is the flow's.
      {
        path: '',
        kind: 'tool',
        id: 'acme.lookup',
        message: 'tool "acme.lookup" 1.0.0 was removed while this flow was published',
      },
    ]);
    expect(registry.published).toEqual(['acme.flow@1.0.0']);
  });

  test('POST /v1/flows: a step naming another version of the agent is no path of the removed one', async () => {
    const registry = goneRegistry('flowId', [{ kind: 'agent', id: 'acme.desk', version: '1.1.0' }]);
    const res = await send({ flowRegistry: registry.binding }, '/v1/flows', {
      id: 'acme.flow',
      version: '1.0.0',
      projectId: randomUUID(),
      nodes: [
        // The flow pins this step's agent, and the pin held 1.1.0.
        { id: 'a', kind: 'agent', ref: 'acme.desk' },
        { id: 'b', kind: 'agent', ref: 'acme.desk', config: { version: '1.0.0' } },
      ],
      edges: [
        { id: 'e0', from: '$start', to: 'a' },
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: '$end' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('reference-out-of-scope');
    expect(res.body.error?.details?.issues).toEqual([
      {
        path: '/nodes/a',
        kind: 'agent',
        id: 'acme.desk',
        message: 'agent "acme.desk" 1.1.0 was removed while this flow was published',
      },
    ]);
    expect(registry.published).toEqual(['acme.flow@1.0.0']);
  });

  test('POST /v1/agents: 400 reference-out-of-scope, at the tool it pins', async () => {
    const registry = goneRegistry('agentId', [
      { kind: 'tool', id: 'acme.lookup', version: '1.2.0' },
    ]);
    const res = await send({ agentRegistry: registry.binding }, '/v1/agents', {
      id: 'acme.desk',
      version: '1.0.0',
      projectId: randomUUID(),
      name: 'Desk',
      instructions: 'Look it up.',
      capabilities: [{ needs: [{ feature: 'tool-use' }] }],
      tools: [{ id: 'acme.lookup', version: '^1.0.0' }],
      retrieval: [],
      guardrails: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('reference-out-of-scope');
    expect(res.body.error?.message).toBe(
      `agent "acme.desk" 1.0.0 wasn't published: tool "acme.lookup" 1.2.0 was removed while it was published. Try again: what it pins is then pinned afresh`,
    );
    expect(res.body.error?.details?.issues).toEqual([
      {
        path: '/tools/0',
        kind: 'tool',
        id: 'acme.lookup',
        message: 'tool "acme.lookup" 1.2.0 was removed while this agent was published',
      },
    ]);
    expect(registry.published).toEqual(['acme.desk@1.0.0']);
  });
});
