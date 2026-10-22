// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A runtime that refuses other envs (`createApp({ envName, refuseOtherEnvs:
 * true })`) keeps every value under the env it serves:
 *
 * - a secret or env value written under another env: `409 env-not-served`,
 *   naming the served env, and nothing is stored;
 * - a provider, MCP endpoint or webhook endpoint naming its secret under
 *   another env: the same 409, and nothing is registered;
 * - except a secret that a registration already names under that env, at the
 *   scope it reads it at, which is still written, so a value in use can be
 *   rotated;
 * - the tenant config keeps its values (`env`, `secret`) under the env the
 *   runtime serves, where its tools read, with or without the switch, and
 *   its settings (`config`) under `default`, where they always were (all of
 *   them under `default` on a runtime that serves none);
 * - reads and deletes under any env pass;
 * - whoami says what's served (`servedEnv`).
 *
 * Without the switch, every env is taken as before. (The deployment's
 * secret sync: `deployments-routes.test.ts`.)
 */

import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { EnvName, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  EnvBinding,
  EnvRecord,
  RunHandlerBinding,
  SecretBinding,
  SecretRecord,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID();
const TOKEN = 'served-env-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN
    ? { tenantId, capabilities: ['secrets:write', 'secrets:rotate', 'secrets:revoke', 'env:write'] }
    : null;
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

const PROVIDER_KEY = 'ANTHROPIC_API_KEY';
const HOOK_SECRET = 'HOOK_SECRET';
const MCP_TOKEN = 'DOCS_MCP_TOKEN';
/** An MCP endpoint's secret recorded at the project. */
const MCP_PROJECT_TOKEN = 'WIKI_MCP_TOKEN';
/** An MCP endpoint's secret recorded at no scope: read nowhere. */
const MCP_UNREAD_TOKEN = 'TICKETS_MCP_TOKEN';
const REFUSAL = (rest: string) => `This runtime keeps its values under \`prod\` only, so ${rest}`;

