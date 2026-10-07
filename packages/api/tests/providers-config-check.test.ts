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

import { createStubAppBindings } from '@kindgi/testing';

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

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
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
            field: 'adapter_config.region',
            message: `provider "${input.metadata.id}": region "moon" isn't one.`,
          },
        ]
      : []),
    ...(input.hasSecretRef
      ? []
      : [{ field: 'secret_ref', message: `provider "${input.metadata.id}" needs secret_ref.` }]),
  ],
};
const unchecked: AdapterFactoryEntry = {
  adapterId: '@acme/adapter-without-check',
  capabilityKind: 'llm-inference',
  factory: checked.factory,
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
} {
  const stored = new Map<string, ProviderRuntimeEntry>();
  return {
    stored,
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
      error: { code: string; message: string; details: { problems: unknown[] } };
    };
    expect(body.error.code).toBe('provider-config-invalid');
    expect(body.error.message).toBe(
      'provider "acme": region "moon" isn\'t one. provider "acme" needs secret_ref.',
    );
    expect(body.error.details.problems).toEqual([
      { field: 'adapter_config.region', message: 'provider "acme": region "moon" isn\'t one.' },
      { field: 'secret_ref', message: 'provider "acme" needs secret_ref.' },
    ]);
    expect(registry.stored.size).toBe(0);
  });

  test('an adapter this runtime does not have is refused', async () => {
    const { app } = makeApp(true);
    const res = await register(app, { metadata: metadata('acme'), adapter_id: '@acme/gone' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { problems: { field: string }[] } } };
    expect(body.error.details.problems.map((p) => p.field)).toEqual(['adapter_id']);
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
      problems: [
        { field: 'adapter_config.region', message: 'provider "old": region "moon" isn\'t one.' },
        { field: 'secret_ref', message: 'provider "old" needs secret_ref.' },
      ],
    });
    expect(await (await check(app, 'good')).json()).toMatchObject({ checked: true, problems: [] });
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
      problems: [{ field: 'adapter_id' }],
    });
    expect(await (await check(app, 'plain')).json()).toEqual({
      providerId: 'plain',
      adapterId: '@acme/adapter-without-check',
      checked: false,
      problems: [],
    });
  });

  test('without the adapter factories, nothing is checked', async () => {
    const { app, registry } = makeApp(false);
    await registry.register({ tenantId, metadata: metadata('old'), adapterId: ADAPTER });
    expect(await (await check(app, 'old')).json()).toMatchObject({ checked: false, problems: [] });
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
