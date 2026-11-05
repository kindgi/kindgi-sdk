// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Flow } from '@kindgi/flow';
import type { AgentId, FlowId, ProjectId, Semver, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  AgentVersionRecord,
  FlowRegistryBinding,
  FlowVersionRecord,
  PlanLimitsBinding,
  PlanLimitsInput,
  PlanRefused,
  PlanWarning,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * The plan limits on publish and reinstate: each asks `planLimits.admit`
 * with what it adds, after its own checks, and only its write runs inside.
 * A refusal answers `403 plan-limit-reached` and a busy count `503
 * plan-count-busy`, with nothing written; a write that went through
 * carries any `planWarning`. With no binding, nothing changes.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'plan-limits-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
};

type Answer =
  | PlanRefused
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly warning?: PlanWarning }
  | { readonly kind: 'fails' };

/** A plan-limits binding that answers as told, and records what it was asked. */
function planLimits(answer: Answer): {
  readonly binding: PlanLimitsBinding;
  readonly admitted: PlanLimitsInput[];
} {
  const admitted: PlanLimitsInput[] = [];
  return {
    admitted,
    binding: {
      async admit(input, write) {
        admitted.push(input);
        if (answer.kind === 'fails') throw new Error('the count could not be read');
        if (answer.kind !== 'done') return answer;
        const value = await write();
        return {
          kind: 'done',
          value,
          ...(answer.warning !== undefined && { warning: answer.warning }),
        };
      },
      async check() {
        throw new Error('publish never dry-checks');
      },
    },
  };
}

const AGENTS_AT_MOST: PlanRefused = {
  kind: 'refused',
  over: [{ limit: 'agents', adding: 1, numbers: { plan: 10, most: 12, inUse: 12 } }],
  newIds: { flows: [], agents: ['acme.drafting'] },
};

function agentBody(projectId: string): Record<string, unknown> {
  return {
    id: 'acme.drafting',
    version: '1.0.0',
    name: 'Drafting Agent',
    instructions: 'Draft the document from the provided facts.',
    capabilities: [{ needs: [{ feature: 'structured-output' as const }] }],
    tools: [{ id: 'citations.lookup', version: '1.0.0' }],
    retrieval: [{ types: ['prior-draft'], scope: 'same-conversation' as const }],
    guardrails: ['no-fabricated-quotes'],
    projectId,
  };
}

function flowBody(projectId: string): Record<string, unknown> {
  const flow = {
    id: 'ingest.contract-pdf' as FlowId,
    version: '1.0.0',
    nodes: [
      { id: 'extract', kind: 'tool', ref: 'inline' },
      { id: 'store', kind: 'tool', ref: 'inline' },
    ],
    edges: [
      { id: 'e0', from: '$start', to: 'extract' },
      { id: 'e1', from: 'extract', to: 'store' },
      { id: 'e2', from: 'store', to: '$end' },
    ],
  } as unknown as Flow;
  return { ...(flow as unknown as Record<string, unknown>), projectId };
}

/** An agent registry that records its writes; `record` is what `getVersion` finds. */
function agentRegistry(record?: AgentVersionRecord): {
  readonly binding: AgentRegistryBinding;
  readonly writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    binding: {
      list: async () => ({ data: [] }),
      get: async () => null,
      getVersion: async () => record ?? null,
      headExists: async () => false,
      listVersions: async () => ({ data: [] }),
      async publish({ agent }) {
        writes.push(`publish ${agent.id as unknown as string}`);
        return { kind: 'ok', agentId: agent.id, version: agent.version };
      },
      unregister: async () => ({ unregistered: false }),
      async reinstateVersion({ agentId, version }) {
        if (record === undefined) return { kind: 'not-found', agentId, version };
        writes.push(`reinstate ${agentId as unknown as string}`);
        return {
          kind: 'ok',
          agentId,
          version,
          wasTombstoned: record.unregisteredAt !== undefined,
        };
      },
      markLatest: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
    },
  };
}