const metadata = {
  id: 'openai-main',
  region: 'us-east-1',
  models: [
    {
      name: 'gpt-x',
      contextWindow: 128_000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.01, completionUsdPer1kTokens: 0.03 },
    },
  ],
};
const mcpEndpoint = (
  envName: string,
  name = 'DOCS_TOKEN',
  secretScopes?: Record<string, object | null>,
) => ({
  endpointId: 'acme-docs',
  name: 'Docs MCP',
  transport: 'streamable-http',
  config: { transport: 'streamable-http', url: 'https://docs.acme.example/mcp' },
  auth: { scheme: 'basic', username: 'agent', secretRef: { envName, name } },
  ...(secretScopes !== undefined && { secretScopes }),
});
const hookEndpoint = (envName: string) => ({
  endpointId: 'whe-1',
  url: 'https://app.acme.example/hooks',
  events: ['run.finished'],
  filter: {},
  description: null,
  secretRef: { envName, name: HOOK_SECRET },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

/** What a write reached: each store or registry call, by name. */
type Write = readonly [op: string, envName: string, name: string];

/** `stored`: env values already stored, as before an upgrade. */
function makeApp(
  served: { envName?: string; refuseOtherEnvs?: boolean } = {},
  stored: readonly EnvRecord[] = [],
) {
  const writes: Write[] = [];
  const secrets = new Map<string, SecretRecord>();
  const secretValues = new Map<string, string>();
  const values = new Map<string, EnvRecord>();
  const key = (scope: Scope, envName: string, name: string) =>
    `${scope.kind}:${scope.kind === 'project' ? scope.projectId : ''}::${envName}::${name}`;
  for (const r of stored) values.set(key(r.scope, r.envName, r.name), r);
  const secretsBinding = {
    async list(input) {
      return {
        data: [...secrets.values()].filter(
          (r) => r.envName === input.envName && r.scope.kind === input.scope.kind,
        ),
      };
    },
    async get(input) {
      return secrets.get(key(input.scope, input.envName, input.name)) ?? null;
    },
    async set(input) {
      writes.push(['secret.set', input.envName, input.name]);
      const record: SecretRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        currentVersion: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      };
      secrets.set(key(input.scope, input.envName, input.name), record);
      secretValues.set(key(input.scope, input.envName, input.name), input.value);
      return { kind: 'ok', record, versionId: 1 };
    },
    // The read a tool makes: exact, at the scope and env asked for.
    async resolve(input) {
      const value = secretValues.get(key(input.scope, input.envName, input.name));
      return value === undefined
        ? { kind: 'err', error: { code: 'secret-not-found', message: input.name } }
        : { kind: 'ok', value: { name: input.name, versionId: 1, value, scope: input.scope } };
    },
    async rotate(input) {
      writes.push(['secret.rotate', input.envName, input.name]);
      return { kind: 'ok', value: { kind: 'ok', newVersionId: 2, oldVersionId: 1 } };
    },
    async revoke(input) {
      writes.push(['secret.revoke', input.envName, input.name]);
      return { kind: 'ok', value: { revoked: true, hard: input.hard === true } };
    },
  } as Partial<SecretBinding> as SecretBinding;
  const envBinding = {
    async list(input) {
      return { data: [...values.values()].filter((r) => r.envName === input.envName) };
    },
    async get(input) {
      return values.get(key(input.scope, input.envName, input.name)) ?? null;
    },
    async set(input) {
      writes.push(['env.set', input.envName, input.name]);
      const record: EnvRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        value: input.value,
        revision: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      };
      values.set(key(input.scope, input.envName, input.name), record);
      return { kind: 'ok', record };
    },
    async delete(input) {
      writes.push(['env.delete', input.envName, input.name]);
      return { deleted: values.delete(key(input.scope, input.envName, input.name)) };
    },
  } as Partial<EnvBinding> as EnvBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(served.envName !== undefined && { envName: served.envName as EnvName }),
    ...(served.refuseOtherEnvs !== undefined && { refuseOtherEnvs: served.refuseOtherEnvs }),
    secretsBinding,
    envBinding,
    // Registered before the switch: each names its secret under `local`.
    providerRegistry: {
      resolveForRuntime: async () => [
        {
          metadata: { id: 'anthropic-main' },
          adapterId: '@kindgi/adapter-model-anthropic',
          secretRef: { envName: 'local', name: PROVIDER_KEY },
        },
      ],
      register: async (input: {
        metadata: { id: string };
        secretRef: { envName: string; name: string };
      }) => {
        writes.push(['provider.register', input.secretRef.envName, input.secretRef.name]);
        return { kind: 'ok', providerId: input.metadata.id };
      },
      list: async () => ({ data: [] }),
      get: async () => null,
    } as never,
    mcpEndpointRegistry: {
      // One with no scope recorded (read at the tenant's), one recorded at
      // the project, one recorded at none.
      list: async () => ({
        data: [
          mcpEndpoint('local', MCP_TOKEN),
          mcpEndpoint('local', MCP_PROJECT_TOKEN, {
            [MCP_PROJECT_TOKEN]: { kind: 'project', projectId },
          }),
          mcpEndpoint('local', MCP_UNREAD_TOKEN, { [MCP_UNREAD_TOKEN]: null }),
        ],
      }),
      get: async () => null,
      register: async ({ endpoint }: { endpoint: ReturnType<typeof mcpEndpoint> }) => {
        writes.push([
          'mcp.register',
          endpoint.auth.secretRef.envName,
          endpoint.auth.secretRef.name,
        ]);
        return { kind: 'ok', endpointId: endpoint.endpointId };
      },
    } as never,
    webhookEndpoints: {
      list: async () => ({ data: [hookEndpoint('local')] }),
      get: async () => hookEndpoint('local'),
      create: async (input: { secretRef: { envName: string; name: string } }) => {
        writes.push(['webhook.create', input.secretRef.envName, input.secretRef.name]);
        return { kind: 'ok', endpoint: hookEndpoint(input.secretRef.envName) };
      },
      update: async (input: { secretRef?: { envName: string; name: string } }) => {
        writes.push([
          'webhook.update',
          input.secretRef?.envName ?? '',
          input.secretRef?.name ?? '',
        ]);
        return { kind: 'ok', endpoint: hookEndpoint(input.secretRef?.envName ?? 'local') };
      },
    } as never,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, writes, secretsBinding, envBinding };
}

