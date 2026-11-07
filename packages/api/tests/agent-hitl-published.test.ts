// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent published over the API takes the same `conversationPolicy.hitl`
 * a pack's agent does. `POST /v1/agents` stores it whole, `GET` answers it
 * back as the wire's `Agent` declares it, and the agent spec takes it. The
 * stored agent's tool gates, as a turn reads them, are the ones that were
 * sent; the turn that waits on one runs in the runtime.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AgentRegistry } from '@kindgi/agents';
import { createAgentRegistry, resolveEffectiveHitlPolicy } from '@kindgi/agents';
import { loadSpecRegistry } from '@kindgi/schema';
import { SPECS_SCHEMAS_DIR } from '@kindgi/specs';
import type { AgentId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { AgentRegistryBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';
import { validateAgainst } from './support/openapi-schema.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'hitl-published-token';

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

/** The in-memory registry behind the binding: publish and read; the rest isn't used here. */
function bindingFor(registry: AgentRegistry): AgentRegistryBinding {
  return {
    list: async () => ({ data: [] }),
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      return got.kind === 'ok' ? got.value : null;
    },
    async getVersion({ agentId, version }) {
      const got = registry.get(agentId, version as unknown as string);
      return got.kind === 'ok' ? got.value : null;
    },
    headExists: async ({ agentId }) => registry.getLatest(agentId).kind === 'ok',
    listVersions: async () => ({ data: [] }),
    async publish({ agent }) {
      const outcome = registry.register(agent);
      if (outcome.kind === 'err') {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    unregister: async () => ({ unregistered: false }),
    markLatest: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
    reinstateVersion: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
  };
}

function makeApp() {
  const registry = createAgentRegistry();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    agentRegistry: bindingFor(registry),
  });
  return { app, registry };
}

/** Every key `hitl` has, so each of its parts is on the wire and in the spec. */
const HITL = {
  afterTurns: 3,
  tools: {
    default: 'ask_on_first_use',
    overrides: {
      'acme.lookup-order': 'always_ask',
      'acme.refund': { mode: 'always_ask', requiredRole: 'senior' },
    },
  },
  defaultReviewerRole: 'standard',
  separateApprover: { overrides: { 'acme.refund': true } },
  timeoutMs: 3_600_000,
  onTimeout: 'escalate',
};

/** A `POST /v1/agents` body, without its `projectId`: the agent itself. */
function agentWith(hitl: unknown): Record<string, unknown> {
  return {
    id: 'acme.support',
    version: '1.0.0',
    name: 'Support Agent',
    instructions: 'Look up the order, and refund it when the customer asks.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [
      { id: 'acme.lookup-order', version: '1.0.0' },
      { id: 'acme.refund', version: '1.0.0' },
    ],
    retrieval: [],
    guardrails: [],
    conversationPolicy: { hitl },
  };
}

async function publish(app: ReturnType<typeof makeApp>['app'], agent: Record<string, unknown>) {
  return app.request('/v1/agents', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...agent, projectId: randomUUID() }),
  });
}

async function specTakes(agent: Record<string, unknown>): Promise<boolean> {
  const specs = await loadSpecRegistry(SPECS_SCHEMAS_DIR);
  if (specs.kind === 'err') throw new Error('the specs did not load');
  return (
    specs.value.validate('https://kindgi.com/schemas/v1/agent.schema.json', agent).kind === 'ok'
  );
}

describe('an agent published over the API, with its approval rules (`hitl`)', () => {
  test("GET answers them back as sent, and the answer fits the wire's Agent", async () => {
    const { app } = makeApp();
    expect((await publish(app, agentWith(HITL))).status).toBe(201);

    const got = await app.request('/v1/agents/acme.support', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(got.status).toBe(200);
    const body = (await got.json()) as { conversationPolicy?: unknown };
    expect(body.conversationPolicy).toEqual({ hitl: HITL });
    expect(validateAgainst('Agent', body)).toEqual([]);
  });

  test("the stored agent's tool gates, as a turn reads them, are the ones sent", async () => {
    const { app, registry } = makeApp();
    expect((await publish(app, agentWith(HITL))).status).toBe(201);

    const stored = registry.getLatest('acme.support' as AgentId);
    if (stored.kind === 'err') throw new Error('the agent was not stored');
    const policy = resolveEffectiveHitlPolicy({ tenant: undefined, agent: stored.value });
    expect(policy.tools?.default).toBe('ask_on_first_use');
    expect(policy.tools?.overrides.get('acme.lookup-order')).toEqual({ mode: 'always_ask' });
    expect(policy.tools?.overrides.get('acme.refund')).toEqual({
      mode: 'always_ask',
      requiredRole: 'senior',
    });
    expect(policy.turn).toEqual({ afterTurns: 3 });
    expect(policy.timeoutMs).toBe(3_600_000);
    expect(policy.separateApprover?.overrides.get('acme.refund')).toBe(true);
  });

  test('the agent spec takes them', async () => {
    expect(await specTakes(agentWith(HITL))).toBe(true);
  });

  test('an unknown mode: the publish, the agent spec and the wire refuse it', async () => {
    const wrong = { tools: { overrides: { 'acme.refund': 'sometimes' } } };
    const { app } = makeApp();
    const published = await publish(app, agentWith(wrong));
    expect(published.status).toBe(400);
    expect(((await published.json()) as { error: { code: string } }).error.code).toBe(
      'validation-failed',
    );
    expect(await specTakes(agentWith(wrong))).toBe(false);
    expect(validateAgainst('ConversationPolicy', { hitl: wrong })).not.toEqual([]);
  });
});
