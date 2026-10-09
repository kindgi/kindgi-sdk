// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { isStrongWebhookSecret } from '@kindgi/crypto';
import type {
  Cursor,
  ProjectId,
  TenantId,
  Timestamp,
  WebhookDeliveryId,
  WebhookEndpointId,
  WebhookEventId,
} from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  TokenResolver,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointBinding,
} from '../src/index.js';

/**
 * `/v1/webhook-endpoints` over an in-memory binding: request parsing,
 * outcome → status mapping, serialization, tenant isolation.
 */

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const TOKEN_A = 'webhook-endpoints-token-a';
const TOKEN_B = 'webhook-endpoints-token-b';
const KNOWN_PROJECT = randomUUID() as ProjectId;
const SECRET_REF = { envName: 'local', name: 'ACME_WEBHOOK_SECRET' };

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN_A) return { tenantId: tenantA };
  if (token === TOKEN_B) return { tenantId: tenantB };
  return null;
};

const unused = async () => ({
  kind: 'err' as const,
  error: { code: 'bad-input', message: 'not used in this suite' },
});
const runHandler: RunHandlerBinding = {
  invokeAgent: unused,
  invokeFlow: unused,
  resumeRun: unused,
};

const now = (): Timestamp => new Date().toISOString() as Timestamp;

interface StoredEndpoint {
  tenantId: TenantId;
  endpoint: WebhookEndpoint;
  unregistered: boolean;
  deliveries: WebhookDelivery[];
}

/** A Map-backed binding: enough behavior to exercise every route. */
function makeInMemoryBinding(): WebhookEndpointBinding & {
  readonly rows: Map<string, StoredEndpoint>;
} {
  const rows = new Map<string, StoredEndpoint>();
  const find = (tenantId: TenantId, endpointId: WebhookEndpointId) => {
    const row = rows.get(endpointId as unknown as string);
    return row !== undefined && row.tenantId === tenantId && !row.unregistered ? row : undefined;
  };
  // Secrets the store holds, by name; MISSING and WEAK model the two refusals.
  const secretProblem = (name: string) =>
    name === 'MISSING' ? 'secret-not-found' : name === 'WEAK' ? 'secret-too-weak' : undefined;
  const queue = (row: StoredEndpoint, delivery: WebhookDelivery): WebhookDelivery => {
    row.deliveries.unshift(delivery);
    return delivery;
  };

  return {
    rows,
    async create(input) {
      if (input.url.includes('10.0.0.')) return { kind: 'url-refused', reason: 'private address' };
      if (input.filter.projectId !== undefined && input.filter.projectId !== KNOWN_PROJECT) {
        return { kind: 'project-not-found', projectId: input.filter.projectId };
      }
      const problem = secretProblem(input.secretRef.name);
      if (problem !== undefined) return { kind: problem, secretRef: input.secretRef };
      const endpoint: WebhookEndpoint = {
        endpointId: randomUUID() as WebhookEndpointId,
        url: input.url,
        events: input.events,
        filter: input.filter,
        description: input.description ?? null,
        secretRef: input.secretRef,
        createdAt: now(),
        updatedAt: now(),
      };
      rows.set(endpoint.endpointId as unknown as string, {
        tenantId: input.tenantId,
        endpoint,
        unregistered: false,
        deliveries: [],
      });
      return { kind: 'ok', endpoint };
    },
    async list({ tenantId, limit, cursor }) {
      const mine = [...rows.values()].filter((r) => r.tenantId === tenantId && !r.unregistered);
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = mine.slice(start, start + limit).map((r) => r.endpoint);
      const next = start + limit < mine.length ? (String(start + limit) as Cursor) : undefined;
      return { data: page, ...(next !== undefined && { nextCursor: next }) };
    },
    async get({ tenantId, endpointId }) {
      return find(tenantId, endpointId)?.endpoint ?? null;
    },
    async update(input) {
      const row = find(input.tenantId, input.endpointId);
      if (row === undefined) return { kind: 'not-found' };
      if (input.url?.includes('10.0.0.')) return { kind: 'url-refused', reason: 'private address' };
      const problem =
        input.secretRef === undefined ? undefined : secretProblem(input.secretRef.name);
      if (problem !== undefined && input.secretRef !== undefined) {
        return { kind: problem, secretRef: input.secretRef };
      }
      row.endpoint = {
        ...row.endpoint,
        ...(input.url !== undefined && { url: input.url }),
        ...(input.events !== undefined && { events: input.events }),
        ...(input.filter !== undefined && { filter: input.filter }),
        ...(input.secretRef !== undefined && { secretRef: input.secretRef }),
        ...(input.description !== undefined && { description: input.description }),
        updatedAt: now(),
      };
      return { kind: 'ok', endpoint: row.endpoint };
    },
    async unregister({ tenantId, endpointId }) {
      const row = find(tenantId, endpointId);
      if (row === undefined) return { unregistered: false };
      row.unregistered = true;
      return { unregistered: true };
    },
    async listDeliveries({ tenantId, endpointId, status, limit }) {
      const row = find(tenantId, endpointId);
      if (row === undefined) return { kind: 'not-found' };
      const data = row.deliveries.filter((d) => status === undefined || d.status === status);
      return { kind: 'ok', data: data.slice(0, limit) };
    },
    async redeliver({ tenantId, endpointId, deliveryId }) {
      const row = find(tenantId, endpointId);
      if (row === undefined) return { kind: 'not-found' };
      const index = row.deliveries.findIndex((d) => d.deliveryId === deliveryId);
      const existing = row.deliveries[index];
      if (existing === undefined) return { kind: 'delivery-not-found' };
      const requeued: WebhookDelivery = {
        ...existing,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now(),
      };
      row.deliveries[index] = requeued;
      return { kind: 'ok', delivery: requeued };
    },
    async sendTest({ tenantId, endpointId }) {
      const row = find(tenantId, endpointId);
      if (row === undefined) return { kind: 'not-found' };
      const delivery = queue(row, {
        deliveryId: randomUUID() as WebhookDeliveryId,
        endpointId,
        event: {
          id: randomUUID() as WebhookEventId,
          type: 'webhook.test',
          createdAt: now(),
          data: { endpointId },
        },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now(),
        lastAttemptAt: null,
        lastResponseStatus: null,
        lastError: null,
        createdAt: now(),
        deliveredAt: null,
      });
      return { kind: 'ok', delivery };
    },
  };
}