/** A flow registry that records its writes; `record` is what `getVersion` finds. */
function flowRegistry(record?: FlowVersionRecord): {
  readonly binding: FlowRegistryBinding;
  readonly writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    binding: {
      list: async () => ({ data: [] }),
      get: async () => null,
      getVersion: async () => record ?? null,
      headExists: async () => false,
      listVersions: async () => ({ data: [] }),
      async publish({ flow }) {
        writes.push(`publish ${flow.id as unknown as string}`);
        return { kind: 'ok', flowId: flow.id, version: flow.version };
      },
      unregister: async () => ({ unregistered: false }),
      async reinstateVersion({ flowId, version }) {
        if (record === undefined) return { kind: 'not-found', flowId, version };
        writes.push(`reinstate ${flowId as unknown as string}`);
        return {
          kind: 'ok',
          flowId,
          version,
          wasTombstoned: record.unregisteredAt !== undefined,
        };
      },
    },
  };
}

function makeApp(input: {
  readonly agents?: AgentRegistryBinding;
  readonly flows?: FlowRegistryBinding;
  readonly planLimits?: PlanLimitsBinding;
}) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(input.agents !== undefined && { agentRegistry: input.agents }),
    ...(input.flows !== undefined && { flowRegistry: input.flows }),
    ...(input.planLimits !== undefined && { planLimits: input.planLimits }),
  });
}

function post(body?: unknown): RequestInit & { method: string } {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  };
}

const REFUSED_WORDS =
  "This adds 1 agent to production, and this runtime's license key runs at most 12: its plan's 10, and a margin. 12 run in production now. What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or renew the key on a larger plan.";

describe('POST /v1/agents through the plan limits', () => {
  test('asks admit with the one agent it lands in its project', async () => {
    const projectId = randomUUID();
    const agents = agentRegistry();
    const plan = planLimits({ kind: 'done' });
    const app = makeApp({ agents: agents.binding, planLimits: plan.binding });
    const res = await app.request('/v1/agents', post(agentBody(projectId)));
    expect(res.status).toBe(201);
    expect(plan.admitted).toEqual([
      { tenantId, projectId, adding: { agents: ['acme.drafting'], flows: [] } },
    ]);
    expect(agents.writes).toEqual(['publish acme.drafting']);
    expect(await res.json()).toEqual({ agentId: 'acme.drafting', version: '1.0.0' });
  });

  test('refused: 403 plan-limit-reached with the exact body, and nothing written', async () => {
    const projectId = randomUUID();
    const agents = agentRegistry();
    const plan = planLimits(AGENTS_AT_MOST);
    const app = makeApp({ agents: agents.binding, planLimits: plan.binding });
    const res = await app.request('/v1/agents', post(agentBody(projectId)));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({
      code: 'plan-limit-reached',
      message: REFUSED_WORDS,
      details: {
        projectId,
        limit: 'agents',
        adding: 1,
        plan: 10,
        most: 12,
        inUse: 12,
        over: [{ limit: 'agents', adding: 1, plan: 10, most: 12, inUse: 12 }],
        newIds: { flows: [], agents: ['acme.drafting'] },
      },
      requestId: expect.any(String),
    });
    expect(agents.writes).toEqual([]);
  });

  test('busy: 503 plan-count-busy with Retry-After 5, and nothing written', async () => {
    const agents = agentRegistry();
    const app = makeApp({
      agents: agents.binding,
      planLimits: planLimits({ kind: 'busy' }).binding,
    });
    const res = await app.request('/v1/agents', post(agentBody(randomUUID())));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('plan-count-busy');
    expect(agents.writes).toEqual([]);
  });

  test('a count that fails answers as a store failure, with nothing written', async () => {
    const agents = agentRegistry();
    const app = makeApp({
      agents: agents.binding,
      planLimits: planLimits({ kind: 'fails' }).binding,
    });
    const res = await app.request('/v1/agents', post(agentBody(randomUUID())));
    expect(res.status).toBe(500);
    expect(agents.writes).toEqual([]);
  });

  test('at its plan: the answer carries planWarning', async () => {
    const warning: PlanWarning = { agents: { plan: 10, most: 12, inUse: 10 } };
    const app = makeApp({
      agents: agentRegistry().binding,
      planLimits: planLimits({ kind: 'done', warning }).binding,
    });
    const res = await app.request('/v1/agents', post(agentBody(randomUUID())));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      agentId: 'acme.drafting',
      version: '1.0.0',
      planWarning: warning,
    });
  });

  test('an invalid agent is refused before admit is asked', async () => {
    const plan = planLimits({ kind: 'done' });
    const app = makeApp({ agents: agentRegistry().binding, planLimits: plan.binding });
    const { instructions: _dropped, ...invalid } = agentBody(randomUUID());
    const res = await app.request('/v1/agents', post(invalid));
    expect(res.status).toBe(400);
    expect(plan.admitted).toEqual([]);
  });

  test('no binding: the answer is as without plan limits', async () => {
    const agents = agentRegistry();
    const app = makeApp({ agents: agents.binding });
    const res = await app.request('/v1/agents', post(agentBody(randomUUID())));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ agentId: 'acme.drafting', version: '1.0.0' });
    expect(agents.writes).toEqual(['publish acme.drafting']);
  });
});