const tenant = { kind: 'tenant', tenantId };
const project = { kind: 'project', tenantId, projectId };
const secret = (envName: string, name: string, scope: object = tenant) => ({
  scope,
  envName,
  name,
  value: 'sk_test_x',
  writeMode: 'create-new',
});

const refusing = () => makeApp({ envName: 'prod', refuseOtherEnvs: true });

describe('a runtime that refuses other envs: a value under another env', () => {
  test('a secret set or rotated, or an env value put: 409 env-not-served, and nothing is stored', async () => {
    const h = refusing();
    const set = await h.call('POST', '/v1/secrets', secret('staging', 'stripe.key'));
    expect([set.status, set.body.error]).toEqual([
      409,
      expect.objectContaining({
        code: 'env-not-served',
        message: REFUSAL(
          'the secret `stripe.key` under `staging` would never be read. Store it under `prod`',
        ),
        details: { envName: 'staging', servedEnv: 'prod' },
      }),
    ]);
    const rotated = await h.call(
      'POST',
      '/v1/secrets/stripe.key/rotate?envName=staging&scopeKind=tenant',
      { newValue: 'sk_test_y' },
    );
    expect([rotated.status, rotated.body.error?.code]).toEqual([409, 'env-not-served']);
    const put = await h.call('PUT', '/v1/env/KB_URL?envName=staging&scopeKind=tenant', {
      value: 'https://kb.acme.example',
    });
    expect([put.status, put.body.error?.message]).toEqual([
      409,
      REFUSAL('the env value `KB_URL` under `staging` would never be read. Store it under `prod`'),
    ]);
    expect(h.writes).toEqual([]);
  });

  test('under the served env: stored as before', async () => {
    const h = refusing();
    expect((await h.call('POST', '/v1/secrets', secret('prod', 'stripe.key'))).status).toBe(201);
    const rotated = await h.call(
      'POST',
      '/v1/secrets/stripe.key/rotate?envName=prod&scopeKind=tenant',
      { newValue: 'sk_test_y' },
    );
    expect(rotated.status).toBe(201);
    const put = await h.call('PUT', '/v1/env/KB_URL?envName=prod&scopeKind=tenant', {
      value: 'https://kb.acme.example',
    });
    expect(put.status).toBe(200);
    expect(h.writes).toEqual([
      ['secret.set', 'prod', 'stripe.key'],
      ['secret.rotate', 'prod', 'stripe.key'],
      ['env.set', 'prod', 'KB_URL'],
    ]);
  });

  test('a read or a delete under another env: answered, so a value stored before can be found and removed', async () => {
    const h = refusing();
    const listed = await h.call('GET', '/v1/secrets?envName=staging&scopeKind=tenant');
    expect(listed.status).toBe(200);
    const values = await h.call('GET', '/v1/env?envName=staging&scopeKind=tenant');
    expect(values.status).toBe(200);
    const revoked = await h.call(
      'DELETE',
      '/v1/secrets/stripe.key?envName=staging&scopeKind=tenant',
    );
    expect(revoked.status).toBe(200);
    const unset = await h.call('DELETE', '/v1/env/KB_URL?envName=staging&scopeKind=tenant');
    expect([unset.status, unset.body]).toEqual([200, { deleted: false }]);
    expect(h.writes).toEqual([
      ['secret.revoke', 'staging', 'stripe.key'],
      ['env.delete', 'staging', 'KB_URL'],
    ]);
  });
});

