// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The webhook trigger admin routes (`/v1/webhooks`): what a registration
 * keeps by default, what it refuses, what an update changes or clears,
 * and the project filter, deliveries and ownership. Authorization is
 * `route-authz-triggers.test.ts`; the receiver is `hooks-receive.test.ts`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { EnvName, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  ProviderRegistryBinding,
  RunHandlerBinding,
  SecretBinding,
  TokenResolver,
} from '../src/index.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

const TENANT = randomUUID() as TenantId;
const TOKEN = 'webhooks-routes';
const DEFAULT_PROJECT = '00000000-0000-4000-8000-0000000000d1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000d2';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId: TENANT, userId: 'user-1' as UserId } : null;

function setup() {
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: DEFAULT_PROJECT as never });
  const app = createApp({
    ...createStubAppBindings(),
    triggerRegistry: registry,
    secretsBinding: {} as SecretBinding,
    providerRegistry: {
      resolveForRuntime: async () => [
        { metadata: { id: 'acme-llm' }, secretRef: { name: 'acme-provider-key' } },
      ],
    } as unknown as ProviderRegistryBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    webhookReceiver: { envName: 'test' as EnvName },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/webhooks${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const base = { flowId: 'acme.refund-review', flowVersion: '1.0.0', hmacSecretName: 'acme-hmac' };
  return { call, base, registry };
}

describe('registering a webhook trigger', () => {
  test('keeps the defaults: the Default project, the caller as owner, hex in X-Kindgi-Signature, 256 KiB, 600 a minute', async () => {
    const { call, base } = setup();
    const res = await call('POST', '', base);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      flowId: 'acme.refund-review',
      flowVersion: '1.0.0',
      projectId: DEFAULT_PROJECT,
      owner: { kind: 'user', id: 'user-1' },
      hmacSecretName: 'acme-hmac',
      signature: { kind: 'hmac-sha256', encoding: 'hex', header: 'X-Kindgi-Signature' },
      bodyLimitBytes: 262144,
      rateLimitPerMinute: 600,
      status: 'active',
    });
    expect(res.body.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).not.toHaveProperty('deliveryIdHeader');
  });

  test('takes a project, a scheme, a delivery-id header and its own limits', async () => {
    const { call, base } = setup();
    const res = await call('POST', '', {
      ...base,
      projectId: OTHER_PROJECT,
      signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
      deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
      bodyLimitBytes: 65536,
      rateLimitPerMinute: 120,
      config: { input: { source: 'acme-store' } },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      projectId: OTHER_PROJECT,
      signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
      deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
      bodyLimitBytes: 65536,
      rateLimitPerMinute: 120,
      input: { source: 'acme-store' },
    });
  });

  test.each([
    ['a scheme of no known kind', { signature: { kind: 'hmac-md5' } }, '`signature` is'],
    [
      'an encoding that is neither hex nor base64',
      { signature: { kind: 'hmac-sha256', encoding: 'base32', header: 'X-Sig' } },
      '`signature.encoding`',
    ],
    [
      'a header that is not a header name',
      { signature: { kind: 'hmac-sha256', encoding: 'hex', header: 'X Sig' } },
      '`signature.header`',
    ],
    [
      'an unknown field in the scheme',
      { signature: { kind: 'hmac-sha256', encoding: 'hex', header: 'X-Sig', salt: 'x' } },
      '`signature` is',
    ],
    [
      'a tolerance past an hour',
      { signature: { kind: 'standard-webhooks', toleranceSeconds: 3601 } },
      '`signature.toleranceSeconds`',
    ],
    [
      'a delivery-id header with Standard Webhooks',
      { signature: { kind: 'standard-webhooks' }, deliveryIdHeader: 'X-Id' },
      'dedupes on its own `webhook-id`',
    ],
    ['a body cap under 1 KiB', { bodyLimitBytes: 100 }, '`bodyLimitBytes`'],
    ['a body cap over 1 MiB', { bodyLimitBytes: 1048577 }, '`bodyLimitBytes`'],
    ['a rate over the cap', { rateLimitPerMinute: 6001 }, '`rateLimitPerMinute`'],
    ['a project that is not a UUID', { projectId: 'acme' }, '`projectId`'],
    ['no secret', { hmacSecretName: '' }, '`hmacSecretName` is required'],
  ])('refuses %s', async (_, change, message) => {
    const { call, base } = setup();
    const res = await call('POST', '', { ...base, ...change });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain(message);
  });

  test("refuses a model provider's key as its secret", async () => {
    const { call, base } = setup();
    const res = await call('POST', '', { ...base, hmacSecretName: 'acme-provider-key' });
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'provider-key-refused' } } });
  });
});