describe('POST /v1/flows through the plan limits', () => {
  test('asks admit with the one flow it lands in its project', async () => {
    const projectId = randomUUID();
    const flows = flowRegistry();
    const plan = planLimits({ kind: 'done' });
    const app = makeApp({ flows: flows.binding, planLimits: plan.binding });
    const res = await app.request('/v1/flows', post(flowBody(projectId)));
    expect(res.status).toBe(201);
    expect(plan.admitted).toEqual([
      { tenantId, projectId, adding: { agents: [], flows: ['ingest.contract-pdf'] } },
    ]);
    expect(flows.writes).toEqual(['publish ingest.contract-pdf']);
  });

  test('refused: 403 and nothing written', async () => {
    const flows = flowRegistry();
    const refused: PlanRefused = {
      kind: 'refused',
      over: [{ limit: 'flows', adding: 1, numbers: { plan: 3, most: 4, inUse: 4 } }],
      newIds: { flows: ['ingest.contract-pdf'], agents: [] },
    };
    const app = makeApp({ flows: flows.binding, planLimits: planLimits(refused).binding });
    const res = await app.request('/v1/flows', post(flowBody(randomUUID())));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('plan-limit-reached');
    expect(body.error.message).toBe(
      "This adds 1 flow to production, and this runtime's license key runs at most 4: its plan's 3, and a margin. 4 run in production now. What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or renew the key on a larger plan.",
    );
    expect(flows.writes).toEqual([]);
  });

  test('busy: 503 with Retry-After, and nothing written', async () => {
    const flows = flowRegistry();
    const app = makeApp({ flows: flows.binding, planLimits: planLimits({ kind: 'busy' }).binding });
    const res = await app.request('/v1/flows', post(flowBody(randomUUID())));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(flows.writes).toEqual([]);
  });

  test('at its plan: the answer carries planWarning', async () => {
    const warning: PlanWarning = { flows: { plan: 3, most: 4, inUse: 3 } };
    const app = makeApp({
      flows: flowRegistry().binding,
      planLimits: planLimits({ kind: 'done', warning }).binding,
    });
    const res = await app.request('/v1/flows', post(flowBody(randomUUID())));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      flowId: 'ingest.contract-pdf',
      version: '1.0.0',
      planWarning: warning,
    });
  });
});

