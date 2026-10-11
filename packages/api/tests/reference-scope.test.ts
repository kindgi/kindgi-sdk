// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `ReferenceScopeBinding`: what a project's flows, agents, triggers and
 * runs may reference. The helpers, then each route that asks it: a
 * reference the binding doesn't reach is refused with
 * `reference-out-of-scope` (400), naming it, before anything is written;
 * one it reaches goes on; without the binding, nothing is asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Agent } from '@kindgi/agents';
import { loadFlow } from '@kindgi/flow';

import {
  type ReferenceScopeBinding,
  agentReferences,
  createApp,
  flowReferences,
  referencesOutOfScope,
} from '../src/index.js';
import { reservedToolMetadataKeys } from '../src/reference-scope.js';
import { createInMemoryTriggerRegistry } from '../src/testing/index.js';
import { fullAppInput } from './support/full-app.js';

const TOKEN = 'reference-scope-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

/** Reaches everything but ids starting `acme.other`; records each question. */
function scope(asked: Parameters<ReferenceScopeBinding['reachable']>[0][]): ReferenceScopeBinding {
  return {
    async reachable(input) {
      asked.push(input);
      return !input.ref.id.startsWith('acme.other');
    },
  };
}

describe('the helpers', () => {
  const tenantId = randomUUID() as never;
  const projectId = randomUUID() as never;

  test('without a binding, nothing is asked and nothing refused', async () => {
    expect(
      await referencesOutOfScope(undefined, tenantId, projectId, [
        { path: '/a', kind: 'tool', id: 'acme.other-tool' },
      ]),
    ).toBeUndefined();
  });

  test('each reference is asked once; every path naming one out of reach is an issue', async () => {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const refused = await referencesOutOfScope(scope(asked), tenantId, projectId, [
      { path: '/nodes/a', kind: 'tool', id: 'acme.other-tool' },
      { path: '/nodes/b', kind: 'tool', id: 'acme.other-tool' },
      { path: '/nodes/c', kind: 'tool', id: 'acme.own-tool' },
    ]);
    expect(asked.map((a) => a.ref.id)).toEqual(['acme.other-tool', 'acme.own-tool']);
    expect(asked.every((a) => a.fromProjectId === projectId && a.tenantId === tenantId)).toBe(true);
    expect(refused?.code).toBe('reference-out-of-scope');
    expect(refused?.issues.map((i) => i.path)).toEqual(['/nodes/a', '/nodes/b']);
    expect(refused?.issues[0]?.message).toBe(
      `tool "acme.other-tool" isn't registered in this project, its org or the tenant`,
    );
  });

  test('one answer for an item that does not exist and one out of reach', async () => {
    const refusedFor = async (id: string) =>
      (
        await referencesOutOfScope({ reachable: async () => false }, tenantId, projectId, [
          { path: '/tools/0', kind: 'tool', id },
        ])
      )?.message.replace(id, '<id>');
    expect(await refusedFor('acme.never-registered')).toBe(await refusedFor('acme.elsewhere'));
  });

  test('flowReferences: tool and agent nodes, fanout branches, subflows, loop bodies, at their paths', () => {
    const loaded = loadFlow({
      id: 'acme.flow',
      version: '1.0.0',
      nodes: [
        { id: 'score', kind: 'tool', ref: 'acme.score' },
        { id: 'match', kind: 'agent', ref: 'acme.matcher' },
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
        { id: 'e2', from: 'match', to: 'each' },
        { id: 'e3', from: 'each', to: '$end' },
      ],
    });
    if (loaded.kind !== 'ok') throw new Error(loaded.error.message);
    expect(flowReferences(loaded.value)).toEqual([
      { path: 'nodes/score', kind: 'tool', id: 'acme.score' },
      { path: 'nodes/match', kind: 'agent', id: 'acme.matcher' },
      { path: 'nodes/each/body/nodes/lookup', kind: 'tool', id: 'acme.lookup' },
    ]);
  });

  test('agentReferences: its tools, guardrails and data blocks', () => {
    const agent = {
      tools: [{ id: 'acme.lookup', version: '^1' }],
      guardrails: ['acme.no-pii'],
      instructions: { prompt: 'acme.prompt', version: '^1' },
      settings: [],
    } as unknown as Agent;
    const refs = agentReferences(agent);
    expect(refs.filter((r) => r.kind !== 'block')).toEqual([
      { path: '/tools/0', kind: 'tool', id: 'acme.lookup' },
      { path: '/guardrails/0', kind: 'guardrail', id: 'acme.no-pii' },
    ]);
    expect(refs.filter((r) => r.kind === 'block').map((r) => r.id)).toEqual(['acme.prompt']);
  });

  test('reservedToolMetadataKeys: the keys under kindgi.', () => {
    expect(reservedToolMetadataKeys({ 'kindgi.mcp': {}, 'acme.note': 'x', kindgi: 1 })).toEqual([
      'kindgi.mcp',
    ]);
    expect(reservedToolMetadataKeys(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function app(referenceScope?: ReferenceScopeBinding) {
  return createApp({
    ...fullAppInput(),
    resolveToken: async (token) =>
      token === TOKEN ? { tenantId: '00000000-0000-4000-8000-0000000000aa' as never } : null,
    ...(referenceScope !== undefined && { referenceScope }),
  });
}

/** A project of the tenant, so the routes' own project checks pass. */
async function newProject(a: ReturnType<typeof app>): Promise<string> {
  const res = await a.request('/v1/projects', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'Acme', slug: `acme-${randomUUID().slice(0, 8)}` }),
  });
  const body = (await res.json()) as { id?: string };
  if (res.status !== 201 || body.id === undefined) {
    throw new Error(`project: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.id;
}

const agentSpec = (projectId: string, id: string, toolId: string) => ({
  projectId,
  id,
  version: '1.0.0',
  name: id,
  description: 'Looks things up.',
  instructions: 'Look it up.',
  capabilities: [{ needs: [{ feature: 'tool-use' }] }],
  tools: [{ id: toolId, version: '1.0.0' }],
  retrieval: [],
  guardrails: [],
  parameters: [],
  budget: { maxSteps: 3, maxCostUsd: 0.1, maxWallMs: 15_000 },
});

interface RouteCase {
  readonly name: string;
  readonly path: (id: string) => string;
  readonly body: (projectId: string, id: string) => unknown;
  readonly issuePath: string;
  readonly kind: string;
}

const ROUTES: readonly RouteCase[] = [
  {
    name: 'POST /v1/flows: a tool step',
    path: () => '/v1/flows',
    body: (projectId, id) => ({
      id: 'acme.flow',
      version: '1.0.0',
      projectId,
      nodes: [{ id: 'step', kind: 'tool', ref: id }],
      edges: [
        { id: 'in', from: '$start', to: 'step' },
        { id: 'out', from: 'step', to: '$end' },
      ],
    }),
    issuePath: 'nodes/step',
    kind: 'tool',
  },
  {
    name: 'POST /v1/agents: a tool',
    path: () => '/v1/agents',
    body: (projectId, id) => agentSpec(projectId, 'acme.agent', id),
    issuePath: '/tools/0',
    kind: 'tool',
  },
  {
    name: 'POST /v1/runs: an agent, filed under a named project',
    path: () => '/v1/runs',
    body: (projectId, id) => ({ agent: id, projectId, input: { userMessage: 'hello' } }),
    issuePath: '/agent',
    kind: 'agent',
  },
  {
    name: 'POST /v1/schedules: its flow',
    path: () => '/v1/schedules',
    body: (projectId, id) => ({
      flowId: id,
      flowVersion: '1.0.0',
      projectId,
      label: 'nightly',
      config: { cronExpression: '0 2 * * *' },
    }),
    issuePath: '/target',
    kind: 'flow',
  },
  {
    name: 'POST /v1/webhooks: its flow',
    path: () => '/v1/webhooks',
    body: (projectId, id) => ({
      flowId: id,
      flowVersion: '1.0.0',
      projectId,
      hmacSecretName: 'acme-hmac',
    }),
    issuePath: '/flowId',
    kind: 'flow',
  },
  {
    name: 'POST /v1/eval-suites/{suiteId}/runs: its agent',
    path: () => '/v1/eval-suites/acme.suite/runs',
    body: (projectId, id) => ({ projectId, agentRef: { agentId: id, version: '1.0.0' } }),
    issuePath: '/agentRef/agentId',
    kind: 'agent',
  },
  {
    name: 'POST /v1/conversations: its agent',
    path: () => '/v1/conversations',
    body: (projectId, id) => ({ agentId: id, agentVersion: '1.0.0', title: 'Help', projectId }),
    issuePath: '/agentId',
    kind: 'agent',
  },
  {
    name: 'POST /v1/agents/{agentId}/promotions: a project scope',
    path: (id) => `/v1/agents/${id}/promotions`,
    body: (projectId) => ({ version: '1.0.0', scope: { kind: 'project', projectId } }),
    issuePath: '/scope',
    kind: 'agent',
  },
];

describe.each(ROUTES)('$name', (route) => {
  const send = (a: ReturnType<typeof app>, projectId: string, id: string) =>
    a.request(route.path(id), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(route.body(projectId, id)),
    });

  test('an item the project does not reach is refused, naming it, and asked from that project', async () => {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const a = app(scope(asked));
    const projectId = await newProject(a);
    const res = await send(a, projectId, 'acme.other-item');
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: { path: string; kind: string; id: string }[] } };
    };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('reference-out-of-scope');
    expect(body.error.details?.issues).toEqual([
      expect.objectContaining({ path: route.issuePath, kind: route.kind, id: 'acme.other-item' }),
    ]);
    expect(asked.map((a) => a.fromProjectId)).toContain(projectId);
  });

  test('one it reaches goes on, and without the binding nothing is refused for scope', async () => {
    for (const [a, id] of [
      [app(scope([])), 'acme.own-item'],
      [app(), 'acme.other-item'],
    ] as const) {
      const res = await send(a, await newProject(a), id);
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      expect(body.error?.code).not.toBe('reference-out-of-scope');
    }
  });
});

describe('PATCH /v1/schedules/{triggerId}: a new target', () => {
  test("is checked against the schedule's project, as at registration", async () => {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const a = createApp({
      ...fullAppInput(),
      resolveToken: async (token) =>
        token === TOKEN ? { tenantId: '00000000-0000-4000-8000-0000000000aa' as never } : null,
      triggerRegistry: createInMemoryTriggerRegistry(),
      referenceScope: scope(asked),
    });
    const projectId = await newProject(a);
    const created = await a.request('/v1/schedules', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        flowId: 'acme.own-flow',
        flowVersion: '1.0.0',
        projectId,
        config: { cronExpression: '0 2 * * *' },
      }),
    });
    expect(created.status).toBe(201);
    const { triggerId } = (await created.json()) as { triggerId: string };
    const res = await a.request(`/v1/schedules/${triggerId}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ flowId: 'acme.other-flow', flowVersion: '1.0.0' }),
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('reference-out-of-scope');
    expect(asked.at(-1)).toMatchObject({
      fromProjectId: projectId,
      ref: { kind: 'flow', id: 'acme.other-flow' },
    });
  });
});

