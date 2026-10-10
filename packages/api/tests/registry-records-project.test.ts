// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent, a flow, a tool, a test set and a guardrail say which project
 * they're in when the registry records it: every read of one carries
 * `projectId`, so a client
 * can tell a record of another project opened under this one's address.
 * A registry that doesn't record it (a pack served from disk) leaves the
 * field out, and both shapes fit the published schemas.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Agent } from '@kindgi/agents';
import type { Flow } from '@kindgi/flow';
import type { Guardrail } from '@kindgi/guardrails';
import type { ToolManifest } from '@kindgi/tools';
import type { ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  EvalSuite,
  EvalSuiteRegistryBinding,
  FlowRegistryBinding,
  GuardrailRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'records-project-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const agent = {
  id: 'acme.drafting',
  version: '1.0.0',
  name: 'Drafting Agent',
  instructions: 'Draft the document from the provided facts.',
  capabilities: [],
  tools: [],
  retrieval: [],
  guardrails: [],
} as unknown as Agent;

const tool = {
  id: 'acme.lookup-order',
  description: 'Look up an order in the acme order system.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
} as unknown as ToolManifest;

const flow = {
  id: 'acme.ingest-invoice',
  version: '1.0.0',
  nodes: [{ id: 'extract', kind: 'tool', ref: 'inline' }],
  edges: [
    { id: 'e0', from: '$start', to: 'extract' },
    { id: 'e1', from: 'extract', to: '$end' },
  ],
} as unknown as Flow;

const suite: EvalSuite = {
  id: 'acme.invoice-cases',
  tenantId,
  version: '1.0.0',
  kind: 'accuracy',
  spec: { cases: [] },
};

const guardrail = {
  id: 'acme.no-fabricated-quotes',
  kind: 'zero-llm',
  check: 'must-cite',
  action: { 'on-violation': 'halt' },
} as unknown as Guardrail;

/** Registries that read every record back with `project`, or with none. */
function registries(project: ProjectId | undefined) {
  const at = <T>(record: T) => (project === undefined ? record : { ...record, projectId: project });
  const agentRegistry = {
    list: async () => ({ data: [at(agent)] }),
    get: async () => at(agent),
    getVersion: async () => at(agent),
    headExists: async () => true,
    listVersions: async () => ({ data: [at(agent)] }),
  } as unknown as AgentRegistryBinding;
  const toolRegistry = {
    list: async () => ({ data: [at(tool)] }),
    get: async () => at(tool),
    getVersion: async () => at(tool),
    headExists: async () => true,
    listVersions: async () => ({
      data: [
        at(tool),
        { ...at(tool), version: '0.9.0', unregisteredAt: '2026-10-01T00:00:00.000Z' },
      ],
    }),
  } as unknown as ToolRegistryBinding;
  const guardrailRegistry = {
    list: async () => ({ data: [at(guardrail)] }),
    get: async () => at(guardrail),
  } as unknown as GuardrailRegistryBinding;
  const flowRegistry = {
    list: async () => ({ data: [at(flow)] }),
    get: async () => at(flow),
    getVersion: async () => at(flow),
    headExists: async () => true,
    listVersions: async () => ({ data: [at(flow)] }),
  } as unknown as FlowRegistryBinding;
  const evalSuiteRegistry = {
    list: async () => ({ data: [at(suite)] }),
    get: async () => at(suite),
    getVersion: async () => at(suite),
    headExists: async () => true,
    listVersions: async () => ({ data: [at(suite)] }),
  } as unknown as EvalSuiteRegistryBinding;
  return { agentRegistry, toolRegistry, guardrailRegistry, flowRegistry, evalSuiteRegistry };
}

async function read(project: ProjectId | undefined, path: string) {
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...registries(project),
  });
  const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status, path).toBe(200);
  return (await res.json()) as Record<string, any>;
}

/** Every read of each record: the path, the schema its answer fits, and where the records are. */
const READS = [
  ['/v1/agents/acme.drafting', 'Agent', (b: any) => [b]],
  ['/v1/agents/acme.drafting/versions/1.0.0', 'Agent', (b: any) => [b]],
  ['/v1/agents', 'AgentCollectionPage', (b: any) => b.data],
  ['/v1/agents/acme.drafting/versions', 'AgentCollectionPage', (b: any) => b.data],
  ['/v1/tools/acme.lookup-order', 'Tool', (b: any) => [b]],
  ['/v1/tools/acme.lookup-order/versions/1.0.0', 'Tool', (b: any) => [b]],
  ['/v1/tools', 'ToolCollectionPage', (b: any) => b.data],
  [
    '/v1/tools/acme.lookup-order/versions?includeTombstoned=true',
    'ToolVersionCollectionPage',
    (b: any) => b.data,
  ],
  ['/v1/flows/acme.ingest-invoice', 'Flow', (b: any) => [b]],
  ['/v1/flows/acme.ingest-invoice/versions/1.0.0', 'Flow', (b: any) => [b]],
  ['/v1/flows', 'FlowCollectionPage', (b: any) => b.data],
  ['/v1/flows/acme.ingest-invoice/versions', 'FlowCollectionPage', (b: any) => b.data],
  ['/v1/eval-suites/acme.invoice-cases', 'EvalSuite', (b: any) => [b]],
  ['/v1/eval-suites/acme.invoice-cases/versions/1.0.0', 'EvalSuite', (b: any) => [b]],
  ['/v1/eval-suites', 'EvalSuiteCollectionPage', (b: any) => b.data],
  ['/v1/eval-suites/acme.invoice-cases/versions', 'EvalSuiteCollectionPage', (b: any) => b.data],
  ['/v1/guardrails/acme.no-fabricated-quotes', 'Guardrail', (b: any) => [b]],
  ['/v1/guardrails', 'GuardrailCollectionPage', (b: any) => b.data],
] as const;

describe('a record says which project it is in', () => {
  test.each(READS)('%s', async (path, schema, records) => {
    const body = await read(projectId, path);
    const found = records(body) as Record<string, unknown>[];
    expect(found.length, path).toBeGreaterThan(0);
    for (const r of found) expect(r.projectId, path).toBe(projectId);
    expect(validateAgainst(schema, body)).toEqual([]);
  });
});

describe("a registry that doesn't record the project leaves it out", () => {
  test.each(READS)('%s', async (path, schema, records) => {
    const body = await read(undefined, path);
    for (const r of records(body) as Record<string, unknown>[]) {
      expect(Object.keys(r), path).not.toContain('projectId');
    }
    expect(validateAgainst(schema, body)).toEqual([]);
  });
});