describe('reinstate through the plan limits', () => {
  const madeIn = randomUUID() as ProjectId;
  const home = randomUUID() as ProjectId;
  const retiredAgent = {
    ...(agentBody(home) as object),
    id: 'acme.drafting' as AgentId,
    version: '1.0.0' as Semver,
    projectId: home,
    madeInProjectId: madeIn,
    unregisteredAt: '2026-11-01T00:00:00.000Z',
  } as unknown as AgentVersionRecord;

  test('a retired agent version asks admit with the version, in the project it was made in', async () => {
    const agents = agentRegistry(retiredAgent);
    const plan = planLimits({ kind: 'done' });
    const app = makeApp({ agents: agents.binding, planLimits: plan.binding });
    const res = await app.request('/v1/agents/acme.drafting/versions/1.0.0/reinstate', post());
    expect(res.status).toBe(200);
    expect(plan.admitted).toEqual([
      {
        tenantId,
        projectId: madeIn,
        adding: { reinstate: { limit: 'agents', id: 'acme.drafting', version: '1.0.0' } },
      },
    ]);
    expect(agents.writes).toEqual(['reinstate acme.drafting']);
  });

  test('refused: 403 and the version stays retired', async () => {
    const agents = agentRegistry(retiredAgent);
    const app = makeApp({ agents: agents.binding, planLimits: planLimits(AGENTS_AT_MOST).binding });
    const res = await app.request('/v1/agents/acme.drafting/versions/1.0.0/reinstate', post());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('plan-limit-reached');
    expect(body.error.message).toBe(REFUSED_WORDS);
    expect(agents.writes).toEqual([]);
  });

  test('busy: 503 and the version stays retired', async () => {
    const agents = agentRegistry(retiredAgent);
    const app = makeApp({
      agents: agents.binding,
      planLimits: planLimits({ kind: 'busy' }).binding,
    });
    const res = await app.request('/v1/agents/acme.drafting/versions/1.0.0/reinstate', post());
    expect(res.status).toBe(503);
    expect(agents.writes).toEqual([]);
  });

  test('an active version is reinstated without asking: it adds nothing', async () => {
    const { unregisteredAt: _active, ...active } = retiredAgent;
    const agents = agentRegistry(active as AgentVersionRecord);
    const plan = planLimits(AGENTS_AT_MOST);
    const app = makeApp({ agents: agents.binding, planLimits: plan.binding });
    const res = await app.request('/v1/agents/acme.drafting/versions/1.0.0/reinstate', post());
    expect(res.status).toBe(200);
    expect(plan.admitted).toEqual([]);
  });

  test("a version that isn't there answers 404 without asking", async () => {
    const plan = planLimits(AGENTS_AT_MOST);
    const app = makeApp({ agents: agentRegistry().binding, planLimits: plan.binding });
    const res = await app.request('/v1/agents/acme.drafting/versions/1.0.0/reinstate', post());
    expect(res.status).toBe(404);
    expect(plan.admitted).toEqual([]);
  });

  test('a retired flow version asks admit with the version, and a refusal writes nothing', async () => {
    const retiredFlow = {
      ...(flowBody(home) as object),
      projectId: home,
      madeInProjectId: madeIn,
      unregisteredAt: '2026-11-01T00:00:00.000Z',
    } as unknown as FlowVersionRecord;
    const flows = flowRegistry(retiredFlow);
    const refused: PlanRefused = {
      kind: 'refused',
      over: [{ limit: 'flows', adding: 1 }],
      newIds: { flows: ['ingest.contract-pdf'], agents: [] },
    };
    const plan = planLimits(refused);
    const app = makeApp({ flows: flows.binding, planLimits: plan.binding });
    const res = await app.request('/v1/flows/ingest.contract-pdf/versions/1.0.0/reinstate', post());
    expect(res.status).toBe(403);
    expect(plan.admitted).toEqual([
      {
        tenantId,
        projectId: madeIn,
        adding: { reinstate: { limit: 'flows', id: 'ingest.contract-pdf', version: '1.0.0' } },
      },
    ]);
    const body = (await res.json()) as { error: { message: string; details: unknown } };
    expect(body.error.message).toBe(
      "This adds 1 flow to production, past what this runtime's license key allows. Ask whoever runs this Kindgi for a larger plan. What runs keeps running.",
    );
    expect(body.error.details).toEqual({
      projectId: madeIn,
      limit: 'flows',
      adding: 1,
      over: [{ limit: 'flows', adding: 1 }],
      newIds: { flows: ['ingest.contract-pdf'], agents: [] },
    });
    expect(flows.writes).toEqual([]);
  });
});