function makeApp() {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    webhookEndpoints: binding,
  });
  return { app, binding };
}

type App = ReturnType<typeof makeApp>['app'];

async function call(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  token = TOKEN_A,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function createEndpoint(app: App, body: Record<string, unknown> = {}) {
  return call(app, 'POST', '/v1/webhook-endpoints', {
    url: 'https://app.example.com/hooks/kindgi',
    events: ['run.finished'],
    secretRef: SECRET_REF,
    ...body,
  });
}

function errorCode(json: Record<string, unknown>): unknown {
  return (json.error as { code?: unknown } | undefined)?.code;
}

describe('POST /v1/webhook-endpoints', () => {
  test('creates the endpoint, which references its secret by name', async () => {
    const { app } = makeApp();
    const res = await createEndpoint(app, {
      filter: { flowIds: ['acme.order-review', 'acme.order-review'] },
      description: 'Order review results',
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      url: 'https://app.example.com/hooks/kindgi',
      events: ['run.finished'],
      filter: { flowIds: ['acme.order-review'] },
      description: 'Order review results',
      secretRef: SECRET_REF,
    });
    expect(res.json.secret).toBeUndefined();
    const read = await call(app, 'GET', `/v1/webhook-endpoints/${res.json.endpointId as string}`);
    expect(read.json.secretRef).toEqual(SECRET_REF);
  });

  test('a missing or weak secret is refused, naming the reference', async () => {
    const { app } = makeApp();
    const missing = await createEndpoint(app, { secretRef: { envName: 'local', name: 'MISSING' } });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatchObject({
      code: 'webhook-secret-not-found',
      details: { secretRef: { envName: 'local', name: 'MISSING' } },
    });
    const weak = await createEndpoint(app, { secretRef: { envName: 'local', name: 'WEAK' } });
    expect(weak.status).toBe(400);
    expect(errorCode(weak.json)).toBe('webhook-secret-too-weak');
  });

  test('url, events and secretRef are required', async () => {
    const { app } = makeApp();
    const base = {
      url: 'https://app.example.com/hooks',
      events: ['run.finished'],
      secretRef: SECRET_REF,
    };
    for (const field of ['url', 'events', 'secretRef'] as const) {
      const { [field]: _omit, ...body } = base;
      const res = await call(app, 'POST', '/v1/webhook-endpoints', body);
      expect(res.status, field).toBe(400);
    }
  });

  test.each([
    ['a relative URL', { url: '/hooks' }],
    ['a non-http scheme', { url: 'ftp://app.example.com/hooks' }],
    ['credentials in the URL', { url: 'https://user:pass@app.example.com/hooks' }],
    ['an unknown event', { events: ['run.started'] }],
    ['an empty event list', { events: [] }],
    ['a non-object filter', { filter: 'all' }],
    ['an empty flowIds list', { filter: { flowIds: [] } }],
    ['a non-boolean includeDryRuns', { filter: { includeDryRuns: 'yes' } }],
    ['a null description on create', { description: null }],
    ['a secretRef that is not an object', { secretRef: 'ACME_WEBHOOK_SECRET' }],
    ['an invalid envName', { secretRef: { envName: 'Local Env', name: 'X' } }],
    ['an empty secret name', { secretRef: { envName: 'local', name: '' } }],
  ])('400 bad-input for %s', async (_label, body) => {
    const { app } = makeApp();
    const res = await createEndpoint(app, body);
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('bad-input');
  });

  test('400 unknown-field for unknown body and filter fields', async () => {
    const { app } = makeApp();
    const top = await createEndpoint(app, { headers: { 'x-extra': '1' } });
    expect(top.status).toBe(400);
    expect(errorCode(top.json)).toBe('unknown-field');
    const nested = await createEndpoint(app, { filter: { agentIds: ['a'] } });
    expect(nested.status).toBe(400);
    expect(errorCode(nested.json)).toBe('unknown-field');
    const inRef = await createEndpoint(app, { secretRef: { ...SECRET_REF, version: 2 } });
    expect(inRef.status).toBe(400);
    expect(errorCode(inRef.json)).toBe('unknown-field');
  });

  test('400 for a body that is not a JSON object', async () => {
    const { app } = makeApp();
    const res = await call(app, 'POST', '/v1/webhook-endpoints', '[1,2]');
    expect(res.status).toBe(400);
  });

  test('the deployment refusing the URL is 400 webhook-url-refused, with the reason', async () => {
    const { app } = makeApp();
    const res = await createEndpoint(app, { url: 'https://10.0.0.7/hooks' });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({
      code: 'webhook-url-refused',
      details: { reason: 'private address' },
    });
  });

  test('an unknown filter project is 404 project-not-found', async () => {
    const { app } = makeApp();
    const res = await createEndpoint(app, { filter: { projectId: randomUUID() } });
    expect(res.status).toBe(404);
    expect(errorCode(res.json)).toBe('project-not-found');
    const known = await createEndpoint(app, { filter: { projectId: KNOWN_PROJECT } });
    expect(known.status).toBe(201);
  });
});

describe('list, get, update, unregister', () => {
  test('lists with a cursor', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 3; i += 1) await createEndpoint(app, { description: `#${i}` });
    const first = await call(app, 'GET', '/v1/webhook-endpoints?limit=2');
    expect(first.status).toBe(200);
    expect((first.json.data as unknown[]).length).toBe(2);
    expect(first.json.hasMore).toBe(true);
    const second = await call(
      app,
      'GET',
      `/v1/webhook-endpoints?limit=2&cursor=${first.json.nextCursor as string}`,
    );
    expect((second.json.data as unknown[]).length).toBe(1);
    expect(second.json.hasMore).toBe(false);
  });

  test("another tenant's endpoint is 404, never 403", async () => {
    const { app } = makeApp();
    const created = await createEndpoint(app);
    const id = created.json.endpointId as string;
    const res = await call(app, 'GET', `/v1/webhook-endpoints/${id}`, undefined, TOKEN_B);
    expect(res.status).toBe(404);
    expect(errorCode(res.json)).toBe('webhook-endpoint-not-found');
    const list = await call(app, 'GET', '/v1/webhook-endpoints', undefined, TOKEN_B);
    expect(list.json.data).toEqual([]);
  });

  test('PATCH changes the given fields; description null clears it', async () => {
    const { app } = makeApp();
    const created = await createEndpoint(app, { description: 'old' });
    const id = created.json.endpointId as string;
    const res = await call(app, 'PATCH', `/v1/webhook-endpoints/${id}`, {
      url: 'https://app.example.com/hooks/v2',
      description: null,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      url: 'https://app.example.com/hooks/v2',
      events: ['run.finished'],
      description: null,
    });
  });

  test('PATCH maps not-found and url-refused', async () => {
    const { app } = makeApp();
    const missing = await call(app, 'PATCH', `/v1/webhook-endpoints/${randomUUID()}`, {
      description: 'x',
    });
    expect(missing.status).toBe(404);
    const created = await createEndpoint(app);
    const id = created.json.endpointId as string;
    const refused = await call(app, 'PATCH', `/v1/webhook-endpoints/${id}`, {
      url: 'https://10.0.0.9/hooks',
    });
    expect(refused.status).toBe(400);
    expect(errorCode(refused.json)).toBe('webhook-url-refused');
  });

  test('unregister is idempotent, and the endpoint is gone afterwards', async () => {
    const { app } = makeApp();
    const created = await createEndpoint(app);
    const id = created.json.endpointId as string;
    const first = await call(app, 'POST', `/v1/webhook-endpoints/${id}/unregister`);
    expect(first.json).toEqual({ endpointId: id, unregistered: true });
    const again = await call(app, 'POST', `/v1/webhook-endpoints/${id}/unregister`);
    expect(again.json).toEqual({ endpointId: id, unregistered: false });
    const read = await call(app, 'GET', `/v1/webhook-endpoints/${id}`);
    expect(read.status).toBe(404);
  });
});

