// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Requests the routes accept and responses they send must validate
 * against the component schemas of the shipped `openapi.json` — most
 * set `additionalProperties: false`, so a property the route handles
 * but the schema omits makes strict clients reject a valid exchange.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  CreateAppInput,
  EvalRunBinding,
  EvalSuiteRegistryBinding,
  FlowRegistryBinding,
  GuardrailRegistryBinding,
  IdentityDirectoryBinding,
  InvokeAgentBindingInput,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
  UserRecord,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const userId = 'user-u-1042' as UserId;
const TOKEN = 'wire-contract-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;

/** `components.schemas` of the shipped document, refs rewritten to `$defs`. */
function runRow(runId: RunId): KernelRunRecord {
  const at = '2026-09-30T00:00:00.000Z' as Timestamp;
  return {
    runId,
    tenantId,
    projectId,
    flowId: 'agent.turn',
    flowVersion: '1.0.0',
    status: 'completed',
    input: {},
    dryRun: false,
    createdAt: at,
    updatedAt: at,
  };
}

describe('StartRunBody — every body POST /v1/runs accepts validates', () => {
  test('an agent run with projectId', async () => {
    const runId = randomUUID() as RunId;
    const invocations: InvokeAgentBindingInput[] = [];
    const stubs = createStubAppBindings();
    const run = {
      ...stubs.kernelBinding.run,
      getRun: async (_t: TenantId, id: RunId) => (id === runId ? runRow(runId) : null),
    } as unknown as RunBinding;
    const runHandler: RunHandlerBinding = {
      invokeAgent: async (input) => {
        invocations.push(input);
        return { kind: 'ok', runId };
      },
      invokeFlow: async () => ({ kind: 'ok', runId }),
      resumeRun: async () => ({ kind: 'ok', runId }),
    };
    const app = createApp({
      ...stubs,
      kernelBinding: { ...stubs.kernelBinding, run },
      resolveToken,
      runHandler,
    });

    const body = { agent: 'acme.support-triage', projectId, input: { text: 'hello' } };
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    expect(invocations[0]?.projectId).toBe(projectId);
    expect(validateAgainst('StartRunBody', body)).toEqual([]);
  });
});

describe('WhoamiResult — the whoami response validates', () => {
  test('with the directory user attached', async () => {
    const user: UserRecord = {
      userId,
      tenantId,
      displayName: 'Support lead',
      primaryEmail: 'lead@acme.example',
      createdAt: '2026-09-01T00:00:00.000Z' as Timestamp,
      metadata: { source: 'scim' },
    };
    const directory: IdentityDirectoryBinding = {
      getUser: async (input) => (input.userId === userId ? user : null),
      listUsers: async () => ({ data: [] }),
      listSessions: async () => ({ data: [] }),
      revokeAllSessions: async (input) => ({ userId: input.userId, revokedCount: 0 }),
    };
    const stubs = createStubAppBindings();
    const app = createApp({
      ...stubs,
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      identityDirectory: directory,
    });

    const res = await app.request('/v1/identity/whoami', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.user).toMatchObject({ userId, displayName: 'Support lead' });
    expect(validateAgainst('WhoamiResult', body)).toEqual([]);
  });
});

/** POST a body as an authenticated caller; returns the status. */
async function post(input: Partial<CreateAppInput>, path: string, body: unknown): Promise<number> {
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...input,
  });
  const res = await app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe('publish / register bodies — every body the route accepts validates', () => {
  test('PublishAgentBody', async () => {
    const body = {
      id: 'acme.drafting',
      version: '1.0.0',
      name: 'Drafting Agent',
      instructions: 'Draft the document from the provided facts.',
      capabilities: [{ needs: [{ feature: 'structured-output' }] }],
      tools: [{ id: 'acme.lookup-order', version: '1.0.0' }],
      retrieval: [{ types: ['prior-draft'], scope: 'same-conversation' }],
      guardrails: ['acme.no-fabricated-quotes'],
      projectId,
    };
    const agentRegistry = {
      publish: async () => ({ kind: 'ok', agentId: body.id, version: body.version }),
    } as unknown as AgentRegistryBinding;
    expect(await post({ agentRegistry }, '/v1/agents', body)).toBe(201);
    expect(validateAgainst('PublishAgentBody', body)).toEqual([]);
  });

  test('PublishFlowBody', async () => {
    const body = {
      id: 'acme.ingest-invoice',
      version: '1.0.0',
      nodes: [{ id: 'extract', kind: 'tool', ref: 'inline' }],
      edges: [
        { id: 'e0', from: '$start', to: 'extract' },
        { id: 'e1', from: 'extract', to: '$end' },
      ],
      projectId,
    };
    const flowRegistry = {
      publish: async () => ({ kind: 'ok', flowId: body.id, version: body.version }),
    } as unknown as FlowRegistryBinding;
    expect(await post({ flowRegistry }, '/v1/flows', body)).toBe(201);
    expect(validateAgainst('PublishFlowBody', body)).toEqual([]);
  });

  test('RegisterToolBody', async () => {
    const body = {
      id: 'acme.lookup-order',
      description: 'Look up an order in the acme order system.',
      version: '1.0.0',
      input: { type: 'object', properties: { orderId: { type: 'string' } } },
      output: { type: 'object', properties: { found: { type: 'boolean' } } },
      projectId,
    };
    const toolRegistry = {
      publish: async () => ({ kind: 'ok', toolId: body.id, version: body.version }),
    } as unknown as ToolRegistryBinding;
    expect(await post({ toolRegistry }, '/v1/tools', body)).toBe(201);
    expect(validateAgainst('RegisterToolBody', body)).toEqual([]);
  });

  test('RegisterGuardrailBody', async () => {
    const body = {
      id: 'acme.no-fabricated-quotes',
      kind: 'zero-llm',
      check: 'must-cite',
      action: { 'on-violation': 'halt' },
      projectId,
    };
    const guardrailRegistry = {
      register: async () => ({ kind: 'ok', guardrailId: body.id }),
    } as unknown as GuardrailRegistryBinding;
    expect(await post({ guardrailRegistry }, '/v1/guardrails', body)).toBe(201);
    expect(validateAgainst('RegisterGuardrailBody', body)).toEqual([]);
  });

  test('PublishEvalSuiteBody', async () => {
    const body = {
      id: 'acme.drafting-accuracy',
      version: '1.0.0',
      kind: 'accuracy',
      spec: {
        cases: [{ input: 'draft a clause', expectedOutput: 'a clause' }],
        grader: { adapterId: 'eval-judge' },
      },
      projectId,
    };
    const evalSuiteRegistry = {
      publish: async () => ({ kind: 'ok', suiteId: body.id, version: body.version }),
    } as unknown as EvalSuiteRegistryBinding;
    expect(await post({ evalSuiteRegistry }, '/v1/eval-suites', body)).toBe(201);
    expect(validateAgainst('PublishEvalSuiteBody', body)).toEqual([]);
  });

  test('StartEvalRunBody', async () => {
    const body = { projectId, agentRef: { agentId: 'acme.drafting', version: '1.0.0' } };
    const evalRunBinding = {
      start: async () => ({ kind: 'ok', runId: randomUUID() }),
    } as unknown as EvalRunBinding;
    expect(
      await post({ evalRunBinding }, '/v1/eval-suites/acme.drafting-accuracy/runs', body),
    ).toBe(201);
    expect(validateAgainst('StartEvalRunBody', body)).toEqual([]);
  });
});
