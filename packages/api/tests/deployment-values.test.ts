// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `deploymentValues`: every value a deployment needs where it's promoted
 * to, read where a run there reads it, and why one isn't ready.
 */

import { describe, expect, test } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId } from '@kindgi/types';

import type { CarriedVersion } from '../src/carried-versions.js';
import type { Deployment, DeploymentContents } from '../src/deployment-binding.js';
import { deploymentValues } from '../src/deployment-values.js';
import type { DeploymentValuesDeps, ModelKeyLookup } from '../src/deployment-values.js';

const tenantId = 't-1' as TenantId;
const prod = 'p-prod' as ProjectId;
const orgId = 'o-1' as OrgId;
const envName = 'prod' as EnvName;

/** Where each value is set: `<scope kind>:<env>:<name>`, and the revoked ones. */
type Stored = Record<string, { revokedAt?: string } | undefined>;

const at = (scope: Scope, env: string, name: string) => `${scope.kind}:${env}:${name}`;

const tools: Record<string, object> = {
  'acme.search@1.0.0': {
    id: 'acme.search',
    version: '1.0.0',
    needsSpec: {
      secrets: { ACME_TOKEN: { type: 'string' } },
      env: { ACME_REGION: { type: 'string' }, ACME_TIER: { type: 'string', default: 'basic' } },
    },
  },
  'acme.relay@2.0.0': {
    id: 'acme.relay',
    version: '2.0.0',
    spec: {
      kind: 'http',
      method: 'GET',
      urlTemplate: 'https://relay.acme.example',
      authorization: { kind: 'bearer', secretRef: { envName: 'shared', name: 'RELAY_KEY' } },
    },
  },
  'acme.mailer@1.0.0': {
    id: 'acme.mailer',
    version: '1.0.0',
    needsSpec: {
      secrets: {
        ACME_SMTP_KEY: { type: 'string' },
        ACME_DKIM: { type: ['string', 'null'] },
        ACME_SIGNING: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        ACME_BEARER: { type: ['string', 'null'] },
      },
    },
    spec: {
      kind: 'http',
      method: 'POST',
      urlTemplate: 'https://mail.acme.example',
      authorization: { kind: 'bearer', secretRef: { envName: 'prod', name: 'ACME_BEARER' } },
    },
  },
};

/** Providers registered in the tenant, by id: its key's name, or none (a keyless one). */
function providers(registered: Record<string, string | null>) {
  return {
    resolveForRuntime: async () =>
      Object.entries(registered).map(([id, key]) => ({
        metadata: { id },
        adapterId: id,
        ...(key !== null && { secretRef: { envName: 'prod', name: key } }),
      })),
  };
}

function world(opts: {
  stored?: Stored;
  env?: string[];
  agents?: Record<string, string | undefined>;
  registered?: Record<string, string | null>;
  administers?: Scope['kind'][];
  lookup?: ModelKeyLookup;
  noEnvName?: boolean;
  packEnv?: DeploymentValuesDeps['packEnv'];
}): DeploymentValuesDeps {
  const stored = opts.stored ?? {};
  return {
    ...(opts.noEnvName !== true && { envName }),
    secrets: {
      get: async ({ scope, envName: env, name }) => {
        const key = at(scope, env, name);
        return key in stored ? ({ name, ...stored[key] } as never) : null;
      },
    },
    projects: { get: async () => ({ orgId }) as never },
    ...(opts.administers !== undefined && {
      administers: async (scope: Scope) => opts.administers?.includes(scope.kind) === true,
    }),
    tools: {
      get: async () => null,
      getVersion: async ({ toolId, version }) => (tools[`${toolId}@${version}`] ?? null) as never,
    },
    agents: {
      getVersion: async ({ agentId, version }) => {
        const key = `${agentId}@${version}`;
        if (opts.agents === undefined || !(key in opts.agents)) return null;
        const preferred = opts.agents[key];
        return {
          id: agentId,
          version,
          ...(preferred !== undefined && { preferredProvider: preferred }),
        } as never;
      },
    },
    env: {
      get: async ({ scope, envName: env, name }) =>
        (opts.env ?? []).includes(at(scope, env, name)) ? ({ name, value: 'set' } as never) : null,
    },
    ...(opts.registered !== undefined && { providers: providers(opts.registered) as never }),
    ...(opts.lookup !== undefined && { modelKeyLookup: opts.lookup }),
    ...(opts.packEnv !== undefined && { packEnv: opts.packEnv }),
  };
}