describe('changing a webhook trigger', () => {
  test('changes the version, the secret and the scheme; `null` clears the header and the limits', async () => {
    const { call, base } = setup();
    const t = (
      await call('POST', '', {
        ...base,
        deliveryIdHeader: 'X-Delivery',
        bodyLimitBytes: 4096,
        rateLimitPerMinute: 5,
      })
    ).body;
    const res = await call('PATCH', `/${t.triggerId}`, {
      flowVersion: '1.1.0',
      hmacSecretName: 'acme-hmac-2',
      signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-Signature' },
      deliveryIdHeader: null,
      bodyLimitBytes: null,
      rateLimitPerMinute: null,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      flowVersion: '1.1.0',
      hmacSecretName: 'acme-hmac-2',
      signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-Signature' },
      bodyLimitBytes: 262144,
      rateLimitPerMinute: 600,
    });
    expect(res.body).not.toHaveProperty('deliveryIdHeader');
  });

  test("keeps its flow; refuses a provider's key; refuses Standard Webhooks with the header it already has", async () => {
    const { call, base } = setup();
    const t = (await call('POST', '', { ...base, deliveryIdHeader: 'X-Delivery' })).body;
    expect((await call('PATCH', `/${t.triggerId}`, { flowId: 'acme.other' })).status).toBe(400);
    expect(
      (await call('PATCH', `/${t.triggerId}`, { hmacSecretName: 'acme-provider-key' })).body.error
        .code,
    ).toBe('provider-key-refused');
    const sw = await call('PATCH', `/${t.triggerId}`, { signature: { kind: 'standard-webhooks' } });
    expect(sw.status).toBe(400);
    expect(sw.body.error.message).toContain('`webhook-id`');
  });
});

describe('reading webhook triggers', () => {
  test('a project filter lists that project only; a filter that is not a UUID is refused', async () => {
    const { call, base } = setup();
    const a = (await call('POST', '', base)).body;
    const b = (await call('POST', '', { ...base, projectId: OTHER_PROJECT })).body;
    const all = (await call('GET', '')).body.data.map((t: { triggerId: string }) => t.triggerId);
    expect(all.sort()).toEqual([a.triggerId, b.triggerId].sort());
    const other = (await call('GET', `?projectId=${OTHER_PROJECT}`)).body.data;
    expect(other.map((t: { triggerId: string }) => t.triggerId)).toEqual([b.triggerId]);
    expect((await call('GET', '?projectId=acme')).status).toBe(400);
  });

  test('deliveries, newest first; another kind of trigger is not found here', async () => {
    const { call, base, registry } = setup();
    const t = (await call('POST', '', base)).body;
    registry.recordFire({
      triggerId: t.triggerId,
      kind: 'webhook',
      firedAt: '2026-10-10T10:00:00.000Z',
      outcome: 'refused',
      detail: 'signature-invalid',
    });
    registry.recordFire({
      triggerId: t.triggerId,
      kind: 'webhook',
      firedAt: '2026-10-10T10:01:00.000Z',
      outcome: 'started',
      runId: '00000000-0000-4000-8000-00000000e001',
    });
    const fires = (await call('GET', `/${t.triggerId}/fires`)).body.data;
    expect(fires.map((f: { outcome: string }) => f.outcome)).toEqual(['started', 'refused']);
    expect(fires[1]).toEqual({
      fireId: expect.any(String),
      triggerId: t.triggerId,
      firedAt: '2026-10-10T10:00:00.000Z',
      outcome: 'refused',
      detail: 'signature-invalid',
    });
    expect((await call('GET', `/${randomUUID()}/fires`)).status).toBe(404);
  });

  test('taking ownership makes the caller the owner', async () => {
    const { call, base, registry } = setup();
    const t = (await call('POST', '', base)).body;
    await registry.setOwner?.({
      tenantId: TENANT,
      triggerId: t.triggerId,
      owner: { kind: 'user', id: 'user-left' },
    });
    const res = await call('POST', `/${t.triggerId}/owner`);
    expect(res).toMatchObject({ status: 200, body: { owner: { kind: 'user', id: 'user-1' } } });
  });
});