describe('one answer for an item that does not exist and one out of reach', () => {
  test('the same request gets a byte-identical body, but for its request id', async () => {
    // The deployment's binding knows why it says no; the answer never shows it.
    const elsewhere: ReferenceScopeBinding = { reachable: async () => false };
    const unknown: ReferenceScopeBinding = { reachable: async () => false };
    const bodies: string[] = [];
    for (const binding of [elsewhere, unknown]) {
      const a = app(binding);
      // Each app's own project: the answer names the item, never the project.
      const res = await a.request('/v1/flows', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(ROUTES[0]?.body(await newProject(a), 'acme.some-tool')),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { requestId?: string } };
      bodies.push(JSON.stringify({ ...body, error: { ...body.error, requestId: '<id>' } }));
    }
    expect(bodies[0]).toBe(bodies[1]);
  });
});

describe('POST /v1/tools: the runtime’s own metadata', () => {
  const tool = (projectId: string, metadata: Record<string, unknown>) => ({
    id: 'acme.lookup',
    description: 'Looks things up.',
    version: '1.0.0',
    input: { type: 'object' },
    output: { type: 'object' },
    projectId,
    metadata,
  });

  test('a key under kindgi. is refused, at its path', async () => {
    const a = app();
    const res = await a.request('/v1/tools', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(
        tool(await newProject(a), {
          'kindgi.mcp': { endpointId: 'acme-docs', toolName: 'search' },
        }),
      ),
    });
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: { path: string }[] } };
    };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues?.map((i) => i.path)).toEqual(['/metadata/kindgi.mcp']);
  });

  test('other metadata is the author’s', async () => {
    const a = app();
    const res = await a.request('/v1/tools', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(tool(await newProject(a), { 'acme.note': 'x' })),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { details?: { issues?: { path: string }[] } };
    };
    expect(body.error?.details?.issues?.some((i) => i.path.startsWith('/metadata/'))).not.toBe(
      true,
    );
  });
});
