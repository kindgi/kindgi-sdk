// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A provider's registration is checked by its adapter (`checkConfig`)
 * before it's stored, and a registered one can be checked again:
 * `POST /v1/providers` answers 422 `provider-config-invalid` naming each
 * field, and `GET /v1/providers/{id}/check` lists the problems of what's
 * stored. Without the deployment's adapter factories, nothing changes.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type AdapterConfigCheckInput,
  type AdapterFactoryEntry,
  type ProviderMetadata,
  createAdapterFactoryRegistry,
} from '@kindgi/capabilities';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ProviderRegistryBinding,
  ProviderRuntimeEntry,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'providers-check-token';
const auth = { authorization: `Bearer ${TOKEN}` };

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, scopes: ['tenant-admin'] } : null;
const notUsed = async () => ({
  kind: 'err' as const,
  error: { code: 'bad-input', message: 'not used in this suite' },
});
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};

const ADAPTER = '@acme/adapter-model-acme';

/** A stand-in adapter whose check wants `adapter_config.region` and a `secret_ref`. */
const checked: AdapterFactoryEntry = {
  adapterId: ADAPTER,
  capabilityKind: 'llm-inference',
  factory: () => {
    throw new Error('not built in this suite');
  },
  checkConfig: (input: AdapterConfigCheckInput) => [
    ...(input.config?.region === 'moon'
      ? [
          {
            path: '/adapter_config/region',
            message: 'adapter_config.region "moon" isn\'t one.',
          },
        ]
      : []),
    ...(input.hasSecretRef ? [] : [{ path: '/secret_ref', message: 'needs secret_ref.' }]),
  ],
};
const unchecked: AdapterFactoryEntry = {
  adapterId: '@acme/adapter-without-check',
  capabilityKind: 'llm-inference',
  factory: checked.factory,
};
/**
 * One that declares its keys: `region` and `project`, with `thinkingLevels`
 * moved. Its own check refuses a bare `extra` (as openai-compat's refuses a
 * bare `extraBody`), which it doesn't declare either.
 */
const DECLARED = '@acme/adapter-with-keys';
const declared: AdapterFactoryEntry = {
  adapterId: DECLARED,
  capabilityKind: 'llm-inference',
  factory: checked.factory,
  checkConfig: (input) => [
    ...(input.config?.region === 'moon'
      ? [{ path: '/adapter_config/region', message: 'adapter_config.region "moon" isn\'t one.' }]
      : []),
    ...(input.config?.extra !== undefined
      ? [{ path: '/adapter_config/extra', message: 'adapter_config.extra goes in extra.<field>.' }]
      : []),
  ],
  configKeys: ['region', 'project'],
  movedConfigKeys: { thinkingLevels: 'metadata.models[].thinking.default' },
};
/** Declared keys and no check of its own. */
const KEYS_ONLY = '@acme/adapter-keys-only';
const keysOnly: AdapterFactoryEntry = {
  adapterId: KEYS_ONLY,
  capabilityKind: 'llm-inference',
  factory: checked.factory,
  configKeys: ['baseURL'],
};

function metadata(id: string): ProviderMetadata {
  return {
    id,
    region: 'unspecified',
    models: [
      {
        name: 'acme-model',
        contextWindow: 8192,
        features: ['tool-use'],
        cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
      },
    ],
  };
}

/** Keeps what the runtime reads back (`resolveForRuntime`), as a real binding does. */
function binding(): ProviderRegistryBinding & {
  readonly stored: Map<string, ProviderRuntimeEntry>;
  readonly sent: Map<string, boolean>;
} {
  const stored = new Map<string, ProviderRuntimeEntry>();
  const sent = new Map<string, boolean>();
  return {
    stored,
    sent,
    async list() {
      return { data: [...stored.values()].map((e) => e.metadata) };
    },
    async get({ providerId }) {
      return stored.get(providerId)?.metadata ?? null;
    },
    async register(input) {
      stored.set(input.metadata.id, {
        metadata: input.metadata,
        adapterId: input.adapterId,
        ...(input.secretRef !== undefined && { secretRef: input.secretRef }),
        ...(input.adapterConfig !== undefined && { adapterConfig: input.adapterConfig }),
      });
      if (input.sendTraceparent !== undefined) sent.set(input.metadata.id, input.sendTraceparent);
      return { kind: 'ok', providerId: input.metadata.id };
    },
    async unregister({ providerId }) {
      return { unregistered: stored.delete(providerId) };
    },
    async capabilitiesFor() {
      return [];
    },
    async resolveForRuntime() {
      return [...stored.values()];
    },
  };
}

