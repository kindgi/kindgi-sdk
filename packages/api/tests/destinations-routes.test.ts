// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type {
  Cursor,
  DestinationDeliveryId,
  DestinationId,
  EnvName,
  ProjectId,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, destinationUrlSecretName } from '../src/index.js';
import type {
  Destination,
  DestinationBinding,
  DestinationCreateInput,
  DestinationDelivery,
  DestinationRefusal,
  DestinationSecretRef,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { serializeDestinationDelivery } from '../src/routes/destinations.js';

/**
 * `/v1/destinations` over an in-memory binding: request parsing, the
 * kind's rules, outcome -> status mapping, serialization (the URL is never
 * returned), the project-scoped list and tenant isolation.
 */

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const TOKEN_A = 'destinations-token-a';
const TOKEN_B = 'destinations-token-b';
const TOKEN_MEMBER = 'destinations-token-member';
const KNOWN_PROJECT = randomUUID() as ProjectId;
const OTHER_PROJECT = randomUUID() as ProjectId;
const KNOWN_PERSON = randomUUID() as UserId;
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/acme-private-path';
const URL_REF = { envName: 'local', name: 'ACME_SLACK_URL' };
const SECRET_REF = { envName: 'local', name: 'ACME_WEBHOOK_SECRET' };

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN_A) return { tenantId: tenantA, scopes: ['tenant-admin'] };
  if (token === TOKEN_B) return { tenantId: tenantB, scopes: ['tenant-admin'] };
  if (token === TOKEN_MEMBER) return { tenantId: tenantA, userId: KNOWN_PERSON };
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

interface StoredDestination {
  tenantId: TenantId;
  /** What the binding holds, its URL included: the routes must drop it. */
  destination: Destination & { readonly url?: string };
  removed: boolean;
  deliveries: DestinationDelivery[];
}

interface BindingOptions {
  /** `email` destinations are refused `kind-off`, as on a deployment without mail. */
  readonly mailOff?: boolean;
}

/** Secrets the store holds, by name; MISSING and WEAK model the two refusals. */
function secretProblem(
  secret: DestinationSecretRef | undefined,
): Extract<DestinationRefusal, { kind: 'secret-not-found' | 'secret-too-weak' }> | undefined {
  if (secret?.name === 'MISSING') return { kind: 'secret-not-found', secretRef: secret };
  if (secret?.name === 'WEAK') return { kind: 'secret-too-weak', secretRef: secret };
  return undefined;
}

/** The binding's own checks, in the order a runtime would make them. */
function refusalOf(
  input: Pick<DestinationCreateInput, 'url' | 'people' | 'urlRef' | 'secretRef'> & {
    readonly projects?: readonly ProjectId[] | null;
  },
): DestinationRefusal | undefined {
  if (input.url?.includes('10.0.0.')) return { kind: 'url-refused', reason: 'private address' };
  const project = input.projects?.find((p) => p !== KNOWN_PROJECT && p !== OTHER_PROJECT);
  if (project !== undefined) return { kind: 'project-not-found', projectId: project };
  const person = input.people?.find((p) => p !== KNOWN_PERSON);
  if (person !== undefined) return { kind: 'person-not-found', userId: person };
  return secretProblem(input.urlRef) ?? secretProblem(input.secretRef);
}

function urlFields(
  destinationId: DestinationId,
  url: string | undefined,
  urlRef: DestinationSecretRef | undefined,
): Pick<Destination, 'host' | 'urlRef'> & { readonly url?: string } {
  if (url !== undefined) {
    return {
      url,
      host: new URL(url).host,
      urlRef: { envName: 'local' as EnvName, name: destinationUrlSecretName(destinationId) },
    };
  }
  if (urlRef !== undefined) return { host: 'stored.example.com', urlRef };
  return {};
}

function delivery(
  destinationId: DestinationId,
  fields: Partial<DestinationDelivery> = {},
): DestinationDelivery {
  return {
    deliveryId: randomUUID() as DestinationDeliveryId,
    to: destinationId,
    event: 'destination.test',
    scheduleId: null,
    runId: null,
    approvalId: null,
    status: 'pending',
    reason: null,
    attempts: 0,
    nextAttemptAt: now(),
    lastAttemptAt: null,
    lastResponseStatus: null,
    lastError: null,
    createdAt: now(),
    deliveredAt: null,
    ...fields,
  };
}