describe('a runtime that refuses other envs: a secret a registration still reads', () => {
  test('at the tenant scope, under the env a provider, MCP endpoint or webhook endpoint names: written', async () => {
    const h = refusing();
    for (const name of [PROVIDER_KEY, MCP_TOKEN, HOOK_SECRET]) {
      const set = await h.call('POST', '/v1/secrets', secret('local', name));
      expect([name, set.status]).toEqual([name, 201]);
    }
    const rotated = await h.call(
      'POST',
      `/v1/secrets/${PROVIDER_KEY}/rotate?envName=local&scopeKind=tenant`,
      { newValue: 'sk_test_y' },
    );
    expect(rotated.status).toBe(201);
    expect(h.writes).toEqual([
      ['secret.set', 'local', PROVIDER_KEY],
      ['secret.set', 'local', MCP_TOKEN],
      ['secret.set', 'local', HOOK_SECRET],
      ['secret.rotate', 'local', PROVIDER_KEY],
    ]);
  });

  test("a provider's key, under the env it names: written at a project and an org too, where a run reads it", async () => {
    const h = refusing();
    const org = { kind: 'org', tenantId, orgId: randomUUID() };
    for (const scope of [project, org]) {
      const set = await h.call('POST', '/v1/secrets', secret('local', PROVIDER_KEY, scope));
      expect([scope.kind, set.status]).toEqual([scope.kind, 201]);
    }
    const rotated = await h.call(
      'POST',
      `/v1/secrets/${PROVIDER_KEY}/rotate?envName=local&scopeKind=project&scopeId=${projectId}`,
      { newValue: 'sk_test_y' },
    );
    expect(rotated.status).toBe(201);
    const otherEnv = await h.call('POST', '/v1/secrets', secret('staging', PROVIDER_KEY, project));
    expect([otherEnv.status, otherEnv.body.error?.code]).toEqual([409, 'env-not-served']);
    expect(h.writes).toEqual([
      ['secret.set', 'local', PROVIDER_KEY],
      ['secret.set', 'local', PROVIDER_KEY],
      ['secret.rotate', 'local', PROVIDER_KEY],
    ]);
  });

  test('anywhere else: refused, since the registration reads it there only', async () => {
    const h = refusing();
    // Another scope: a webhook endpoint reads at the tenant's.
    const atProject = await h.call('POST', '/v1/secrets', secret('local', HOOK_SECRET, project));
    // Another env than the one it names.
    const otherEnv = await h.call('POST', '/v1/secrets', secret('staging', PROVIDER_KEY));
    // A name no registration names.
    const otherName = await h.call('POST', '/v1/secrets', secret('local', 'stripe.key'));
    // An env value: a registration names a secret.
    const value = await h.call('PUT', `/v1/env/${HOOK_SECRET}?envName=local&scopeKind=tenant`, {
      value: 'x',
    });
    expect(
      [atProject, otherEnv, otherName, value].map((r) => [r.status, r.body.error?.code]),
    ).toEqual(Array(4).fill([409, 'env-not-served']));
    expect(h.writes).toEqual([]);
  });
});

