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

import type { Agent, ConversationBinding } from '@kindgi/agents';
import type { Action, Decision, ResourceRef } from '@kindgi/authz';
import { loadFlow } from '@kindgi/flow';

import {
  type AgentRegistryBinding,
  type CreateAppInput,
  type FlowRegistryBinding,
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

/** A test authorizer's answer: everything allowed but `execute` on the agents in `denied`. */
function decide(denied: ReadonlySet<string>, action: Action, resource: ResourceRef): Decision {
  const allowed = !(action === 'execute' && resource.type === 'agent' && denied.has(resource.id));
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
      `tool "acme.other-tool" isn't registered in this project, its org or the workspace`,
    );
    // With no version named, the refusal says nothing about deploying one.
    expect(refused?.message).toBe(
      `This project can't reference 2 of the items named (tool "acme.other-tool", tool "acme.other-tool"): none is registered in this project, its org or the workspace`,
    );
  });

  test('a version is its own reference: asked with its version, once per version, beside the id', async () => {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const reachable: ReferenceScopeBinding = {
      reachable: async (input) => {
        asked.push(input);
        return input.ref.version !== '1.1.0';
      },
    };
    const refused = await referencesOutOfScope(reachable, tenantId, projectId, [
      { path: '/pins/0', kind: 'agent', id: 'acme.agent', version: '1.0.0' },
      { path: '/pins/1', kind: 'agent', id: 'acme.agent', version: '1.1.0' },
      { path: '/pins/2', kind: 'agent', id: 'acme.agent', version: '1.1.0' },
      { path: '/pins/3', kind: 'agent', id: 'acme.agent' },
    ]);
    expect(asked.map((a) => a.ref)).toEqual([
      { kind: 'agent', id: 'acme.agent', version: '1.0.0' },
      { kind: 'agent', id: 'acme.agent', version: '1.1.0' },
      { kind: 'agent', id: 'acme.agent' },
    ]);
    expect(refused?.issues.map((i) => i.path)).toEqual(['/pins/1', '/pins/2']);
    // The refusal names the version: the item may be in reach at another.
    expect(refused?.issues[0]?.message).toBe(
      `agent "acme.agent" 1.1.0 isn't a version this project runs (not registered in this project, its org or the workspace, nor deployed to it)`,
    );
    expect(refused?.message).toBe(
      `This project can't reference 2 of the items named (agent "acme.agent" 1.1.0, agent "acme.agent" 1.1.0): none is registered in this project, its org or the workspace, and no version named is deployed to it`,
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
      { path: '/nodes/score', kind: 'tool', id: 'acme.score' },
      { path: '/nodes/match', kind: 'agent', id: 'acme.matcher' },
      { path: '/nodes/each/body/nodes/lookup', kind: 'tool', id: 'acme.lookup' },
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

/**
 * The full app without authorization, so without sites, which need it: these
 * tests ask about reference scope, and a test that needs an authorizer wires
 * its own.
 */
function fullAppWithoutAuthz(): CreateAppInput {
  const { authz: _authz, sites: _sites, ...input } = fullAppInput();
  return input;
}

function app(referenceScope?: ReferenceScopeBinding) {
  return createApp({
    ...fullAppWithoutAuthz(),
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
    issuePath: '/nodes/step',
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
    name: 'POST /v1/test-sets/{testSetId}/runs: its agent',
    path: () => '/v1/test-sets/acme.testSet/runs',
    body: (projectId, id) => ({ projectId, agentRef: { agentId: id, version: '1.0.0' } }),
    issuePath: '/agentRef/agentId',
    kind: 'agent',
  },
  {
    name: 'POST /v1/test-sets/{testSetId}/runs: its test set',
    path: (id) => `/v1/test-sets/${id}/runs`,
    body: (projectId) => ({ projectId, agentRef: { agentId: 'acme.own-agent', version: '1.0.0' } }),
    issuePath: '/testSetId',
    kind: 'test-set',
  },
  {
    name: 'POST /v1/guardrails: a pack check',
    path: () => '/v1/guardrails',
    body: (projectId, id) => ({
      id: 'acme.guard',
      kind: 'zero-llm',
      check: id,
      action: { 'on-violation': 'halt' },
      projectId,
    }),
    issuePath: '/check',
    kind: 'check',
  },
  {
    name: 'POST /v1/conversations: its agent',
    path: () => '/v1/conversations',
    body: (projectId, id) => ({ agentId: id, agentVersion: '1.0.0', title: 'Help', projectId }),
    issuePath: '/agentId',
    kind: 'agent',
  },
  {
    name: 'POST /v1/agents/{agentId}/pinned/pin: a project scope',
    path: (id) => `/v1/agents/${id}/pinned/pin`,
    body: (projectId) => ({ version: '1.0.0', scope: { kind: 'project', projectId } }),
    issuePath: '/scope',
    kind: 'agent',
  },
  {
    name: 'POST /v1/agents/{agentId}/pinned/pin: a segment scope',
    path: (id) => `/v1/agents/${id}/pinned/pin`,
    body: (projectId) => ({
      version: '1.0.0',
      scope: { kind: 'segment', projectId, path: [{ key: 'company', value: 'acme' }] },
    }),
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

describe('POST /v1/guardrails: a built-in check', () => {
  test("is every project's: the binding is never asked about it", async () => {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const a = app(scope(asked));
    const res = await a.request('/v1/guardrails', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: 'acme.cites',
        kind: 'zero-llm',
        check: 'must-cite',
        action: { 'on-violation': 'halt' },
        projectId: await newProject(a),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('reference-out-of-scope');
    expect(asked).toEqual([]);
  });
});

describe('PATCH /v1/schedules/{triggerId}: a new target', () => {
  test("is checked against the schedule's project, as at registration", async () => {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const a = createApp({
      ...fullAppWithoutAuthz(),
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

describe('a version named at open or registration: refused there when the project does not run it', () => {
  /** Reaches every item at every version but 1.1.0; records each question. */
  function versionScope(
    asked: Parameters<ReferenceScopeBinding['reachable']>[0][],
  ): ReferenceScopeBinding {
    return {
      async reachable(input) {
        asked.push(input);
        return input.ref.version !== '1.1.0';
      },
    };
  }

  interface Answer {
    readonly status: number;
    readonly body: {
      readonly error?: {
        readonly code?: string;
        readonly message?: string;
        readonly details?: { readonly issues?: unknown[] };
      };
      readonly data?: readonly Record<string, unknown>[];
      readonly [field: string]: unknown;
    };
  }

  /** An app whose triggers are kept in memory and whose conversations are recorded as opened. */
  async function harness() {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const opened: Record<string, unknown>[] = [];
    const a = createApp({
      ...fullAppWithoutAuthz(),
      resolveToken: async (token) =>
        token === TOKEN
          ? { tenantId: '00000000-0000-4000-8000-0000000000aa' as never, userId: 'user-1' as never }
          : null,
      triggerRegistry: createInMemoryTriggerRegistry(),
      conversationBinding: {
        openConversation: async (input: Record<string, unknown>) => {
          opened.push(input);
          return {
            kind: 'ok',
            value: {
              ...input,
              id: randomUUID(),
              openedAt: '2026-10-18T00:00:00.000Z',
              turnCount: 0,
            },
          };
        },
      } as unknown as ConversationBinding,
      referenceScope: versionScope(asked),
    });
    const projectId = await newProject(a);
    const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
      const res = await a.request(path, {
        method,
        headers: auth,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Answer['body'] };
    };
    /** The last question asked: from this project, about `ref` (and nothing more). */
    const lastAsked = () => {
      const last = asked.at(-1);
      expect(last?.fromProjectId).toBe(projectId);
      return last?.ref;
    };
    return { projectId, call, lastAsked, opened };
  }

  /** 400 `reference-out-of-scope`, one issue at `path`, each message naming the version. */
  function expectRefused(res: Answer, path: string, kind: string, id: string, version: string) {
    const named = `${kind} "${id}" ${version}`;
    const why = `isn't a version this project runs (not registered in this project, its org or the workspace, nor deployed to it)`;
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('reference-out-of-scope');
    expect(res.body.error?.message).toBe(`This project can't reference ${named}: it ${why}`);
    expect(res.body.error?.details?.issues).toEqual([
      { path, kind, id, message: `${named} ${why}` },
    ]);
  }

  test('POST /v1/conversations: its agent at `agentVersion`, refused at /agentId, and nothing is opened', async () => {
    const h = await harness();
    const open = (agentVersion: string) =>
      h.call('POST', '/v1/conversations', {
        agentId: 'acme.desk',
        agentVersion,
        title: 'Help',
        projectId: h.projectId,
      });
    expectRefused(await open('1.1.0'), '/agentId', 'agent', 'acme.desk', '1.1.0');
    expect(h.lastAsked()).toEqual({ kind: 'agent', id: 'acme.desk', version: '1.1.0' });
    expect(h.opened).toEqual([]);
    expect((await open('1.0.0')).status).toBe(201);
    expect(h.lastAsked()).toEqual({ kind: 'agent', id: 'acme.desk', version: '1.0.0' });
    expect(h.opened.map((c) => c.agentVersion)).toEqual(['1.0.0']);
  });

  test('POST /v1/schedules: a flow at `flowVersion`, refused at /target, and nothing is registered', async () => {
    const h = await harness();
    const register = (flowVersion: string) =>
      h.call('POST', '/v1/schedules', {
        flowId: 'acme.nightly',
        flowVersion,
        projectId: h.projectId,
        config: { cronExpression: '0 2 * * *' },
      });
    expectRefused(await register('1.1.0'), '/target', 'flow', 'acme.nightly', '1.1.0');
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.nightly', version: '1.1.0' });
    expect((await register('1.0.0')).status).toBe(201);
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.nightly', version: '1.0.0' });
    const listed = await h.call('GET', `/v1/schedules?projectId=${h.projectId}`);
    expect(listed.body.data?.map((s) => s.flowVersion)).toEqual(['1.0.0']);
  });

  test('POST /v1/schedules: an agent at `agentVersion`, refused at /target; one that names none is asked about by its id', async () => {
    const h = await harness();
    const register = (agentVersion?: string) =>
      h.call('POST', '/v1/schedules', {
        agentId: 'acme.desk',
        ...(agentVersion !== undefined && { agentVersion }),
        projectId: h.projectId,
        config: { cronExpression: '0 2 * * *', input: { userMessage: 'Morning summary' } },
      });
    expectRefused(await register('1.1.0'), '/target', 'agent', 'acme.desk', '1.1.0');
    expect(h.lastAsked()).toEqual({ kind: 'agent', id: 'acme.desk', version: '1.1.0' });
    expect((await register('1.0.0')).status).toBe(201);
    expect(h.lastAsked()).toEqual({ kind: 'agent', id: 'acme.desk', version: '1.0.0' });
    // No version named: it runs whichever its project runs, so only the id is asked about.
    expect((await register()).status).toBe(201);
    expect(h.lastAsked()).toStrictEqual({ kind: 'agent', id: 'acme.desk' });
  });

  test('PATCH /v1/schedules/{triggerId}: a new target at a version the project does not run is refused, and the schedule keeps its target', async () => {
    const h = await harness();
    const made = await h.call('POST', '/v1/schedules', {
      flowId: 'acme.nightly',
      flowVersion: '1.0.0',
      projectId: h.projectId,
      config: { cronExpression: '0 2 * * *' },
    });
    expect(made.status).toBe(201);
    const path = `/v1/schedules/${made.body.triggerId as string}`;
    const retarget = (flowVersion: string) =>
      h.call('PATCH', path, { flowId: 'acme.nightly', flowVersion });
    expectRefused(await retarget('1.1.0'), '/target', 'flow', 'acme.nightly', '1.1.0');
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.nightly', version: '1.1.0' });
    expect((await h.call('GET', path)).body.flowVersion).toBe('1.0.0');
    const moved = await retarget('1.0.1');
    expect(moved.status).toBe(200);
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.nightly', version: '1.0.1' });
    expect((await h.call('GET', path)).body.flowVersion).toBe('1.0.1');
  });

  test('POST /v1/webhooks: its flow at `flowVersion`, refused at /flowId, and nothing is registered', async () => {
    const h = await harness();
    const register = (flowVersion: string) =>
      h.call('POST', '/v1/webhooks', {
        flowId: 'acme.inbound',
        flowVersion,
        projectId: h.projectId,
        hmacSecretName: 'acme-hmac',
      });
    expectRefused(await register('1.1.0'), '/flowId', 'flow', 'acme.inbound', '1.1.0');
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.inbound', version: '1.1.0' });
    expect((await register('1.0.0')).status).toBe(201);
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.inbound', version: '1.0.0' });
    const listed = await h.call('GET', `/v1/webhooks?projectId=${h.projectId}`);
    expect(listed.body.data?.map((w) => w.flowVersion)).toEqual(['1.0.0']);
  });

  test('PATCH /v1/webhooks/{triggerId}: a `flowVersion` the project does not run is refused at /flowVersion, and the trigger keeps its version', async () => {
    const h = await harness();
    const made = await h.call('POST', '/v1/webhooks', {
      flowId: 'acme.inbound',
      flowVersion: '1.0.0',
      projectId: h.projectId,
      hmacSecretName: 'acme-hmac',
    });
    expect(made.status).toBe(201);
    const path = `/v1/webhooks/${made.body.triggerId as string}`;
    const move = (flowVersion: string) => h.call('PATCH', path, { flowVersion });
    expectRefused(await move('1.1.0'), '/flowVersion', 'flow', 'acme.inbound', '1.1.0');
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.inbound', version: '1.1.0' });
    expect((await h.call('GET', path)).body.flowVersion).toBe('1.0.0');
    const moved = await move('1.0.1');
    expect(moved.status).toBe(200);
    expect(h.lastAsked()).toEqual({ kind: 'flow', id: 'acme.inbound', version: '1.0.1' });
    expect((await h.call('GET', path)).body.flowVersion).toBe('1.0.1');
  });
});

describe('POST /v1/agents/{agentId}/pinned/pin: a tenant scope', () => {
  test("isn't asked: no other project can name the agent anyway", async () => {
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const a = app(scope(asked));
    const res = await a.request('/v1/agents/acme.other-item/pinned/pin', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ version: '1.0.0', scope: { kind: 'tenant' } }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('reference-out-of-scope');
    expect(asked).toEqual([]);
  });
});

describe('POST /v1/conversations: where it is filed', () => {
  /**
   * An app whose agent registry files `acme.desk` under `deskProject` (when
   * given); `denied` agents are refused `execute`; the conversations it
   * opens are recorded.
   */
  function conversations(opts: { deskProject?: () => string; denied?: readonly string[] }) {
    const opened: Record<string, unknown>[] = [];
    const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
    const deny = new Set(opts.denied ?? []);
    const a = createApp({
      ...fullAppWithoutAuthz(),
      resolveToken: async (token) =>
        token === TOKEN
          ? { tenantId: '00000000-0000-4000-8000-0000000000aa' as never, userId: 'user-1' as never }
          : null,
      agentRegistry: {
        getVersion: async ({ agentId }: { agentId: string }) =>
          agentId === 'acme.desk' && opts.deskProject !== undefined
            ? { id: agentId, version: '1.0.0', projectId: opts.deskProject() }
            : null,
      } as unknown as AgentRegistryBinding,
      conversationBinding: {
        openConversation: async (input: Record<string, unknown>) => {
          opened.push(input);
          return {
            kind: 'ok',
            value: {
              ...input,
              id: randomUUID(),
              openedAt: '2026-10-11T00:00:00.000Z',
              turnCount: 0,
            },
          };
        },
      } as unknown as ConversationBinding,
      // The agent's own project reaches it; no other project does.
      referenceScope: {
        async reachable(input) {
          asked.push(input);
          return opts.deskProject !== undefined && input.fromProjectId === opts.deskProject();
        },
      },
      ...(opts.denied !== undefined && {
        authz: {
          fgaApiUrl: 'http://fga.invalid',
          authzCheckBinding: {
            check: async (_p, action, resource) => decide(deny, action, resource),
            checkBatch: async (_p, action, resources) =>
              resources.map((resource) => decide(deny, action, resource)),
          },
        },
      }),
    });
    const open = (body: Record<string, unknown>) =>
      a.request('/v1/conversations', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          agentId: 'acme.desk',
          agentVersion: '1.0.0',
          title: 'Help',
          ...body,
        }),
      });
    return { a, open, opened, asked };
  }

  test("without a projectId, it's filed under its agent's own project, as a run is", async () => {
    let desk = '';
    const h = conversations({ deskProject: () => desk });
    desk = await newProject(h.a);
    const res = await h.open({});
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as { projectId?: string }).projectId).toBe(desk);
    expect(h.opened).toEqual([expect.objectContaining({ projectId: desk })]);
  });

  test("a projectId that isn't the agent's project is refused, naming the agent", async () => {
    let desk = '';
    const h = conversations({ deskProject: () => desk });
    desk = await newProject(h.a);
    const other = await newProject(h.a);
    const res = await h.open({ projectId: other });
    const body = (await res.json()) as {
      error: { code: string; details: { issues: { path: string; id: string }[] } };
    };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('reference-out-of-scope');
    expect(body.error.details.issues).toEqual([
      expect.objectContaining({ path: '/agentId', id: 'acme.desk' }),
    ]);
    expect(h.asked.at(-1)?.fromProjectId).toBe(other);
    expect(h.opened).toEqual([]);
  });

  test("a caller who can't run the agent is refused with the answer an unknown agent gets", async () => {
    const bodies: string[] = [];
    const desk = randomUUID();
    for (const placed of [true, false]) {
      const h = conversations({
        ...(placed && { deskProject: () => desk }),
        denied: ['acme.desk'],
      });
      const res = await h.open({});
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { requestId?: string } };
      bodies.push(JSON.stringify({ ...body, error: { ...body.error, requestId: '<id>' } }));
      expect(h.opened).toEqual([]);
    }
    expect(bodies[0]).toBe(bodies[1]);
  });
});

describe('…/versions/{version}/reinstate: a retired version comes back only with its references in reach', () => {
  /** A registry holding one version retired before the check, naming `acme.other-tool`. */
  function retired(kind: 'agents' | 'flows', projectId: string) {
    const reinstated: string[] = [];
    const record =
      kind === 'agents'
        ? {
            id: 'acme.desk',
            version: '1.0.0',
            projectId,
            instructions: 'Help.',
            tools: [{ id: 'acme.other-tool', version: '1.0.0' }],
            guardrails: [],
            unregisteredAt: '2026-10-01T00:00:00.000Z',
          }
        : {
            id: 'acme.flow',
            version: '1.0.0',
            projectId,
            nodes: [{ id: 'step', kind: 'tool', ref: 'acme.other-tool' }],
            edges: [],
            unregisteredAt: '2026-10-01T00:00:00.000Z',
          };
    const registry = {
      getVersion: async () => record,
      reinstateVersion: async (input: Record<string, unknown>) => {
        reinstated.push(String(input.version));
        return {
          kind: 'ok',
          ...(kind === 'agents' ? { agentId: record.id } : { flowId: record.id }),
          version: record.version,
          wasTombstoned: true,
        };
      },
    };
    return { registry, reinstated, id: record.id };
  }

  for (const kind of ['agents', 'flows'] as const) {
    test(`${kind}: a reference out of its project's reach keeps it retired, naming the reference`, async () => {
      const projectId = randomUUID();
      const { registry, reinstated, id } = retired(kind, projectId);
      const asked: Parameters<ReferenceScopeBinding['reachable']>[0][] = [];
      const a = createApp({
        ...fullAppWithoutAuthz(),
        resolveToken: async (token) =>
          token === TOKEN ? { tenantId: '00000000-0000-4000-8000-0000000000aa' as never } : null,
        ...(kind === 'agents'
          ? { agentRegistry: registry as unknown as AgentRegistryBinding }
          : { flowRegistry: registry as unknown as FlowRegistryBinding }),
        referenceScope: scope(asked),
      });
      const res = await a.request(`/v1/${kind}/${id}/versions/1.0.0/reinstate`, {
        method: 'POST',
        headers: auth,
      });
      const body = (await res.json()) as {
        error: { code: string; details: { issues: { path: string; id: string }[] } };
      };
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('reference-out-of-scope');
      expect(body.error.details.issues).toEqual([
        expect.objectContaining({
          path: kind === 'agents' ? '/tools/0' : '/nodes/step',
          id: 'acme.other-tool',
        }),
      ]);
      expect(asked.map((q) => q.fromProjectId)).toEqual([projectId]);
      expect(reinstated).toEqual([]);

      // With every reference in reach, it comes back.
      const inReach = createApp({
        ...fullAppWithoutAuthz(),
        resolveToken: async (token) =>
          token === TOKEN ? { tenantId: '00000000-0000-4000-8000-0000000000aa' as never } : null,
        ...(kind === 'agents'
          ? { agentRegistry: registry as unknown as AgentRegistryBinding }
          : { flowRegistry: registry as unknown as FlowRegistryBinding }),
        referenceScope: { reachable: async () => true },
      });
      const back = await inReach.request(`/v1/${kind}/${id}/versions/1.0.0/reinstate`, {
        method: 'POST',
        headers: auth,
      });
      expect(back.status).toBe(200);
      expect(reinstated).toEqual(['1.0.0']);
    });
  }
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