/** A Map-backed binding: enough behavior to exercise every route. */
function makeInMemoryBinding(options: BindingOptions = {}): DestinationBinding & {
  readonly rows: Map<string, StoredDestination>;
} {
  const rows = new Map<string, StoredDestination>();
  const find = (tenantId: TenantId, destinationId: DestinationId) => {
    const row = rows.get(destinationId as unknown as string);
    return row !== undefined && row.tenantId === tenantId && !row.removed ? row : undefined;
  };

  return {
    rows,
    async create(input) {
      if (options.mailOff === true && input.kind === 'email') {
        return {
          kind: 'kind-off',
          destinationKind: 'email',
          setting: 'KINDGI_AUTH_EMAIL_SMTP_URL',
        };
      }
      const refusal = refusalOf(input);
      if (refusal !== undefined) return refusal;
      const destinationId = randomUUID() as DestinationId;
      const destination: StoredDestination['destination'] = {
        destinationId,
        name: input.name,
        kind: input.kind,
        ...(input.people !== undefined && { people: input.people }),
        ...urlFields(destinationId, input.url, input.urlRef),
        ...(input.secretRef !== undefined && { secretRef: input.secretRef }),
        ...(input.projects !== undefined && { projects: input.projects }),
        content: input.content,
        status: 'active',
        lastError: null,
        createdAt: now(),
        updatedAt: now(),
      };
      rows.set(destinationId as unknown as string, {
        tenantId: input.tenantId,
        destination,
        removed: false,
        deliveries: [],
      });
      return { kind: 'ok', destination };
    },
    async list({ tenantId, limit, cursor, projectId }) {
      const mine = [...rows.values()]
        .filter((r) => r.tenantId === tenantId && !r.removed)
        .filter(
          (r) =>
            projectId === undefined ||
            r.destination.projects === undefined ||
            r.destination.projects.includes(projectId),
        );
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = mine.slice(start, start + limit).map((r) => r.destination);
      const next = start + limit < mine.length ? (String(start + limit) as Cursor) : undefined;
      return { data: page, ...(next !== undefined && { nextCursor: next }) };
    },
    async get({ tenantId, destinationId }) {
      return find(tenantId, destinationId)?.destination ?? null;
    },
    async update(input) {
      const row = find(input.tenantId, input.destinationId);
      if (row === undefined) return { kind: 'not-found' };
      const refusal = refusalOf(input);
      if (refusal !== undefined) return refusal;
      const { projects: _projects, ...kept } = row.destination;
      const projects = input.projects === undefined ? row.destination.projects : input.projects;
      row.destination = {
        ...kept,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.people !== undefined && { people: input.people }),
        ...urlFields(input.destinationId, input.url, input.urlRef),
        ...(input.secretRef !== undefined && { secretRef: input.secretRef }),
        ...(projects != null && { projects }),
        ...(input.content !== undefined && { content: input.content }),
        updatedAt: now(),
      };
      return { kind: 'ok', destination: row.destination };
    },
    async remove({ tenantId, destinationId }) {
      const row = find(tenantId, destinationId);
      if (row === undefined) return { removed: false };
      row.removed = true;
      return { removed: true };
    },
    async listDeliveries({ tenantId, destinationId, status, limit }) {
      const row = find(tenantId, destinationId);
      if (row === undefined) return { kind: 'not-found' };
      const data = row.deliveries.filter((d) => status === undefined || d.status === status);
      return { kind: 'ok', data: data.slice(0, limit) };
    },
    async redeliver({ tenantId, destinationId, deliveryId }) {
      const row = find(tenantId, destinationId);
      if (row === undefined) return { kind: 'not-found' };
      const index = row.deliveries.findIndex((d) => d.deliveryId === deliveryId);
      const existing = row.deliveries[index];
      if (existing === undefined) return { kind: 'delivery-not-found' };
      const requeued: DestinationDelivery = {
        ...existing,
        status: 'pending',
        reason: null,
        attempts: 0,
        nextAttemptAt: now(),
      };
      row.deliveries[index] = requeued;
      return { kind: 'ok', delivery: requeued };
    },
    async sendTest({ tenantId, destinationId }) {
      const row = find(tenantId, destinationId);
      if (row === undefined) return { kind: 'not-found' };
      const queued = delivery(destinationId);
      row.deliveries.unshift(queued);
      return { kind: 'ok', delivery: queued };
    },
    async listScheduleDeliveries() {
      return { kind: 'ok', data: [] };
    },
  };
}