describe("a runtime that refuses other envs: an MCP endpoint's secret, at the scope recorded for it", () => {
  test('recorded at a project: written there, under the env it names; refused at the tenant', async () => {
    const h = refusing();
    const atProject = await h.call(
      'POST',
      '/v1/secrets',
      secret('local', MCP_PROJECT_TOKEN, project),
    );
    expect(atProject.status).toBe(201);
    const rotated = await h.call(
      'POST',
      `/v1/secrets/${MCP_PROJECT_TOKEN}/rotate?envName=local&scopeKind=project&scopeId=${projectId}`,
      { newValue: 'sk_test_y' },
    );
    expect(rotated.status).toBe(201);
    const atTenant = await h.call('POST', '/v1/secrets', secret('local', MCP_PROJECT_TOKEN));
    expect([atTenant.status, atTenant.body.error?.code]).toEqual([409, 'env-not-served']);
    expect(h.writes).toEqual([
      ['secret.set', 'local', MCP_PROJECT_TOKEN],
      ['secret.rotate', 'local', MCP_PROJECT_TOKEN],
    ]);
  });

  test('none recorded: read at the tenant, as before, so refused at a project', async () => {
    const h = refusing();
    const atProject = await h.call('POST', '/v1/secrets', secret('local', MCP_TOKEN, project));
    expect([atProject.status, atProject.body.error?.code]).toEqual([409, 'env-not-served']);
    expect((await h.call('POST', '/v1/secrets', secret('local', MCP_TOKEN))).status).toBe(201);
    expect(h.writes).toEqual([['secret.set', 'local', MCP_TOKEN]]);
  });

  test('recorded at no scope: read nowhere, so refused at both', async () => {
    const h = refusing();
    const refused = [
      await h.call('POST', '/v1/secrets', secret('local', MCP_UNREAD_TOKEN)),
      await h.call('POST', '/v1/secrets', secret('local', MCP_UNREAD_TOKEN, project)),
    ];
    expect(refused.map((r) => [r.status, r.body.error?.code])).toEqual(
      Array(2).fill([409, 'env-not-served']),
    );
    expect(h.writes).toEqual([]);
  });
});