function makeApp(withFactories: boolean) {
  const registry = binding();
  const factories = createAdapterFactoryRegistry();
  factories.register(checked);
  factories.register(unchecked);
  factories.register(declared);
  factories.register(keysOnly);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    providerRegistry: registry,
    ...(withFactories && { adapterFactories: factories }),
  });
  return { app, registry };
}

const register = (app: ReturnType<typeof makeApp>['app'], body: Record<string, unknown>) =>
  app.request('/v1/providers', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const SECRET = { envName: 'local', name: 'ACME_API_KEY' };

describe('POST /v1/providers: send_traceparent', () => {
  test('a boolean is stored with the registration; absent, nothing is', async () => {
    const { app, registry } = makeApp(true);
    for (const [id, value] of [
      ['acme-on', true],
      ['acme-off', false],
    ] as const) {
      const res = await register(app, {
        metadata: metadata(id),
        adapter_id: ADAPTER,
        secret_ref: SECRET,
        send_traceparent: value,
      });
      expect(res.status).toBe(201);
    }
    expect(
      (
        await register(app, {
          metadata: metadata('acme-unset'),
          adapter_id: ADAPTER,
          secret_ref: SECRET,
        })
      ).status,
    ).toBe(201);
    expect([...registry.sent.entries()]).toEqual([
      ['acme-on', true],
      ['acme-off', false],
    ]);
  });

  test("anything else is 422 provider-config-invalid, the registration's own issue first, then the adapter's, in one answer", async () => {
    const { app, registry } = makeApp(true);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: ADAPTER,
      send_traceparent: 'yes',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { issues: unknown[] } };
    };
    expect(body.error.code).toBe('provider-config-invalid');
    expect(body.error.message).toBe(
      'Provider "acme": send_traceparent must be true or false (and 1 more).',
    );
    expect(body.error.details.issues).toEqual([
      { path: '/send_traceparent', message: 'send_traceparent must be true or false.' },
      { path: '/secret_ref', message: 'needs secret_ref.' },
    ]);
    expect(registry.stored.size).toBe(0);
  });

  test("checked even without the deployment's adapter factories", async () => {
    const { app, registry } = makeApp(false);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: ADAPTER,
      send_traceparent: 1,
    });
    expect(res.status).toBe(422);
    expect(registry.stored.size).toBe(0);
  });
});

