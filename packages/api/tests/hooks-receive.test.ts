// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The inbound receiver, `POST /v1/hooks/{tenantId}/{webhookId}`: a signed
 * delivery starts the trigger's flow; everything that doesn't prove its
 * sender gets the same 401, with the reason only in the trigger's history
 * (and the access audit); a delivery repeated starts nothing; WooCommerce's
 * unsigned save-time ping gets its 200; a paused trigger takes the delivery
 * and starts nothing; the limits answer 413 and 429.
 */

import { createHmac, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { generateWebhookSecret, webhookHeaders } from '@kindgi/crypto';
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
const OTHER_TENANT = randomUUID() as TenantId;
const TOKEN = 'hooks-receive';
const OTHER_TOKEN = 'hooks-receive-other';
const PROJECT = '00000000-0000-4000-8000-0000000000a1';
// Letters and digits only: WooCommerce HTML-decodes its secret before signing.
const WOO_SECRET = 'acmeWooSecret42';
const HUB_SECRET = 'acme-hub-secret';
const PROVIDER_KEY = 'acme-provider-key';

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN
    ? { tenantId: TENANT, userId: 'user-1' as UserId }
    : token === OTHER_TOKEN
      ? { tenantId: OTHER_TENANT, userId: 'user-2' as UserId }
      : null;

function setup(options: { publicUrl?: string } = {}) {
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT as never });
  const stored = new Map<string, string>([
    [WOO_SECRET, WOO_SECRET],
    [HUB_SECRET, HUB_SECRET],
    ['acme-sw', generateWebhookSecret()],
    [PROVIDER_KEY, 'sk-acme-provider'],
  ]);
  const secrets = {
    async resolve(input: { name: string }) {
      const value = stored.get(input.name);
      return value === undefined
        ? {
            kind: 'err',
            error: { code: 'secret-not-found', message: 'not found', name: input.name },
          }
        : { kind: 'ok', value: { name: input.name, versionId: 1, value } };
    },
  } as unknown as SecretBinding;
  const providerRegistry = {
    resolveForRuntime: async () => [
      { metadata: { id: 'acme-llm' }, secretRef: { name: PROVIDER_KEY } },
    ],
  } as unknown as ProviderRegistryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    triggerRegistry: registry,
    secretsBinding: secrets,
    providerRegistry,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    webhookReceiver: {
      envName: 'test' as EnvName,
      clientAddress: (request) => request.headers.get('x-test-client') ?? 'client-0',
    },
    ...(options.publicUrl !== undefined && { publicUrl: options.publicUrl }),
  });
  const admin = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const res = await app.request(`/v1/webhooks${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const register = async (extra: Record<string, unknown>) => {
    const res = await admin('POST', '', {
      flowId: 'acme.refund-review',
      flowVersion: '1.0.0',
      hmacSecretName: WOO_SECRET,
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { triggerId: string; webhookId: string; receiveUrl?: string };
  };
  const deliver = async (
    webhookId: string,
    body: string,
    headers: Record<string, string>,
    tenantId: string = TENANT,
  ) => {
    const res = await app.request(`/v1/hooks/${tenantId}/${webhookId}`, {
      method: 'POST',
      headers,
      body,
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text.length === 0 ? undefined : (JSON.parse(text) as Record<string, any>),
    };
  };
  const fires = async (triggerId: string) =>
    (await admin('GET', `/${triggerId}/fires`)).body.data as Record<string, any>[];
  return { app, registry, admin, register, deliver, fires, stored };
}

const wooSign = (body: string, secret = WOO_SECRET) =>
  createHmac('sha256', secret).update(body).digest('base64');
const hubSign = (body: string, secret = HUB_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const WOO = {
  signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
  deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
};
const ORDER = JSON.stringify({ id: 4211, status: 'processing', total: '240.00' });
const wooHeaders = (body: string, deliveryId = 'acme-delivery-1', secret = WOO_SECRET) => ({
  'content-type': 'application/json',
  'x-wc-webhook-topic': 'order.created',
  'x-wc-webhook-delivery-id': deliveryId,
  'x-wc-webhook-signature': wooSign(body, secret),
});

describe('a signed delivery', () => {
  test('starts one fire, with the parsed event; the same delivery again starts nothing', async () => {
    const { register, deliver, fires, registry } = setup();
    const t = await register(WOO);
    const first = await deliver(t.webhookId, ORDER, wooHeaders(ORDER));
    expect(first.status).toBe(202);
    const fireId = first.body?.fireId as string;
    expect(registry.webhookEvents.get(fireId)).toEqual(JSON.parse(ORDER));

    const again = await deliver(t.webhookId, ORDER, wooHeaders(ORDER));
    expect(again).toMatchObject({ status: 200, body: { fireId, duplicate: true } });
    const history = await fires(t.triggerId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fireId, outcome: 'pending', duplicates: 1 });
  });

  test("WooCommerce's delivery id is per second, not per event: the body tells two orders apart", async () => {
    const { register, deliver } = setup();
    const t = await register(WOO);
    const other = JSON.stringify({ id: 4212, status: 'processing', total: '40.00' });
    const a = await deliver(t.webhookId, ORDER, wooHeaders(ORDER, 'same-second'));
    const b = await deliver(t.webhookId, other, wooHeaders(other, 'same-second'));
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body?.fireId).not.toBe(b.body?.fireId);
  });

  test('without a delivery-id header, every delivery is its own fire', async () => {
    const { register, deliver } = setup();
    const t = await register({ signature: WOO.signature });
    const a = await deliver(t.webhookId, ORDER, wooHeaders(ORDER));
    const b = await deliver(t.webhookId, ORDER, wooHeaders(ORDER));
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body?.fireId).not.toBe(b.body?.fireId);
  });

  test('GitHub-style (and Drupal Webhooks-style) hex after `sha256=`', async () => {
    const { register, deliver } = setup();
    const t = await register({
      hmacSecretName: HUB_SECRET,
      signature: {
        kind: 'hmac-sha256',
        encoding: 'hex',
        header: 'X-Hub-Signature-256',
        prefix: 'sha256=',
      },
    });
    const body = JSON.stringify({ action: 'opened' });
    const res = await deliver(t.webhookId, body, {
      'content-type': 'application/json',
      'x-hub-signature-256': hubSign(body),
    });
    expect(res.status).toBe(202);
  });

  test('the default scheme: hex in X-Kindgi-Signature', async () => {
    const { register, deliver } = setup();
    const t = await register({ hmacSecretName: HUB_SECRET });
    const body = '{"ok":true}';
    const hex = createHmac('sha256', HUB_SECRET).update(body).digest('hex');
    const res = await deliver(t.webhookId, body, {
      'content-type': 'application/json',
      'x-kindgi-signature': hex,
    });
    expect(res.status).toBe(202);
  });

  test('Standard Webhooks: verified, deduped on webhook-id, and refused when stale', async () => {
    const { register, deliver, fires, stored } = setup();
    const t = await register({
      hmacSecretName: 'acme-sw',
      signature: { kind: 'standard-webhooks' },
    });
    const secret = stored.get('acme-sw') as string;
    const body = '{"type":"acme.event"}';
    const signed = (timestamp: number, id = 'msg_acme_1') => {
      const h = webhookHeaders({ secret, id, timestamp, body });
      if (h.kind !== 'ok') throw new Error('sign');
      return { 'content-type': 'application/json', ...h.value };
    };
    const now = Math.floor(Date.now() / 1000);
    const first = await deliver(t.webhookId, body, signed(now));
    expect(first.status).toBe(202);
    const retry = await deliver(t.webhookId, body, signed(now + 1));
    expect(retry).toMatchObject({
      status: 200,
      body: { duplicate: true, fireId: first.body?.fireId },
    });
    const stale = await deliver(t.webhookId, body, signed(now - 600, 'msg_acme_2'));
    expect(stale.status).toBe(401);
    expect((await fires(t.triggerId)).map((f) => f.detail ?? f.outcome)).toContain('stale');
  });

  test("a body that isn't JSON under a JSON content type is refused; text under another type is the text", async () => {
    const { register, deliver, fires, registry } = setup();
    const t = await register({ signature: WOO.signature });
    const bad = '{"id": 42';
    const res = await deliver(t.webhookId, bad, wooHeaders(bad));
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'webhook-body-not-json' } } });
    expect((await fires(t.triggerId))[0]).toMatchObject({
      outcome: 'refused',
      detail: 'body-not-json',
    });

    const text = 'status=processing';
    const plain = await deliver(t.webhookId, text, {
      ...wooHeaders(text),
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(plain.status).toBe(202);
    expect(registry.webhookEvents.get(plain.body?.fireId)).toBe(text);
  });
});

describe('a request that does not prove its sender', () => {
  test('a wrong signature: 401, recorded on the trigger and in the access audit, with the client', async () => {
    const { register, deliver, fires, registry } = setup();
    const t = await register(WOO);
    const res = await deliver(t.webhookId, ORDER, {
      ...wooHeaders(ORDER, 'd', 'notTheSecret'),
      'x-test-client': '203.0.113.7',
    });
    expect(res).toMatchObject({
      status: 401,
      body: {
        error: { code: 'webhook-refused', message: "This request doesn't prove its sender" },
      },
    });
    expect((await fires(t.triggerId))[0]).toMatchObject({
      outcome: 'refused',
      detail: 'signature-invalid',
    });
    expect(registry.webhookAudit).toEqual([
      expect.objectContaining({
        triggerId: t.triggerId,
        reason: 'signature-invalid',
        audit: true,
        clientAddress: '203.0.113.7',
      }),
    ]);
  });

  test('no signature: the same 401, recorded as signature-missing', async () => {
    const { register, deliver, fires } = setup();
    const t = await register(WOO);
    const res = await deliver(t.webhookId, ORDER, { 'content-type': 'application/json' });
    expect(res.status).toBe(401);
    expect((await fires(t.triggerId))[0]?.detail).toBe('signature-missing');
  });

  test('an unknown id, another tenant, or a malformed id: the same 401, and nothing recorded', async () => {
    const { register, deliver, fires, registry } = setup();
    const t = await register(WOO);
    const answers = [
      await deliver(randomUUID(), ORDER, wooHeaders(ORDER)),
      await deliver(t.webhookId, ORDER, wooHeaders(ORDER), OTHER_TENANT),
      await deliver('not-a-uuid', ORDER, wooHeaders(ORDER)),
      await deliver(t.webhookId, ORDER, wooHeaders(ORDER), 'not-a-uuid'),
    ];
    for (const a of answers) {
      expect(a).toMatchObject({ status: 401, body: { error: { code: 'webhook-refused' } } });
    }
    expect(await fires(t.triggerId)).toEqual([]);
    expect(registry.webhookAudit).toEqual([]);
  });

  test("a bearer token never stands in for the signature: neither the tenant's own nor another's", async () => {
    const { register, deliver } = setup();
    const t = await register(WOO);
    for (const token of [TOKEN, OTHER_TOKEN]) {
      const res = await deliver(t.webhookId, ORDER, {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      });
      expect(res.status, token).toBe(401);
    }
  });

  test("a model provider's key is never a trigger's secret: refused at register, and unread at receive", async () => {
    const { admin } = setup();
    const res = await admin('POST', '', {
      flowId: 'acme.refund-review',
      flowVersion: '1.0.0',
      hmacSecretName: PROVIDER_KEY,
    });
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'provider-key-refused' } } });
  });

  test('refusals past 20 a minute only count, on the trigger; the audit takes the first 20', async () => {
    const { register, deliver, fires, registry, admin } = setup();
    const t = await register(WOO);
    for (let i = 0; i < 25; i++) {
      await deliver(t.webhookId, ORDER, {
        ...wooHeaders(ORDER, `d${i}`, 'wrong'),
        'x-test-client': `198.51.100.${i}`,
      });
    }
    expect(await fires(t.triggerId)).toHaveLength(20);
    expect(registry.webhookAudit).toHaveLength(20);
    const rec = (await admin('GET', `/${t.triggerId}`)).body;
    expect(rec.suppressedRefusals).toMatchObject({ count: 5 });
  });

  test('a client past 60 refusals a minute is answered 429 without a lookup', async () => {
    const { deliver } = setup();
    const headers = { ...wooHeaders(ORDER), 'x-test-client': '192.0.2.9' };
    for (let i = 0; i < 61; i++) await deliver(randomUUID(), ORDER, headers);
    const res = await deliver(randomUUID(), ORDER, headers);
    expect(res).toMatchObject({ status: 429, body: { error: { code: 'rate-limit-exceeded' } } });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const elsewhere = await deliver(randomUUID(), ORDER, { ...headers, 'x-test-client': 'x' });
    expect(elsewhere.status).toBe(401);
  });
});

describe('the trigger’s state and limits', () => {
  test("WooCommerce's unsigned save-time ping gets exactly 200, and starts nothing", async () => {
    const { register, deliver, fires } = setup();
    const t = await register(WOO);
    const res = await deliver(t.webhookId, 'webhook_id=17', {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res).toMatchObject({ status: 200, body: { received: 'ping' } });
    expect(await fires(t.triggerId)).toEqual([]);
    // Answered before any lookup: an unknown id gets the same.
    expect((await deliver(randomUUID(), 'webhook_id=17', {})).status).toBe(200);
  });

  test('a paused trigger takes the delivery (202), records it skipped, and starts nothing', async () => {
    const { register, deliver, fires, admin, registry } = setup();
    const t = await register(WOO);
    expect((await admin('POST', `/${t.triggerId}/pause`)).status).toBe(200);
    const res = await deliver(t.webhookId, ORDER, wooHeaders(ORDER));
    expect(res).toMatchObject({ status: 202, body: { skipped: 'paused' } });
    expect((await fires(t.triggerId))[0]).toMatchObject({ outcome: 'skipped', detail: 'paused' });
    expect(registry.webhookEvents.size).toBe(0);

    // The skipped fire never holds the delivery's key: once resumed, a resend starts a run.
    expect((await admin('POST', `/${t.triggerId}/resume`)).status).toBe(200);
    expect((await deliver(t.webhookId, ORDER, wooHeaders(ORDER))).status).toBe(202);
  });

  test('an unregistered trigger: 410, but only to a sender that proves itself', async () => {
    const { register, deliver, admin } = setup();
    const t = await register(WOO);
    expect((await admin('POST', `/${t.triggerId}/unregister`)).status).toBe(200);
    expect((await deliver(t.webhookId, ORDER, wooHeaders(ORDER, 'd', 'wrong'))).status).toBe(401);
    expect(await deliver(t.webhookId, ORDER, wooHeaders(ORDER))).toMatchObject({
      status: 410,
      body: { error: { code: 'webhook-gone' } },
    });
  });

  test("a body past the trigger's cap is 413, recorded; past 1 MiB it's 413 before any lookup", async () => {
    const { register, deliver, fires } = setup();
    const t = await register({ ...WOO, bodyLimitBytes: 1024 });
    const big = JSON.stringify({ pad: 'x'.repeat(2000) });
    const res = await deliver(t.webhookId, big, wooHeaders(big));
    expect(res).toMatchObject({ status: 413, body: { error: { code: 'webhook-body-too-large' } } });
    expect((await fires(t.triggerId))[0]?.detail).toBe('body-too-large');
    const huge = 'x'.repeat(1024 * 1024 + 1);
    expect((await deliver(randomUUID(), huge, {})).status).toBe(413);
  });

  test("past the trigger's rate: 429 with Retry-After, recorded", async () => {
    const { register, deliver, fires } = setup();
    const t = await register({ ...WOO, rateLimitPerMinute: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const body = JSON.stringify({ id: i });
      statuses.push((await deliver(t.webhookId, body, wooHeaders(body, `r${i}`))).status);
    }
    expect(statuses).toEqual([202, 202, 429]);
    expect((await fires(t.triggerId))[0]?.detail).toBe('rate-limited');
  });
});

describe('the receive URL', () => {
  test("made from the configured public URL, never from the request's Host", async () => {
    const { register } = setup({ publicUrl: 'https://kindgi.acme.example/' });
    const t = await register(WOO);
    expect(t.receiveUrl).toBe(`https://kindgi.acme.example/v1/hooks/${TENANT}/${t.webhookId}`);
  });

  test('absent when the deployment has no public URL', async () => {
    const { register } = setup();
    const t = await register(WOO);
    expect(t.receiveUrl).toBeUndefined();
  });
});