describe('the tenant config: its values under the env the runtime serves, where its tools read; its settings under `default`', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const upsert = (kind: 'secret' | 'env', key: string, value: string) => ({ kind, key, value });

  /** Sets a secret and an env value through `PATCH /v1/tenant/config`, then reads them back as a tool and as the config. */
  async function setAndRead(h: ReturnType<typeof makeApp>, envName: string) {
    const set = [
      await h.call('PATCH', '/v1/tenant/config', upsert('secret', 'ACME_TOKEN', 'tok_test_1')),
      await h.call('PATCH', '/v1/tenant/config', upsert('env', 'ACME_REGION', 'eu')),
    ];
    const at = { scope: tenant as Scope, envName: envName as EnvName };
    const toolRead = await h.secretsBinding.resolve({
      ...at,
      name: 'ACME_TOKEN',
      resolveContext: { caller: 'dispatch' },
    });
    const valueRead = await h.envBinding.get({ ...at, name: 'ACME_REGION' });
    const listed = await h.call('GET', '/v1/tenant/config');
    return {
      statuses: set.map((r) => r.status),
      secret: toolRead.kind === 'ok' ? toolRead.value.value : toolRead.error.code,
      value: valueRead?.value,
      listed: (listed.body.data as { kind: string; key: string }[]).map((e) => [e.kind, e.key]),
    };
  }

  const READ_BACK = {
    statuses: [200, 200],
    secret: 'tok_test_1',
    value: 'eu',
    listed: [
      ['env', 'ACME_REGION'],
      ['secret', 'ACME_TOKEN'],
    ],
  };

  test('on a runtime that refuses other envs: stored under the served env, read by a tool, and listed', async () => {
    const h = refusing();
    expect(await setAndRead(h, 'prod')).toEqual(READ_BACK);
    expect(h.writes).toEqual([
      ['secret.set', 'prod', 'ACME_TOKEN'],
      ['env.set', 'prod', 'ACME_REGION'],
    ]);
  });

  test('on a runtime that serves an env and takes others: the same, and `KINDGI_ENV_NAME` is not read', async () => {
    vi.stubEnv('KINDGI_ENV_NAME', 'default');
    const h = makeApp({ envName: 'prod' });
    expect(await setAndRead(h, 'prod')).toEqual(READ_BACK);
    expect(h.writes.map(([, envName]) => envName)).toEqual(['prod', 'prod']);
  });

  test("a `config` entry, the tenant's own setting: under `default` whatever the runtime serves, so one set before still applies", async () => {
    const before: EnvRecord = {
      scope: tenant as Scope,
      envName: 'default' as EnvName,
      name: 'console.readOnlyNotice',
      value: 'Read-only here.',
      revision: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const h = makeApp({ envName: 'prod', refuseOtherEnvs: true }, [before]);
    const set = await h.call('PATCH', '/v1/tenant/config', {
      kind: 'config',
      key: 'acme.theme',
      value: 'dark',
    });
    expect(set.status).toBe(200);
    expect(h.writes).toEqual([['env.set', 'default', 'acme.theme']]);
    const listed = await h.call('GET', '/v1/tenant/config');
    expect(
      (listed.body.data as { kind: string; key: string; value: string }[]).map((e) => [
        e.kind,
        e.key,
        e.value,
      ]),
    ).toEqual([
      ['config', 'console.readOnlyNotice', 'Read-only here.'],
      ['config', 'acme.theme', 'dark'],
    ]);
  });

  test('a `config` entry sent with `sensitive: true`: a secret, so under the served env, where a tool reads it', async () => {
    const h = makeApp({ envName: 'prod', refuseOtherEnvs: true });
    const set = await h.call('PATCH', '/v1/tenant/config', {
      kind: 'config',
      key: 'ACME_SIGNING_KEY',
      value: 'sig_test_1',
      sensitive: true,
    });
    expect(set.status).toBe(200);
    expect(h.writes).toEqual([['secret.set', 'prod', 'ACME_SIGNING_KEY']]);
    const toolRead = await h.secretsBinding.resolve({
      scope: tenant as Scope,
      envName: 'prod' as EnvName,
      name: 'ACME_SIGNING_KEY',
      resolveContext: { caller: 'dispatch' },
    });
    expect(toolRead.kind === 'ok' ? toolRead.value.value : toolRead.error.code).toBe('sig_test_1');
    const listed = await h.call('GET', '/v1/tenant/config');
    expect(
      (listed.body.data as { kind: string; key: string }[]).map((e) => [e.kind, e.key]),
    ).toEqual([['secret', 'ACME_SIGNING_KEY']]);
  });

  test('on a runtime that serves no env: under `default`, as before', async () => {
    vi.stubEnv('KINDGI_ENV_NAME', 'prod');
    const h = makeApp();
    expect(await setAndRead(h, 'default')).toEqual(READ_BACK);
    expect(h.writes.map(([, envName]) => envName)).toEqual(['default', 'default']);
  });
});