describe('POST /v1/providers checks the registration with its adapter', () => {
  test('a registration the adapter takes is stored', async () => {
    const { app, registry } = makeApp(true);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: ADAPTER,
      secret_ref: SECRET,
      adapter_config: { region: 'eu' },
    });
    expect(res.status).toBe(201);
    expect(registry.stored.has('acme')).toBe(true);
  });

  test('one it refuses is 422 provider-config-invalid, naming every field, and nothing is stored', async () => {
    const { app, registry } = makeApp(true);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: ADAPTER,
      adapter_config: { region: 'moon' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { issues: unknown[] } };
    };
    expect(body.error.code).toBe('provider-config-invalid');
    expect(body.error.message).toBe(
      'Provider "acme" doesn\'t fit adapter @acme/adapter-model-acme: adapter_config.region "moon" isn\'t one (and 1 more).',
    );
    expect(body.error.details.issues).toEqual([
      { path: '/adapter_config/region', message: 'adapter_config.region "moon" isn\'t one.' },
      { path: '/secret_ref', message: 'needs secret_ref.' },
    ]);
    expect(registry.stored.size).toBe(0);
  });

  test('an adapter this runtime does not have is refused', async () => {
    const { app } = makeApp(true);
    const res = await register(app, { metadata: metadata('acme'), adapter_id: '@acme/gone' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { message: string; details: { issues: { path: string }[] } };
    };
    expect(body.error.details.issues.map((p) => p.path)).toEqual(['/adapter_id']);
    expect(body.error.message).toBe(
      'This runtime has no adapter "@acme/gone", so it can\'t build provider "acme".',
    );
  });

  test('an adapter without a check takes any flat adapter_config', async () => {
    const { app } = makeApp(true);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: '@acme/adapter-without-check',
      adapter_config: { region: 'moon' },
    });
    expect(res.status).toBe(201);
  });

  test('without the adapter factories (an older runtime), nothing is checked', async () => {
    const { app } = makeApp(false);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: ADAPTER,
      adapter_config: { region: 'moon' },
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /v1/providers refuses an adapter_config key its adapter doesn't take", () => {
  test('an unknown key is 422 provider-config-invalid, naming it and the keys the adapter takes', async () => {
    const { app, registry } = makeApp(true);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: DECLARED,
      adapter_config: { region: 'eu', projct: 'acme-project' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { issues: unknown[] } };
    };
    expect(body.error.code).toBe('provider-config-invalid');
    expect(body.error.message).toBe(
      `Provider "acme" doesn't fit adapter ${DECLARED}: adapter_config.projct isn't a setting of this adapter: it takes region, project.`,
    );
    expect(body.error.details.issues).toEqual([
      {
        path: '/adapter_config/projct',
        message: "adapter_config.projct isn't a setting of this adapter: it takes region, project.",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('acme-project');
    expect(registry.stored.size).toBe(0);
  });

  test("a moved key names where its setting goes, beside the adapter's own problems", async () => {
    const { app } = makeApp(true);
    const res = await register(app, {
      metadata: metadata('acme'),
      adapter_id: DECLARED,
      adapter_config: { region: 'moon', thinkingLevels: '{"acme-model":"low"}' },
    });
    expect(res.status).toBe(422);
    expect(
      ((await res.json()) as { error: { details: { issues: unknown[] } } }).error.details.issues,
    ).toEqual([
      { path: '/adapter_config/region', message: 'adapter_config.region "moon" isn\'t one.' },
      {
        path: '/adapter_config/thinkingLevels',
        message:
          "adapter_config.thinkingLevels isn't read here: its setting is metadata.models[].thinking.default.",
      },
    ]);
  });

  test('an adapter with declared keys and no check of its own refuses one too; its own keys are stored', async () => {
    const { app, registry } = makeApp(true);
    const bad = await register(app, {
      metadata: metadata('acme'),
      adapter_id: KEYS_ONLY,
      adapter_config: { baseUrl: 'https://llm.acme.test' },
    });
    expect(bad.status).toBe(422);
    const good = await register(app, {
      metadata: metadata('acme'),
      adapter_id: KEYS_ONLY,
      adapter_config: { baseURL: 'https://llm.acme.test' },
    });
    expect(good.status).toBe(201);
    expect(registry.stored.get('acme')?.adapterConfig).toEqual({
      baseURL: 'https://llm.acme.test',
    });
  });
});

describe('GET /v1/providers/{providerId}/check', () => {
  const check = (app: ReturnType<typeof makeApp>['app'], id: string) =>
    app.request(`/v1/providers/${encodeURIComponent(id)}/check`, { headers: auth });

  test("a registered provider's stored registration, through its adapter's check", async () => {
    const { app, registry } = makeApp(true);
    // Stored before the check existed: a bad region, no secret.
    await registry.register({
      tenantId,
      metadata: metadata('old'),
      adapterId: ADAPTER,
      adapterConfig: { region: 'moon' },
    });
    await registry.register({
      tenantId,
      metadata: metadata('good'),
      adapterId: ADAPTER,
      secretRef: SECRET,
    });
    const bad = await check(app, 'old');
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({
      providerId: 'old',
      adapterId: ADAPTER,
      checked: true,
      issues: [
        { path: '/adapter_config/region', message: 'adapter_config.region "moon" isn\'t one.' },
        { path: '/secret_ref', message: 'needs secret_ref.' },
      ],
    });
    expect(await (await check(app, 'good')).json()).toMatchObject({ checked: true, issues: [] });
  });

  test('its secretRef, by name only, for a caller allowed to check; list and get still never return it', async () => {
    const { app, registry } = makeApp(true);
    await registry.register({
      tenantId,
      metadata: metadata('keyed'),
      adapterId: ADAPTER,
      secretRef: SECRET,
    });
    const body = (await (await check(app, 'keyed')).json()) as Record<string, unknown>;
    expect(body.secretRef).toEqual({ envName: SECRET.envName, name: SECRET.name });

    const listed = (await (await app.request('/v1/providers', { headers: auth })).json()) as {
      data: Record<string, unknown>[];
    };
    expect(listed.data.find((p) => p.id === 'keyed')).not.toHaveProperty('secretRef');
    const got = (await (
      await app.request('/v1/providers/keyed', { headers: auth })
    ).json()) as Record<string, unknown>;
    expect(got).not.toHaveProperty('secretRef');
    expect(got).not.toHaveProperty('secret_ref');
  });

  test('an adapter this runtime does not have is a problem; one without a check is not checked', async () => {
    const { app, registry } = makeApp(true);
    await registry.register({ tenantId, metadata: metadata('gone'), adapterId: '@acme/gone' });
    await registry.register({
      tenantId,
      metadata: metadata('plain'),
      adapterId: '@acme/adapter-without-check',
    });
    expect(await (await check(app, 'gone')).json()).toMatchObject({
      checked: true,
      issues: [{ path: '/adapter_id' }],
    });
    expect(await (await check(app, 'plain')).json()).toEqual({
      providerId: 'plain',
      adapterId: '@acme/adapter-without-check',
      checked: false,
      issues: [],
    });
  });

  test("a stored key the adapter doesn't take is a warning, not an issue: the runtime builds it", async () => {
    const { app, registry } = makeApp(true);
    await registry.register({
      tenantId,
      metadata: metadata('old'),
      adapterId: DECLARED,
      adapterConfig: {
        region: 'eu',
        thinkingLevels: '{"acme-model":"low"}',
        projct: 'acme-project',
      },
    });
    const body = await (await check(app, 'old')).json();
    expect(body).toEqual({
      providerId: 'old',
      adapterId: DECLARED,
      checked: true,
      issues: [],
      warnings: [
        {
          path: '/adapter_config/thinkingLevels',
          message:
            "adapter_config.thinkingLevels isn't read here: its setting is metadata.models[].thinking.default.",
        },
        {
          path: '/adapter_config/projct',
          message:
            "adapter_config.projct isn't a setting of this adapter: it takes region, project.",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('acme-project');
  });

  test("an adapter's own problem and an unknown key: one in each list, and a key its check refuses only in issues", async () => {
    const { app, registry } = makeApp(true);
    await registry.register({
      tenantId,
      metadata: metadata('both'),
      adapterId: DECLARED,
      adapterConfig: { region: 'moon', extra: 'x', projct: 'y' },
    });
    expect(await (await check(app, 'both')).json()).toMatchObject({
      checked: true,
      issues: [{ path: '/adapter_config/region' }, { path: '/adapter_config/extra' }],
      warnings: [{ path: '/adapter_config/projct' }],
    });
  });

  test('declared keys and no check of its own: checked, with no warnings when none', async () => {
    const { app, registry } = makeApp(true);
    await registry.register({
      tenantId,
      metadata: metadata('keyed-only'),
      adapterId: KEYS_ONLY,
      adapterConfig: { baseURL: 'https://llm.acme.test' },
    });
    expect(await (await check(app, 'keyed-only')).json()).toEqual({
      providerId: 'keyed-only',
      adapterId: KEYS_ONLY,
      checked: true,
      issues: [],
    });
  });

  test('without the adapter factories, nothing is checked', async () => {
    const { app, registry } = makeApp(false);
    await registry.register({ tenantId, metadata: metadata('old'), adapterId: ADAPTER });
    expect(await (await check(app, 'old')).json()).toMatchObject({ checked: false, issues: [] });
  });

  test('an unknown provider is 404 provider-not-found', async () => {
    const { app } = makeApp(true);
    const res = await check(app, 'nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'provider-not-found',
    );
  });
});