function makeApp(options: BindingOptions = {}) {
  const binding = makeInMemoryBinding(options);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    destinations: binding,
  });
  return { app, binding };
}

type App = ReturnType<typeof makeApp>['app'];

async function request(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  token = TOKEN_A,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function call(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  token = TOKEN_A,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await request(app, method, path, body, token);
  const text = await res.text();
  return {
    status: res.status,
    json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    text,
  };
}

const SLACK = { name: 'Acme ops channel', kind: 'slack', url: SLACK_URL };
const WEBHOOK = {
  name: 'Acme receiver',
  kind: 'webhook',
  urlRef: URL_REF,
  secretRef: SECRET_REF,
};
const EMAIL = { name: 'Acme reviewers', kind: 'email', people: [KNOWN_PERSON] };

async function create(app: App, body: Record<string, unknown> = SLACK) {
  return call(app, 'POST', '/v1/destinations', body);
}

async function createId(app: App, body: Record<string, unknown> = SLACK): Promise<string> {
  const res = await create(app, body);
  expect(res.status).toBe(201);
  return res.json.destinationId as string;
}

function errorCode(json: Record<string, unknown>): unknown {
  return (json.error as { code?: unknown } | undefined)?.code;
}

function errorOf(json: Record<string, unknown>): { message?: string; details?: unknown } {
  return (json.error ?? {}) as { message?: string; details?: unknown };
}

describe('POST /v1/destinations', () => {
  test('a slack destination keeps its URL out of the answer: host and urlRef say where it goes', async () => {
    const { app } = makeApp();
    const res = await create(app);
    expect(res.status).toBe(201);
    const id = res.json.destinationId as string;
    expect(res.json).toEqual({
      destinationId: id,
      name: 'Acme ops channel',
      kind: 'slack',
      host: 'hooks.slack.com',
      urlRef: { envName: 'local', name: `kindgi.destination.${id}` },
      content: 'link',
      status: 'active',
      lastError: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(res.text).not.toContain('acme-private-path');
  });

  test('a webhook destination takes urlRef and its signing secret by reference', async () => {
    const { app } = makeApp();
    const res = await create(app, WEBHOOK);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ kind: 'webhook', urlRef: URL_REF, secretRef: SECRET_REF });
  });

  test('an email destination goes to people, each kept once; it has no host', async () => {
    const { app } = makeApp();
    const res = await create(app, { ...EMAIL, people: [KNOWN_PERSON, KNOWN_PERSON] });
    expect(res.status).toBe(201);
    expect(res.json.people).toEqual([KNOWN_PERSON]);
    expect(res.json.host).toBeUndefined();
    expect(res.json.urlRef).toBeUndefined();
  });

  test('`answer` content is taken on a destination that names its projects', async () => {
    const { app } = makeApp();
    const res = await create(app, {
      ...SLACK,
      content: 'answer',
      projects: [KNOWN_PROJECT, KNOWN_PROJECT],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ content: 'answer', projects: [KNOWN_PROJECT] });
  });

  test.each([
    ['no name', { kind: 'slack', url: SLACK_URL }, '`name` is required'],
    ['an empty name', { ...SLACK, name: '  ' }, undefined],
    ['a name over 100 characters', { ...SLACK, name: 'a'.repeat(101) }, undefined],
    ['no kind', { name: 'x', url: SLACK_URL }, undefined],
    ['an unknown kind', { ...SLACK, kind: 'sms' }, undefined],
    ['an unknown content', { ...SLACK, content: 'full' }, undefined],
    ['a url on email', { ...EMAIL, url: SLACK_URL }, undefined],
    ['a urlRef on email', { ...EMAIL, urlRef: URL_REF }, undefined],
    ['a secretRef on email', { ...EMAIL, secretRef: SECRET_REF }, undefined],
    [
      'email without people',
      { name: 'x', kind: 'email' },
      'An `email` destination needs `people`: the workspace members it goes to',
    ],
    ['people on slack', { ...SLACK, people: [KNOWN_PERSON] }, undefined],
    ['both url and urlRef', { ...SLACK, urlRef: URL_REF }, 'Give `url` or `urlRef`, not both'],
    ['neither url nor urlRef', { name: 'x', kind: 'teams' }, undefined],
    ['a secretRef on slack', { ...SLACK, secretRef: SECRET_REF }, undefined],
    [
      'a webhook without secretRef',
      { name: 'x', kind: 'webhook', urlRef: URL_REF },
      'A `webhook` destination needs `secretRef`: its signing secret, by reference',
    ],
    [
      'answer on a webhook',
      { ...WEBHOOK, content: 'answer', projects: [KNOWN_PROJECT] },
      undefined,
    ],
    ['answer without projects', { ...SLACK, content: 'answer' }, undefined],
    ['an http url', { ...SLACK, url: 'http://hooks.slack.com/services/x' }, undefined],
    ['a relative url', { ...SLACK, url: '/services/x' }, undefined],
    ['credentials in the url', { ...SLACK, url: 'https://u:p@hooks.slack.com/x' }, undefined],
    [
      'a url over 2048 characters',
      { ...SLACK, url: `https://a.example/${'a'.repeat(2048)}` },
      undefined,
    ],
    ['people that are not a list', { ...EMAIL, people: KNOWN_PERSON }, undefined],
    ['an empty people list', { ...EMAIL, people: [] }, undefined],
    ['people that are not ids', { ...EMAIL, people: ['alice'] }, undefined],
    ['an empty projects list', { ...SLACK, projects: [] }, undefined],
    ['projects null on create', { ...SLACK, projects: null }, undefined],
    ['a urlRef that is not an object', { name: 'x', kind: 'slack', urlRef: 'ACME' }, undefined],
    [
      'an invalid envName',
      { name: 'x', kind: 'slack', urlRef: { envName: 'Local Env', name: 'X' } },
      undefined,
    ],
  ])('400 bad-input for %s', async (_label, body, message) => {
    const { app } = makeApp();
    const res = await create(app, body);
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('bad-input');
    if (message !== undefined) expect(errorOf(res.json).message).toBe(message);
  });

  test('400 unknown-field for an unknown body field and an unknown reference field', async () => {
    const { app } = makeApp();
    const top = await create(app, { ...SLACK, channel: '#ops' });
    expect(top.status).toBe(400);
    expect(errorCode(top.json)).toBe('unknown-field');
    const nested = await create(app, {
      ...WEBHOOK,
      secretRef: { ...SECRET_REF, version: 2 },
    });
    expect(nested.status).toBe(400);
    expect(errorCode(nested.json)).toBe('unknown-field');
  });

  test('400 for a body that is not a JSON object', async () => {
    const { app } = makeApp();
    const res = await call(app, 'POST', '/v1/destinations', '[]');
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('bad-input');
  });

  test('a reserved `kindgi.` name is refused for urlRef and secretRef', async () => {
    const { app } = makeApp();
    const url = await create(app, {
      ...WEBHOOK,
      urlRef: { envName: 'local', name: 'kindgi.destination.x' },
    });
    expect(url.status).toBe(400);
    expect(errorCode(url.json)).toBe('reserved-name-prefix');
    const secret = await create(app, {
      ...WEBHOOK,
      secretRef: { envName: 'local', name: 'kindgi.any' },
    });
    expect(secret.status).toBe(400);
    expect(errorCode(secret.json)).toBe('reserved-name-prefix');
  });
});

describe("the binding's refusals", () => {
  test('a refused URL is 400 destination-url-refused, with the reason', async () => {
    const { app } = makeApp();
    const res = await create(app, { ...SLACK, url: 'https://10.0.0.5/hook' });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({
      code: 'destination-url-refused',
      details: { reason: 'private address' },
    });
  });

  test('a kind the deployment lacks is 400 bad-input, naming the setting', async () => {
    const { app } = makeApp({ mailOff: true });
    const res = await create(app, EMAIL);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({
      code: 'bad-input',
      message: '`email` destinations need `KINDGI_AUTH_EMAIL_SMTP_URL`',
      details: { destinationKind: 'email', setting: 'KINDGI_AUTH_EMAIL_SMTP_URL' },
    });
  });

  test('an unknown project is 404 project-not-found', async () => {
    const { app } = makeApp();
    const unknown = randomUUID();
    const res = await create(app, { ...SLACK, projects: [unknown] });
    expect(res.status).toBe(404);
    expect(res.json.error).toMatchObject({
      code: 'project-not-found',
      details: { projectId: unknown },
    });
  });

  test('someone who is not a member is 400 bad-input, naming them', async () => {
    const { app } = makeApp();
    const stranger = randomUUID();
    const res = await create(app, { ...EMAIL, people: [stranger] });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'bad-input', details: { userId: stranger } });
  });

  test('a missing or weak secret is refused, naming the reference', async () => {
    const { app } = makeApp();
    const missing = await create(app, {
      ...WEBHOOK,
      urlRef: { envName: 'local', name: 'MISSING' },
    });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatchObject({
      code: 'destination-secret-not-found',
      details: { secretRef: { envName: 'local', name: 'MISSING' } },
    });
    const weak = await create(app, { ...WEBHOOK, secretRef: { envName: 'local', name: 'WEAK' } });
    expect(weak.status).toBe(400);
    expect(weak.json.error).toMatchObject({
      code: 'destination-secret-too-weak',
      details: { secretRef: { envName: 'local', name: 'WEAK' } },
    });
  });
});