describe('POST /v1/webhook-endpoints/generate-secret', () => {
  test('returns a new strong secret each time; nothing is stored', async () => {
    const { app, binding } = makeApp();
    const a = await call(app, 'POST', '/v1/webhook-endpoints/generate-secret');
    const b = await call(app, 'POST', '/v1/webhook-endpoints/generate-secret');
    expect(a.status).toBe(200);
    const secret = a.json.secret as string;
    expect(secret.startsWith('whsec_')).toBe(true);
    expect(isStrongWebhookSecret(secret)).toBe(true);
    expect(b.json.secret).not.toBe(secret);
    expect(binding.rows.size).toBe(0);
  });

  test('with an Idempotency-Key, a retry gets 409 replay-withheld, never the secret again (T392)', async () => {
    const { app } = makeApp();
    const send = () =>
      app.request('/v1/webhook-endpoints/generate-secret', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN_A}`, 'idempotency-key': 'gen-1' },
      });
    const first = await send();
    const { secret } = (await first.json()) as { secret: string };
    expect(first.status).toBe(200);
    const again = await send();
    expect(again.status).toBe(409);
    const text = await again.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).error.code).toBe('idempotency-key-replay-withheld');
  });
});

describe('PATCH secretRef', () => {
  test('points the endpoint at another secret, checked like on create', async () => {
    const { app } = makeApp();
    const created = await createEndpoint(app);
    const id = created.json.endpointId as string;
    const moved = await call(app, 'PATCH', `/v1/webhook-endpoints/${id}`, {
      secretRef: { envName: 'prod', name: 'ACME_WEBHOOK_SECRET_V2' },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.secretRef).toEqual({ envName: 'prod', name: 'ACME_WEBHOOK_SECRET_V2' });
    const missing = await call(app, 'PATCH', `/v1/webhook-endpoints/${id}`, {
      secretRef: { envName: 'prod', name: 'MISSING' },
    });
    expect(errorCode(missing.json)).toBe('webhook-secret-not-found');
  });
});

describe('deliveries, test events, redelivery', () => {
  test('a test event is queued (202) and shows in the delivery log', async () => {
    const { app } = makeApp();
    const created = await createEndpoint(app);
    const id = created.json.endpointId as string;
    const sent = await call(app, 'POST', `/v1/webhook-endpoints/${id}/test`);
    expect(sent.status).toBe(202);
    expect(sent.json).toMatchObject({
      endpointId: id,
      status: 'pending',
      event: { type: 'webhook.test', data: { endpointId: id } },
    });

    const log = await call(app, 'GET', `/v1/webhook-endpoints/${id}/deliveries?status=pending`);
    expect(log.status).toBe(200);
    expect((log.json.data as unknown[]).length).toBe(1);
    expect(log.json.hasMore).toBe(false);
    const delivered = await call(
      app,
      'GET',
      `/v1/webhook-endpoints/${id}/deliveries?status=delivered`,
    );
    expect(delivered.json.data).toEqual([]);
  });

  test('an unknown delivery status filter is 400', async () => {
    const { app } = makeApp();
    const created = await createEndpoint(app);
    const id = created.json.endpointId as string;
    const res = await call(app, 'GET', `/v1/webhook-endpoints/${id}/deliveries?status=dead`);
    expect(res.status).toBe(400);
  });

  test('redeliver re-queues; unknown endpoint and unknown delivery are 404 with their codes', async () => {
    const { app } = makeApp();
    const created = await createEndpoint(app);
    const id = created.json.endpointId as string;
    const sent = await call(app, 'POST', `/v1/webhook-endpoints/${id}/test`);
    const deliveryId = sent.json.deliveryId as string;

    const ok = await call(
      app,
      'POST',
      `/v1/webhook-endpoints/${id}/deliveries/${deliveryId}/redeliver`,
    );
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ deliveryId, status: 'pending', attempts: 0 });

    const noDelivery = await call(
      app,
      'POST',
      `/v1/webhook-endpoints/${id}/deliveries/${randomUUID()}/redeliver`,
    );
    expect(noDelivery.status).toBe(404);
    expect(errorCode(noDelivery.json)).toBe('webhook-delivery-not-found');

    const noEndpoint = await call(
      app,
      'POST',
      `/v1/webhook-endpoints/${randomUUID()}/deliveries/${deliveryId}/redeliver`,
    );
    expect(noEndpoint.status).toBe(404);
    expect(errorCode(noEndpoint.json)).toBe('webhook-endpoint-not-found');

    const log = await call(app, 'GET', `/v1/webhook-endpoints/${randomUUID()}/deliveries`);
    expect(log.status).toBe(404);
  });
});

describe('mounting', () => {
  test('without a binding, the routes are not mounted', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/webhook-endpoints', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
  });
});