function deployment(contents: Partial<DeploymentContents>): Deployment {
  return {
    deploymentId: 'd-1',
    tenantId,
    contents: { tools: [], guardrails: [], agents: [], flows: [], ...contents },
  } as unknown as Deployment;
}

const values = (deps: DeploymentValuesDeps, d: Deployment, carried: CarriedVersion[] = []) =>
  deploymentValues(deps, { deployment: d, carried, projectId: prod });

const search = { type: 'tool', id: 'acme.search', version: '1.0.0' } as const;
const relay = { type: 'tool', id: 'acme.relay', version: '2.0.0' } as const;
const both = deployment({
  tools: [
    { id: 'acme.search', version: '1.0.0' },
    { id: 'acme.relay', version: '2.0.0' },
  ],
});

describe('a tool version: its secrets and the env it has no default for', () => {
  test('each read where it is recorded, or missing; a secretRef in its own env', async () => {
    const deps = world({
      stored: { 'org:prod:ACME_TOKEN': {}, 'project:shared:RELAY_KEY': {} },
      env: ['tenant:prod:ACME_REGION'],
    });
    expect(await values(deps, both)).toEqual([
      { name: 'ACME_TOKEN', kind: 'secret', neededBy: search, foundAt: 'org' },
      { name: 'ACME_REGION', kind: 'env', neededBy: search, foundAt: 'tenant' },
      { name: 'RELAY_KEY', kind: 'secret', neededBy: relay, foundAt: 'project' },
    ]);
    expect(await values(world({}), both)).toEqual([
      { name: 'ACME_TOKEN', kind: 'secret', neededBy: search, problem: 'missing' },
      { name: 'ACME_REGION', kind: 'env', neededBy: search, problem: 'missing' },
      { name: 'RELAY_KEY', kind: 'secret', neededBy: relay, problem: 'missing' },
    ]);
  });

  test("a secret only at a scope the person promoting doesn't administer is missing: a run reads where it's recorded", async () => {
    const deps = world({ stored: { 'tenant:prod:ACME_TOKEN': {} }, administers: ['project'] });
    const [token] = await values(
      deps,
      deployment({ tools: [{ id: 'acme.search', version: '1.0.0' }] }),
    );
    expect(token).toEqual({
      name: 'ACME_TOKEN',
      kind: 'secret',
      neededBy: search,
      problem: 'missing',
    });
  });

  test('a revoked secret where it is recorded is revoked', async () => {
    const deps = world({
      stored: { 'project:prod:ACME_TOKEN': { revokedAt: '2026-01-01T00:00:00Z' } },
      env: ['project:prod:ACME_REGION'],
    });
    expect(
      await values(deps, deployment({ tools: [{ id: 'acme.search', version: '1.0.0' }] })),
    ).toEqual([
      {
        name: 'ACME_TOKEN',
        kind: 'secret',
        neededBy: search,
        foundAt: 'project',
        problem: 'revoked',
      },
      { name: 'ACME_REGION', kind: 'env', neededBy: search, foundAt: 'project' },
    ]);
  });

  test('an optional secret (its schema accepts null): set nowhere, not listed; set, listed; revoked, a problem. A secretRef stays required', async () => {
    const mailer = { type: 'tool', id: 'acme.mailer', version: '1.0.0' } as const;
    const d = deployment({ tools: [{ id: 'acme.mailer', version: '1.0.0' }] });
    expect(await values(world({}), d)).toEqual([
      { name: 'ACME_BEARER', kind: 'secret', neededBy: mailer, problem: 'missing' },
      { name: 'ACME_SMTP_KEY', kind: 'secret', neededBy: mailer, problem: 'missing' },
    ]);
    const deps = world({
      stored: {
        'project:prod:ACME_DKIM': {},
        'tenant:prod:ACME_SIGNING': { revokedAt: '2026-01-01T00:00:00Z' },
      },
    });
    expect(await values(deps, d)).toEqual([
      { name: 'ACME_BEARER', kind: 'secret', neededBy: mailer, problem: 'missing' },
      { name: 'ACME_SMTP_KEY', kind: 'secret', neededBy: mailer, problem: 'missing' },
      { name: 'ACME_DKIM', kind: 'secret', neededBy: mailer, foundAt: 'project' },
      {
        name: 'ACME_SIGNING',
        kind: 'secret',
        neededBy: mailer,
        foundAt: 'tenant',
        problem: 'revoked',
      },
    ]);
  });

  test("without the runtime's env, each is listed unread; a secretRef's own env still is read", async () => {
    const deps = world({ noEnvName: true, stored: { 'tenant:shared:RELAY_KEY': {} } });
    expect(await values(deps, both)).toEqual([
      { name: 'ACME_TOKEN', kind: 'secret', neededBy: search },
      { name: 'ACME_REGION', kind: 'env', neededBy: search },
      { name: 'RELAY_KEY', kind: 'secret', neededBy: relay, foundAt: 'tenant' },
    ]);
  });

  test('a tool listed twice is checked once; one the registry no longer has, not at all', async () => {
    const deps = world({
      stored: { 'project:prod:ACME_TOKEN': {} },
      env: ['project:prod:ACME_REGION'],
    });
    const twice = deployment({
      tools: [
        { id: 'acme.search', version: '1.0.0' },
        { id: 'acme.search', version: '1.0.0' },
        { id: 'acme.gone', version: '1.0.0' },
      ],
    });
    expect(await values(deps, twice)).toHaveLength(2);
  });
});