describe('list, get, update, remove', () => {
  test('lists with a cursor', async () => {
    const { app } = makeApp();
    await createId(app);
    await createId(app, WEBHOOK);
    const first = await call(app, 'GET', '/v1/destinations?limit=1');
    expect(first.status).toBe(200);
    expect(first.json.hasMore).toBe(true);
    expect((first.json.data as unknown[]).length).toBe(1);
    const second = await call(
      app,
      'GET',
      `/v1/destinations?limit=1&cursor=${first.json.nextCursor as string}`,
    );
    expect(second.json.hasMore).toBe(false);
    expect(second.json.nextCursor).toBeUndefined();
    expect((second.json.data as unknown[]).length).toBe(1);
  });

  test('get answers the destination; the URL is never in it', async () => {
    const { app } = makeApp();
    const id = await createId(app);
    const res = await call(app, 'GET', `/v1/destinations/${id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ destinationId: id, host: 'hooks.slack.com' });
    expect(res.json.url).toBeUndefined();
    expect(res.text).not.toContain('acme-private-path');
  });

  test("another tenant's destination is 404, never 403", async () => {
    const { app } = makeApp();
    const id = await createId(app);
    const res = await call(app, 'GET', `/v1/destinations/${id}`, undefined, TOKEN_B);
    expect(res.status).toBe(404);
    expect(res.json.error).toMatchObject({
      code: 'destination-not-found',
      details: { destinationId: id },
    });
  });

  test('PATCH changes the given fields; a new url rotates the stored one', async () => {
    const { app } = makeApp();
    const id = await createId(app, { ...SLACK, projects: [KNOWN_PROJECT] });
    const res = await call(app, 'PATCH', `/v1/destinations/${id}`, {
      name: 'Acme night shift',
      url: 'https://hooks.slack.com/services/T000/B000/rotated-path',
      content: 'answer',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      name: 'Acme night shift',
      host: 'hooks.slack.com',
      content: 'answer',
      projects: [KNOWN_PROJECT],
    });
    expect(res.text).not.toContain('rotated-path');
  });

  test('PATCH projects null opens it to every project again', async () => {
    const { app } = makeApp();
    const id = await createId(app, { ...SLACK, projects: [KNOWN_PROJECT] });
    const res = await call(app, 'PATCH', `/v1/destinations/${id}`, { projects: null });
    expect(res.status).toBe(200);
    expect(res.json.projects).toBeUndefined();
  });

  test('PATCH swaps url for urlRef', async () => {
    const { app } = makeApp();
    const id = await createId(app);
    const res = await call(app, 'PATCH', `/v1/destinations/${id}`, { urlRef: URL_REF });
    expect(res.status).toBe(200);
    expect(res.json.urlRef).toEqual(URL_REF);
  });

  test.each([
    [
      'any kind',
      SLACK,
      { kind: 'slack' },
      "`kind` can't change: make a destination of the other kind",
    ],
    [
      'people on slack',
      SLACK,
      { people: [KNOWN_PERSON] },
      '`people` is for an `email` destination only',
    ],
    ['a url on email', EMAIL, { url: SLACK_URL }, undefined],
    ['answer without projects', SLACK, { content: 'answer' }, undefined],
    ['answer on a webhook', WEBHOOK, { content: 'answer', projects: [KNOWN_PROJECT] }, undefined],
    [
      'clearing the projects of an answer destination',
      { ...SLACK, content: 'answer', projects: [KNOWN_PROJECT] },
      { projects: null },
      undefined,
    ],
    ['both url and urlRef', SLACK, { url: SLACK_URL, urlRef: URL_REF }, undefined],
    ['an empty name', SLACK, { name: '' }, undefined],
  ])(
    'PATCH: 400 bad-input for %s, judged on what it would be',
    async (_label, base, patch, message) => {
      const { app } = makeApp();
      const id = await createId(app, base);
      const res = await call(app, 'PATCH', `/v1/destinations/${id}`, patch);
      expect(res.status).toBe(400);
      expect(errorCode(res.json)).toBe('bad-input');
      if (message !== undefined) expect(errorOf(res.json).message).toBe(message);
    },
  );

  test("PATCH maps not-found and the binding's refusals", async () => {
    const { app } = makeApp();
    const missing = await call(app, 'PATCH', `/v1/destinations/${randomUUID()}`, { name: 'x' });
    expect(missing.status).toBe(404);
    expect(errorCode(missing.json)).toBe('destination-not-found');
    const id = await createId(app);
    const refused = await call(app, 'PATCH', `/v1/destinations/${id}`, {
      url: 'https://10.0.0.9/hook',
    });
    expect(refused.status).toBe(400);
    expect(errorCode(refused.json)).toBe('destination-url-refused');
    const unknown = await call(app, 'PATCH', `/v1/destinations/${id}`, { color: 'red' });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown.json)).toBe('unknown-field');
  });

  test('DELETE is 204 with no body; the destination is gone afterwards', async () => {
    const { app } = makeApp();
    const id = await createId(app);
    const res = await request(app, 'DELETE', `/v1/destinations/${id}`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect((await call(app, 'GET', `/v1/destinations/${id}`)).status).toBe(404);
    const again = await call(app, 'DELETE', `/v1/destinations/${id}`);
    expect(again.status).toBe(404);
    expect(errorCode(again.json)).toBe('destination-not-found');
  });
});

describe('deliveries, test messages, redelivery', () => {
  test('a test message is queued (202) and shows in the delivery log', async () => {
    const { app } = makeApp();
    const id = await createId(app);
    const sent = await call(app, 'POST', `/v1/destinations/${id}/test`);
    expect(sent.status).toBe(202);
    expect(sent.json).toMatchObject({
      to: id,
      event: 'destination.test',
      scheduleId: null,
      runId: null,
      status: 'pending',
    });
    const log = await call(app, 'GET', `/v1/destinations/${id}/deliveries`);
    expect(log.status).toBe(200);
    expect(log.json).toEqual({ data: [sent.json], hasMore: false });
    const pending = await call(app, 'GET', `/v1/destinations/${id}/deliveries?status=pending`);
    expect((pending.json.data as unknown[]).length).toBe(1);
    const skipped = await call(app, 'GET', `/v1/destinations/${id}/deliveries?status=skipped`);
    expect(skipped.json.data).toEqual([]);
  });

  test('an unknown delivery status filter is 400', async () => {
    const { app } = makeApp();
    const id = await createId(app);
    const res = await call(app, 'GET', `/v1/destinations/${id}/deliveries?status=lost`);
    expect(res.status).toBe(400);
    expect(errorOf(res.json).message).toBe(
      '`status` must be one of pending, delivered, failed, skipped',
    );
  });

  test('redeliver re-queues; unknown destination and unknown delivery are 404 with their codes', async () => {
    const { app, binding } = makeApp();
    const id = await createId(app);
    const row = binding.rows.get(id);
    const failed = delivery(id as DestinationId, {
      event: 'run.finished',
      status: 'failed',
      reason: 'timeout',
      attempts: 5,
    });
    row?.deliveries.push(failed);
    const res = await call(
      app,
      'POST',
      `/v1/destinations/${id}/deliveries/${failed.deliveryId as unknown as string}/redeliver`,
    );
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ status: 'pending', attempts: 0, reason: null });

    const noDelivery = await call(
      app,
      'POST',
      `/v1/destinations/${id}/deliveries/${randomUUID()}/redeliver`,
    );
    expect(noDelivery.status).toBe(404);
    expect(errorCode(noDelivery.json)).toBe('destination-delivery-not-found');

    const other = randomUUID();
    for (const [method, path] of [
      ['POST', `/v1/destinations/${other}/deliveries/${randomUUID()}/redeliver`],
      ['POST', `/v1/destinations/${other}/test`],
      ['GET', `/v1/destinations/${other}/deliveries`],
    ] as const) {
      const res404 = await call(app, method, path);
      expect(res404.status, path).toBe(404);
      expect(errorCode(res404.json), path).toBe('destination-not-found');
    }
  });

  test('serializeDestinationDelivery answers the wire fields, and only those', () => {
    const d = delivery(randomUUID() as DestinationId);
    const extra = { ...d, url: SLACK_URL } as DestinationDelivery;
    expect(Object.keys(serializeDestinationDelivery(extra))).toEqual([
      'deliveryId',
      'to',
      'event',
      'scheduleId',
      'runId',
      'approvalId',
      'status',
      'reason',
      'attempts',
      'nextAttemptAt',
      'lastAttemptAt',
      'lastResponseStatus',
      'lastError',
      'createdAt',
      'deliveredAt',
    ]);
  });
});

describe('the URL never leaves the server', () => {
  test('a binding that hands back its URL does not put it in any answer', async () => {
    const { app, binding } = makeApp();
    const id = await createId(app);
    expect(binding.rows.get(id)?.destination.url).toBe(SLACK_URL);
    const answers = [
      await call(app, 'GET', '/v1/destinations'),
      await call(app, 'GET', `/v1/destinations?projectId=${KNOWN_PROJECT}`),
      await call(
        app,
        'GET',
        `/v1/destinations?projectId=${KNOWN_PROJECT}`,
        undefined,
        TOKEN_MEMBER,
      ),
      await call(app, 'GET', `/v1/destinations/${id}`),
      await call(app, 'PATCH', `/v1/destinations/${id}`, { name: 'renamed' }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.text).not.toContain('acme-private-path');
      expect(answer.text).not.toContain('"url"');
    }
  });
});

describe('who may call', () => {
  test.each([
    ['POST', '/v1/destinations'],
    ['GET', '/v1/destinations'],
    ['GET', '/v1/destinations/d'],
    ['PATCH', '/v1/destinations/d'],
    ['DELETE', '/v1/destinations/d'],
    ['GET', '/v1/destinations/d/deliveries'],
    ['POST', '/v1/destinations/d/deliveries/x/redeliver'],
    ['POST', '/v1/destinations/d/test'],
  ])("%s %s is a tenant admin's: 403 for a member", async (method, path) => {
    const { app } = makeApp();
    const res = await call(
      app,
      method,
      path,
      method === 'GET' || method === 'DELETE' ? undefined : SLACK,
      TOKEN_MEMBER,
    );
    expect(res.status).toBe(403);
    expect(errorCode(res.json)).toBe('permission-denied');
  });

  test.each([
    ['GET', '/v1/destinations/d', 'destinationId'],
    ['PATCH', '/v1/destinations/d', 'destinationId'],
    ['DELETE', '/v1/destinations/d', 'destinationId'],
    ['GET', '/v1/destinations/d/deliveries', 'destinationId'],
    ['POST', `/v1/destinations/d/deliveries/${randomUUID()}/redeliver`, 'destinationId'],
    ['POST', `/v1/destinations/${randomUUID()}/deliveries/x/redeliver`, 'deliveryId'],
    ['POST', '/v1/destinations/d/test', 'destinationId'],
  ])(
    '%s %s: an id that is not a UUID is 400 for an admin, naming `%s`',
    async (method, path, param) => {
      const { app } = makeApp();
      const res = await call(app, method, path, method === 'PATCH' ? { name: 'x' } : undefined);
      expect(res.status).toBe(400);
      expect(errorCode(res.json)).toBe('bad-input');
      expect(errorOf(res.json).message).toContain(`\`${param}\` must be`);
    },
  );

  test("a project's list: what its schedules may use, enough to pick one", async () => {
    const { app } = makeApp();
    await createId(app, { ...WEBHOOK, projects: [KNOWN_PROJECT] });
    await createId(app, { ...EMAIL, projects: [KNOWN_PROJECT] });
    await createId(app, SLACK);
    await createId(app, { ...SLACK, projects: [OTHER_PROJECT] });
    const res = await call(
      app,
      'GET',
      `/v1/destinations?projectId=${KNOWN_PROJECT}`,
      undefined,
      TOKEN_MEMBER,
    );
    expect(res.status).toBe(200);
    const data = res.json.data as Record<string, unknown>[];
    expect(data.map((d) => d.kind).sort()).toEqual(['email', 'slack', 'webhook']);
    // Enough to pick one: not where they send, their secrets, who they
    // mail, or which other projects may use them.
    for (const d of data) {
      expect(Object.keys(d).sort()).toEqual([
        'content',
        'createdAt',
        'destinationId',
        'kind',
        'lastError',
        'name',
        'status',
        'updatedAt',
      ]);
    }
  });

  test("an admin's project list keeps every field", async () => {
    const { app } = makeApp();
    await createId(app, { ...WEBHOOK, projects: [KNOWN_PROJECT] });
    const res = await call(app, 'GET', `/v1/destinations?projectId=${KNOWN_PROJECT}`);
    expect(res.status).toBe(200);
    expect((res.json.data as unknown[])[0]).toMatchObject({
      host: 'stored.example.com',
      urlRef: URL_REF,
      secretRef: SECRET_REF,
      projects: [KNOWN_PROJECT],
    });
  });

  test('a projectId that is not a UUID is 400', async () => {
    const { app } = makeApp();
    const res = await call(app, 'GET', '/v1/destinations?projectId=acme', undefined, TOKEN_MEMBER);
    expect(res.status).toBe(400);
    expect(errorOf(res.json).message).toBe('`projectId` must be a project id (a UUID)');
  });
});