describe('a runtime that refuses other envs: a registration naming its secret under another env', () => {
  test('a provider, an MCP endpoint, a webhook endpoint created or changed: 409, and nothing is registered', async () => {
    const h = refusing();
    const provider = await h.call('POST', '/v1/providers', {
      metadata,
      adapter_id: '@kindgi/adapter-model-openai-compat',
      secret_ref: { envName: 'local', name: 'OPENAI_API_KEY' },
    });
    expect([provider.status, provider.body.error]).toEqual([
      409,
      expect.objectContaining({
        code: 'env-not-served',
        message: REFUSAL(
          '`secret_ref` names `OPENAI_API_KEY` under `local`. Name it under `prod`, and store the secret there',
        ),
        details: { envName: 'local', servedEnv: 'prod' },
      }),
    ]);
    const mcp = await h.call('POST', '/v1/mcp/endpoints', {
      ...mcpEndpoint('staging'),
      scopeKind: 'tenant',
    });
    expect([mcp.status, mcp.body.error?.message]).toEqual([
      409,
      REFUSAL(
        'endpoint "acme-docs" names `DOCS_TOKEN` under `staging`. Name it under `prod`, and store the secret there',
      ),
    ]);
    const created = await h.call('POST', '/v1/webhook-endpoints', {
      url: 'https://app.acme.example/hooks',
      events: ['run.finished'],
      secretRef: { envName: 'staging', name: 'NEW_HOOK_SECRET' },
    });
    expect([created.status, created.body.error?.message]).toEqual([
      409,
      REFUSAL(
        '`secretRef` names `NEW_HOOK_SECRET` under `staging`. Name it under `prod`, and store the secret there',
      ),
    ]);
    const changed = await h.call('PATCH', '/v1/webhook-endpoints/whe-1', {
      secretRef: { envName: 'staging', name: HOOK_SECRET },
    });
    expect([changed.status, changed.body.error?.code]).toEqual([409, 'env-not-served']);
    expect(h.writes).toEqual([]);
  });

  test('naming it under the served env: registered', async () => {
    const h = refusing();
    const provider = await h.call('POST', '/v1/providers', {
      metadata,
      adapter_id: '@kindgi/adapter-model-openai-compat',
      secret_ref: { envName: 'prod', name: 'OPENAI_API_KEY' },
    });
    expect(provider.status).toBe(201);
    const mcp = await h.call('POST', '/v1/mcp/endpoints', {
      ...mcpEndpoint('prod'),
      scopeKind: 'tenant',
    });
    expect(mcp.status).toBe(201);
    const created = await h.call('POST', '/v1/webhook-endpoints', {
      url: 'https://app.acme.example/hooks',
      events: ['run.finished'],
      secretRef: { envName: 'prod', name: 'NEW_HOOK_SECRET' },
    });
    expect(created.status).toBe(201);
    expect(h.writes).toEqual([
      ['provider.register', 'prod', 'OPENAI_API_KEY'],
      ['mcp.register', 'prod', 'DOCS_TOKEN'],
      ['webhook.create', 'prod', 'NEW_HOOK_SECRET'],
    ]);
  });
});

describe('without the switch: every env, as before', () => {
  test.each([
    ['a served env', { envName: 'prod' }],
    ['the switch off', { envName: 'prod', refuseOtherEnvs: false }],
    ['no served env', {}],
  ])('%s: a value or a registration under another env is taken', async (_, served) => {
    const h = makeApp(served);
    expect((await h.call('POST', '/v1/secrets', secret('staging', 'stripe.key'))).status).toBe(201);
    const put = await h.call('PUT', '/v1/env/KB_URL?envName=staging&scopeKind=tenant', {
      value: 'https://kb.acme.example',
    });
    expect(put.status).toBe(200);
    const provider = await h.call('POST', '/v1/providers', {
      metadata,
      adapter_id: '@kindgi/adapter-model-openai-compat',
      secret_ref: { envName: 'staging', name: 'OPENAI_API_KEY' },
    });
    expect(provider.status).toBe(201);
    expect(h.writes).toEqual([
      ['secret.set', 'staging', 'stripe.key'],
      ['env.set', 'staging', 'KB_URL'],
      ['provider.register', 'staging', 'OPENAI_API_KEY'],
    ]);
  });

  test('refusing other envs needs the env this runtime serves', () => {
    expect(() =>
      createApp({ ...createStubAppBindings(), resolveToken, runHandler, refuseOtherEnvs: true }),
    ).toThrow(
      'createApp: `refuseOtherEnvs` needs `envName`, the env this runtime serves (KINDGI_ENV)',
    );
  });
});

describe('whoami says what the runtime serves', () => {
  test.each([
    [
      'refusing other envs',
      { envName: 'prod', refuseOtherEnvs: true },
      { envName: 'prod', refusesOtherEnvs: true },
    ],
    ['serving one, taking any', { envName: 'prod' }, { envName: 'prod', refusesOtherEnvs: false }],
    ['serving none: no field', {}, undefined],
  ])('%s', async (_, served, expected) => {
    const whoami = await makeApp(served).call('GET', '/v1/identity/whoami');
    expect(whoami.status).toBe(200);
    expect(whoami.body.servedEnv).toEqual(expected);
  });
});