describe('model keys: by provider, for every agent version shipped or carried', () => {
  const ships = deployment({ agents: [{ id: 'acme.matcher', version: '1.0.0' }] });
  const anthropic = { type: 'provider', id: 'anthropic' } as const;
  const openai = { type: 'provider', id: 'openai' } as const;

  test("an agent's registered preferred provider: that provider's key, at the tenant without a lookup", async () => {
    const deps = world({
      agents: { 'acme.matcher@1.0.0': 'anthropic' },
      registered: { anthropic: 'ANTHROPIC_KEY', openai: 'OPENAI_KEY' },
      stored: { 'tenant:prod:ANTHROPIC_KEY': {} },
    });
    expect(await values(deps, ships)).toEqual([
      { name: 'ANTHROPIC_KEY', kind: 'model-key', neededBy: anthropic, foundAt: 'tenant' },
    ]);
  });

  test('read where the lookup says a run in the project reads it; revoked there is revoked', async () => {
    const asked: string[] = [];
    const lookup: ModelKeyLookup = async (entry, where) => {
      asked.push(`${entry.metadata.id} in ${where.projectId}`);
      return {
        scope: { kind: 'project', tenantId, projectId: prod },
        envName: 'prod',
        name: 'ANTHROPIC_KEY',
        revokedAt: '2026-01-01T00:00:00Z',
      };
    };
    const deps = world({
      agents: { 'acme.matcher@1.0.0': 'anthropic' },
      registered: { anthropic: 'ANTHROPIC_KEY' },
      stored: { 'project:prod:ANTHROPIC_KEY': {} },
      lookup,
    });
    expect(await values(deps, ships)).toEqual([
      {
        name: 'ANTHROPIC_KEY',
        kind: 'model-key',
        neededBy: anthropic,
        foundAt: 'project',
        problem: 'revoked',
      },
    ]);
    expect(asked).toEqual([`anthropic in ${prod}`]);
  });

  test('no preference, or an unregistered one: any provider with its key will do', async () => {
    const ready = world({
      agents: { 'acme.matcher@1.0.0': 'mistral' },
      registered: { anthropic: 'ANTHROPIC_KEY', openai: 'OPENAI_KEY' },
      stored: { 'tenant:prod:OPENAI_KEY': {} },
    });
    expect(await values(ready, ships)).toEqual([]);
    // None ready: each registered provider's key, any one of which would do.
    const none = world({
      agents: { 'acme.matcher@1.0.0': undefined },
      registered: { openai: 'OPENAI_KEY', anthropic: 'ANTHROPIC_KEY' },
    });
    expect(await values(none, ships)).toEqual([
      { name: 'ANTHROPIC_KEY', kind: 'model-key', neededBy: anthropic, problem: 'missing' },
      { name: 'OPENAI_KEY', kind: 'model-key', neededBy: openai, problem: 'missing' },
    ]);
    // A provider that needs no key is ready.
    const keyless = world({
      agents: { 'acme.matcher@1.0.0': undefined },
      registered: { local: null, openai: 'OPENAI_KEY' },
    });
    expect(await values(keyless, ships)).toEqual([]);
  });

  test("a carried version's provider is checked too, once per provider", async () => {
    const deps = world({
      agents: { 'acme.matcher@1.0.0': 'anthropic', 'acme.matcher@1.0.1': 'openai' },
      registered: { anthropic: 'ANTHROPIC_KEY', openai: 'OPENAI_KEY' },
      stored: { 'tenant:prod:ANTHROPIC_KEY': {} },
    });
    const carried: CarriedVersion[] = [
      { kind: 'agent', id: 'acme.matcher', version: '1.0.1' },
      { kind: 'agent', id: 'acme.matcher', version: '1.0.1' },
      { kind: 'flow', id: 'acme.flow', version: '1.0.1' },
    ];
    expect(await values(deps, ships, carried)).toEqual([
      { name: 'ANTHROPIC_KEY', kind: 'model-key', neededBy: anthropic, foundAt: 'tenant' },
      { name: 'OPENAI_KEY', kind: 'model-key', neededBy: openai, problem: 'missing' },
    ]);
  });

  test('with no provider registered, each agent version that runs on any provider has none to call', async () => {
    // 1.0.0 names none; the carried 1.0.1 names one that isn't registered.
    const deps = world({
      agents: { 'acme.matcher@1.0.0': undefined, 'acme.matcher@1.0.1': 'anthropic' },
      registered: {},
    });
    const carried: CarriedVersion[] = [{ kind: 'agent', id: 'acme.matcher', version: '1.0.1' }];
    expect(await values(deps, ships, carried)).toEqual([
      {
        name: 'any provider',
        kind: 'model-key',
        neededBy: { type: 'agent', id: 'acme.matcher', version: '1.0.0' },
        problem: 'no-provider',
      },
      {
        name: 'any provider',
        kind: 'model-key',
        neededBy: { type: 'agent', id: 'acme.matcher', version: '1.0.1' },
        problem: 'no-provider',
      },
    ]);
    // With one registered, its key is what's needed.
    const one = world({
      agents: { 'acme.matcher@1.0.0': undefined },
      registered: { openai: 'OPENAI_KEY' },
    });
    expect(await values(one, ships)).toEqual([
      { name: 'OPENAI_KEY', kind: 'model-key', neededBy: openai, problem: 'missing' },
    ]);
  });

  test('without the providers, no model key is checked', async () => {
    expect(await values(world({ agents: { 'acme.matcher@1.0.0': 'anthropic' } }), ships)).toEqual(
      [],
    );
  });
});

