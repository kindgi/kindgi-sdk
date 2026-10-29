// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent, tool or test set with every version unregistered (retired)
 * can be found and brought back, as a flow can: the lists take
 * `?includeRetired=true` and show it as its highest version with
 * `unregisteredAt`, and an agent's or test set's versions list answers
 * for it (not 404), with its unregistered versions under
 * `?includeTombstoned=true`. Both are asked for: the defaults are as
 * before. And an eval run says which project it's in.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  EvalRun,
  EvalRunBinding,
  EvalSuiteRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'retired-items-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const at = '2026-10-01T00:00:00.000Z';

const agent = (version: string) => ({
  id: 'acme.retired-agent',
  version,
  name: 'Retired',
  instructions: 'Answer briefly.',
  capabilities: [],
  tools: [],
  retrieval: [],
  guardrails: [],
  unregisteredAt: at,
});
const tool = (version: string) => ({
  id: 'acme.retired-tool',
  version,
  description: 'Look up an order.',
  input: { type: 'object' },
  output: { type: 'object' },
  unregisteredAt: at,
});
const suite = (version: string) => ({
  id: 'acme.retired-cases',
  tenantId,
  version,
  kind: 'accuracy',
  spec: { cases: [] },
  unregisteredAt: at,
});

/** Registries each holding one retired item, recording what each list was asked. */
function harness() {
  const asked: Record<string, Record<string, unknown>[]> = {};
  const record = (name: string, input: Record<string, unknown>) => {
    asked[name] = [...(asked[name] ?? []), input];
  };
  const registry = (
    kind: string,
    idKey: string,
    item: (version: string) => Record<string, unknown>,
  ) => ({
    list: async (input: Record<string, unknown>) => {
      record(`${kind}.list`, input);
      return { data: input.includeRetired === true ? [item('1.1.0')] : [] };
    },
    get: async () => null,
    getVersion: async () => null,
    headExists: async (input: Record<string, unknown>) =>
      input[idKey] === (item('1.0.0').id as string),
    listVersions: async (input: Record<string, unknown>) => {
      record(`${kind}.versions`, input);
      return { data: input.includeTombstoned === true ? [item('1.1.0'), item('1.0.0')] : [] };
    },
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentRegistry: registry('agents', 'agentId', agent) as unknown as AgentRegistryBinding,
    toolRegistry: registry('tools', 'toolId', tool) as unknown as ToolRegistryBinding,
    evalSuiteRegistry: registry('suites', 'suiteId', suite) as unknown as EvalSuiteRegistryBinding,
  });
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { get, asked };
}

const LISTS = [
  ['agents', '/v1/agents', 'acme.retired-agent', 'AgentCollectionPage'],
  ['tools', '/v1/tools', 'acme.retired-tool', 'ToolCollectionPage'],
  ['suites', '/v1/eval-suites', 'acme.retired-cases', 'EvalSuiteCollectionPage'],
] as const;

describe('a retired agent, tool or test set can be found', () => {
  test.each(LISTS)(
    '%s: the list leaves it out by default, and lists it with ?includeRetired=true',
    async (kind, path, id, schema) => {
      const h = harness();
      expect((await h.get(path)).body.data).toEqual([]);
      expect(h.asked[`${kind}.list`]?.[0]?.includeRetired).toBeUndefined();
      await h.get(`${path}?includeRetired=1`);
      expect(h.asked[`${kind}.list`]?.[1]?.includeRetired).toBeUndefined();

      const all = await h.get(`${path}?includeRetired=true`);
      expect(all.status).toBe(200);
      expect(h.asked[`${kind}.list`]?.[2]?.includeRetired).toBe(true);
      expect(all.body.data).toEqual([
        expect.objectContaining({ id, version: '1.1.0', unregisteredAt: at }),
      ]);
      expect(validateAgainst(schema, all.body)).toEqual([]);
    },
  );
});

const VERSIONS = [
  [
    'agents',
    '/v1/agents/acme.retired-agent/versions',
    '/v1/agents/acme.never/versions',
    'agent-not-found',
  ],
  [
    'suites',
    '/v1/eval-suites/acme.retired-cases/versions',
    '/v1/eval-suites/acme.never/versions',
    'eval-suite-not-found',
  ],
] as const;

describe("a retired agent's or test set's versions", () => {
  test.each(VERSIONS)(
    '%s: 200 (not 404), its unregistered versions with ?includeTombstoned=true; a never-registered id is still 404',
    async (kind, path, never, code) => {
      const h = harness();
      const active = await h.get(path);
      expect(active.status).toBe(200);
      expect(active.body.data).toEqual([]);
      expect(h.asked[`${kind}.versions`]?.[0]?.includeTombstoned).toBeUndefined();

      const all = await h.get(`${path}?includeTombstoned=true`);
      expect(all.status).toBe(200);
      expect(h.asked[`${kind}.versions`]?.[1]?.includeTombstoned).toBe(true);
      expect(
        all.body.data.map((v: { version: string; unregisteredAt?: string }) => [
          v.version,
          v.unregisteredAt,
        ]),
      ).toEqual([
        ['1.1.0', at],
        ['1.0.0', at],
      ]);
      expect(
        validateAgainst(
          kind === 'agents' ? 'AgentCollectionPage' : 'EvalSuiteCollectionPage',
          all.body,
        ),
      ).toEqual([]);

      const missing = await h.get(`${never}?includeTombstoned=true`);
      expect([missing.status, missing.body.error.code]).toEqual([404, code]);
    },
  );
});

describe('an eval run says which project it is in', () => {
  const run = (withProject: boolean): EvalRun => ({
    runId: randomUUID() as RunId,
    tenantId,
    ...(withProject && { projectId }),
    suiteId: 'acme.cases',
    suiteVersion: '1.0.0',
    kind: 'accuracy',
    status: 'completed',
    dryRun: false,
    startedAt: at as Timestamp,
  });
  const app = (r: EvalRun) =>
    createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      evalRunBinding: {
        get: async () => r,
        list: async () => ({ data: [r] }),
      } as unknown as EvalRunBinding,
    });

  test.each([
    ['with the project the store records', true],
    ["without one (a runtime that doesn't say)", false],
  ])('%s', async (_, withProject) => {
    const r = run(withProject);
    for (const path of [`/v1/eval-runs/${r.runId}`, '/v1/eval-runs']) {
      const res = await app(r).request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      const read = path === '/v1/eval-runs' ? body.data[0] : body;
      expect(read.projectId, path).toBe(withProject ? projectId : undefined);
      expect(
        validateAgainst(path === '/v1/eval-runs' ? 'EvalRunCollectionPage' : 'EvalRun', body),
        path,
      ).toEqual([]);
    }
  });
});