describe("a project's list, with an authorization store", () => {
  const TOKEN = 'destinations-authz-token';
  const resolveUser: TokenResolver = async (token) =>
    token === TOKEN ? { tenantId: tenantA, userId: KNOWN_PERSON } : null;

  function harness(granted: readonly string[]) {
    const asked: string[] = [];
    const decide = (action: Action, resource: ResourceRef): Decision => {
      asked.push(`${action} ${resource.type}`);
      const allowed = granted.includes(`${action} ${resource.type}`);
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: no grants',
        evidence: {
          action,
          relation: '',
          resource: `${resource.type}:${resource.id}`,
          actorSubject: '',
        },
      };
    };
    const binding = makeInMemoryBinding();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: resolveUser,
      runHandler,
      destinations: binding,
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, resource) => decide(action, resource),
          checkBatch: async (_p, action, resources) => resources.map((r) => decide(action, r)),
        } satisfies AuthzCheckBinding,
      },
    });
    return { app, asked };
  }

  const list = (app: App) =>
    call(app, 'GET', `/v1/destinations?projectId=${KNOWN_PROJECT}`, undefined, TOKEN);

  test('a member with `run` on the project lists it (200), having asked admin, then run', async () => {
    const { app, asked } = harness(['run project']);
    const res = await list(app);
    expect(res.status).toBe(200);
    expect(asked).toEqual(['admin tenant', 'run project']);
  });

  test('without `run` on the project it is 403', async () => {
    const { app, asked } = harness([]);
    const res = await list(app);
    expect(res.status).toBe(403);
    expect(asked).toEqual(['admin tenant', 'run project']);
  });

  test('an admin is asked nothing more', async () => {
    const { app, asked } = harness(['admin tenant']);
    expect((await list(app)).status).toBe(200);
    expect(asked).toEqual(['admin tenant']);
  });

  test("without projectId the list stays an admin's", async () => {
    const { app, asked } = harness(['run project']);
    const res = await call(app, 'GET', '/v1/destinations', undefined, TOKEN);
    expect(res.status).toBe(403);
    expect(asked).toEqual(['admin tenant']);
  });
});

describe('mounting', () => {
  test('without a binding, the routes are not mounted', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/destinations', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
  });
});