describe("the pack's env, after the tools and the model keys", () => {
  test('asked in the runtime env for the project, and not without the env', async () => {
    const asked: string[] = [];
    const packEnv: DeploymentValuesDeps['packEnv'] = async (i) => {
      asked.push(`${i.projectId} ${i.envName} ${i.deployment.deploymentId}`);
      return [
        {
          name: 'ACME_FEED_URL',
          kind: 'pack-env',
          neededBy: { type: 'pack', id: 'acme' },
          problem: 'ambiguous',
        },
      ];
    };
    const d = deployment({
      tools: [{ id: 'acme.relay', version: '2.0.0' }],
      agents: [{ id: 'acme.matcher', version: '1.0.0' }],
    });
    const deps = world({
      agents: { 'acme.matcher@1.0.0': 'anthropic' },
      registered: { anthropic: 'ANTHROPIC_KEY' },
      stored: { 'tenant:prod:ANTHROPIC_KEY': {}, 'tenant:shared:RELAY_KEY': {} },
      packEnv,
    });
    expect((await values(deps, d)).map((v) => v.kind)).toEqual(['secret', 'model-key', 'pack-env']);
    expect(asked).toEqual([`${prod} prod d-1`]);
    const { envName: _served, ...unserved } = deps;
    await values(unserved, d);
    expect(asked).toHaveLength(1);
  });
});
