// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A schedule's `sendResultsTo` through the app: registering and changing
 * it, what its record and versions show, and where its results went
 * (`GET /v1/schedules/:triggerId/deliveries`). How a body is read and why
 * a list is refused: `send-results-to.test.ts`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { SCHEDULE_RESULT_EVENTS } from '@kindgi/runtime';
import type {
  DestinationDeliveryId,
  DestinationId,
  ProjectId,
  RunId,
  TenantId,
  Timestamp,
  TriggerId,
  UserId,
} from '@kindgi/types';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import { validateAgainst } from './support/openapi-schema.js';

import type {
  Destination,
  DestinationBinding,
  DestinationDelivery,
  ResultEmail,
  ScheduleDeliveryListInput,
} from '../src/destination-binding.js';
import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const PROJECT = randomUUID() as ProjectId;
const OTHER = randomUUID() as ProjectId;
const TOKEN = 'send-results-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    authorization: `Bearer ${TOKEN}`,
    ...(body !== undefined && { 'content-type': 'application/json' }),
  },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

const destination = (over: Partial<Destination> = {}): Destination => ({
  destinationId: randomUUID() as DestinationId,
  name: 'acme team',
  kind: 'slack',
  content: 'link',
  status: 'active',
  lastError: null,
  createdAt: '2026-11-04T10:00:00.000Z' as Timestamp,
  updatedAt: '2026-11-04T10:00:00.000Z' as Timestamp,
  ...over,
});

const OURS = destination({ name: 'acme ops', projects: [PROJECT] });
const THEIRS = destination({ name: 'acme sales', projects: [OTHER] });
const ANY = destination({ name: 'acme all' });

/**
 * A destination store that knows OURS, THEIRS and ANY, and lists the
 * deliveries it is given for the schedule asked about. What these tests
 * don't use refuses.
 */
function destinationsWith(deliveries: readonly DestinationDelivery[] = []) {
  const asked: ScheduleDeliveryListInput[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('not used by these tests');
  };
  const binding: DestinationBinding = {
    create: unused,
    list: unused,
    update: unused,
    remove: unused,
    listDeliveries: unused,
    redeliver: unused,
    sendTest: unused,
    async get(input) {
      return [OURS, THEIRS, ANY].find((d) => d.destinationId === input.destinationId) ?? null;
    },
    async listScheduleDeliveries(input) {
      asked.push(input);
      const data = deliveries.filter(
        (d) =>
          d.scheduleId === input.scheduleId &&
          (input.status === undefined || d.status === input.status),
      );
      return { kind: 'ok', data };
    },
  };
  return { binding, asked };
}

function app(destinations?: DestinationBinding, resultEmail?: ResultEmail) {
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
  const built = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: registry,
    ...(destinations !== undefined && { destinations }),
    ...(resultEmail !== undefined && { resultEmail }),
  });
  return { built, registry };
}

const NO_MAIL: ResultEmail = { on: false, setting: 'KINDGI_AUTH_EMAIL_SMTP_URL' };

// It names its project: this app has no projects binding to find the
// default one, and a destination for some projects is checked against it.
const nightly = {
  flowId: 'acme.nightly',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  config: { cronExpression: '0 2 * * *' },
};

async function register(built: ReturnType<typeof app>['built'], body: Record<string, unknown>) {
  const res = await built.request('/v1/schedules', send('POST', { ...nightly, ...body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function versions(built: ReturnType<typeof app>['built'], id: string) {
  const res = await built.request(`/v1/schedules/${id}/versions`, send('GET'));
  expect(res.status).toBe(200);
  const page = (await res.json()) as {
    data: { version: number; definition: Record<string, unknown> }[];
  };
  return page.data;
}

describe('registering a schedule with sendResultsTo', () => {
  test('its record and version 1 name each place with its events; `on` left out is every event', async () => {
    const { built } = app(destinationsWith().binding);
    const created = await register(built, {
      sendResultsTo: [{ to: 'me' }, { to: OURS.destinationId, on: ['failed', 'waiting'] }],
    });
    expect(created.status).toBe(201);
    const expected = [
      { to: 'me', on: [...SCHEDULE_RESULT_EVENTS] },
      { to: OURS.destinationId, on: ['failed', 'waiting'] },
    ];
    expect(created.body.sendResultsTo).toEqual(expected);
    expect(validateAgainst('ScheduleRecord', created.body)).toEqual([]);

    const id = created.body.triggerId as string;
    const got = await built.request(`/v1/schedules/${id}`, send('GET'));
    expect(((await got.json()) as Record<string, unknown>).sendResultsTo).toEqual(expected);
    const [first] = await versions(built, id);
    expect(first?.definition.sendResultsTo).toEqual(expected);
  });

  test('none, or `[]`: the record has no sendResultsTo', async () => {
    const { built } = app(destinationsWith().binding);
    for (const body of [{}, { sendResultsTo: [] }]) {
      const created = await register(built, body);
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty('sendResultsTo');
    }
  });

  test.each([
    [
      'a destination for other projects',
      () => THEIRS.destinationId,
      "isn't for this schedule's project",
    ],
    ['an unknown destination', () => randomUUID(), 'no destination with id'],
  ])('%s is refused, and nothing is registered', async (_what, to, message) => {
    const { built } = app(destinationsWith().binding);
    const refused = await register(built, { sendResultsTo: [{ to: to() }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(message);
    const listed = await built.request('/v1/schedules', send('GET'));
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  test('a destination where this deployment has none: refused, and `me` named instead', async () => {
    const { built } = app();
    const refused = await register(built, { sendResultsTo: [{ to: ANY.destinationId }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('send to `me` instead');
    const me = await register(built, { sendResultsTo: [{ to: 'me', on: ['failed'] }] });
    expect(me.status).toBe(201);
    expect(me.body.sendResultsTo).toEqual([{ to: 'me', on: ['failed'] }]);
  });

  test('`me` where this deployment sends no email: refused, naming the setting, and nothing is registered', async () => {
    const { built } = app(destinationsWith().binding, NO_MAIL);
    const refused = await register(built, { sendResultsTo: [{ to: 'me' }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(
      'this deployment sends no email: `me` needs `KINDGI_AUTH_EMAIL_SMTP_URL`',
    );
    const listed = await built.request('/v1/schedules', send('GET'));
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0);
    const ours = await register(built, { sendResultsTo: [{ to: OURS.destinationId }] });
    expect(ours.status).toBe(201);
  });

  test('no destinations and no email: a destination is refused without naming `me`', async () => {
    const { built } = app(undefined, NO_MAIL);
    const refused = await register(built, { sendResultsTo: [{ to: ANY.destinationId }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('this deployment has no destinations');
    expect(JSON.stringify(refused.body)).not.toContain('send to `me` instead');
  });
});

describe("changing a schedule's sendResultsTo", () => {
  async function scheduled() {
    const h = app(destinationsWith().binding);
    const created = await register(h.built, {
      sendResultsTo: [{ to: 'me', on: ['failed'] }],
    });
    const id = created.body.triggerId as string;
    const patch = async (body: Record<string, unknown>) => {
      const res = await h.built.request(`/v1/schedules/${id}`, send('PATCH', body));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { ...h, id, patch };
  }

  test('a new list replaces it and makes a version; absent keeps it', async () => {
    const { built, id, patch } = await scheduled();
    const next = [
      { to: ANY.destinationId, on: ['completed'] },
      { to: 'me', on: ['failed', 'cancelled'] },
    ];
    const changed = await patch({ sendResultsTo: next });
    expect(changed.status).toBe(200);
    expect(changed.body.sendResultsTo).toEqual(next);
    expect(validateAgainst('ScheduleRecord', changed.body)).toEqual([]);
    const [newest] = await versions(built, id);
    expect(newest?.version).toBe(2);
    expect(newest?.definition.sendResultsTo).toEqual(next);

    const kept = await patch({ label: 'nightly' });
    expect(kept.status).toBe(200);
    expect(kept.body.sendResultsTo).toEqual(next);
  });

  test('the same places and events in another order change nothing: no new version', async () => {
    const { built, id, patch } = await scheduled();
    await patch({ sendResultsTo: [{ to: 'me', on: ['failed'] }, { to: ANY.destinationId }] });
    const before = await versions(built, id);
    const same = await patch({
      sendResultsTo: [
        { to: ANY.destinationId, on: [...SCHEDULE_RESULT_EVENTS].reverse() },
        { to: 'me', on: ['failed'] },
      ],
    });
    expect(same.status).toBe(200);
    expect(await versions(built, id)).toHaveLength(before.length);
  });

  test('`[]` clears it, with a version', async () => {
    const { built, id, patch } = await scheduled();
    const cleared = await patch({ sendResultsTo: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body).not.toHaveProperty('sendResultsTo');
    const [newest] = await versions(built, id);
    expect(newest?.version).toBe(2);
    expect(newest?.definition).not.toHaveProperty('sendResultsTo');
  });

  test('a destination for other projects is refused, and the list stays as it was', async () => {
    const { built, id, patch } = await scheduled();
    const refused = await patch({ sendResultsTo: [{ to: THEIRS.destinationId }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("isn't for this schedule's project");
    const got = await built.request(`/v1/schedules/${id}`, send('GET'));
    expect(((await got.json()) as Record<string, unknown>).sendResultsTo).toEqual([
      { to: 'me', on: ['failed'] },
    ]);
  });
});

describe('GET /v1/schedules/:triggerId/deliveries', () => {
  const delivery = (scheduleId: string, over: Partial<DestinationDelivery> = {}) =>
    ({
      deliveryId: randomUUID() as DestinationDeliveryId,
      to: 'me',
      event: 'run.finished',
      scheduleId: scheduleId as TriggerId,
      runId: randomUUID() as RunId,
      approvalId: null,
      status: 'delivered',
      reason: null,
      attempts: 1,
      nextAttemptAt: null,
      lastAttemptAt: '2026-11-04T10:00:01.000Z' as Timestamp,
      lastResponseStatus: 250,
      lastError: null,
      createdAt: '2026-11-04T10:00:00.000Z' as Timestamp,
      deliveredAt: '2026-11-04T10:00:01.000Z' as Timestamp,
      ...over,
    }) satisfies DestinationDelivery;

  test("lists the schedule's deliveries, by status when asked", async () => {
    const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
    const id = randomUUID();
    const kept: DestinationDelivery[] = [];
    const { binding, asked } = destinationsWith(kept);
    const built = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      triggerRegistry: registry,
      destinations: binding,
    });
    const created = await built.request(
      '/v1/schedules',
      send('POST', { ...nightly, sendResultsTo: [{ to: 'me' }] }),
    );
    const scheduleId = ((await created.json()) as { triggerId: string }).triggerId;
    kept.push(
      delivery(scheduleId),
      delivery(scheduleId, {
        to: OURS.destinationId,
        event: 'rate-cap.summary',
        runId: null,
        status: 'pending',
        nextAttemptAt: '2026-11-04T11:00:00.000Z' as Timestamp,
        deliveredAt: null,
        lastAttemptAt: null,
        lastResponseStatus: null,
        attempts: 0,
      }),
      delivery(id),
    );

    const all = await built.request(`/v1/schedules/${scheduleId}/deliveries`, send('GET'));
    expect(all.status).toBe(200);
    const page = (await all.json()) as { data: { status: string }[]; hasMore: boolean };
    expect(page.data).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(validateAgainst('DestinationDeliveryCollectionPage', page)).toEqual([]);

    const pending = await built.request(
      `/v1/schedules/${scheduleId}/deliveries?status=pending&limit=5`,
      send('GET'),
    );
    const only = (await pending.json()) as { data: { status: string }[] };
    expect(only.data.map((d) => d.status)).toEqual(['pending']);
    expect(asked.at(-1)).toMatchObject({ tenantId, scheduleId, status: 'pending', limit: 5 });
  });

  test('an unknown status is refused; an unknown schedule is not found', async () => {
    const { built } = app(destinationsWith().binding);
    const created = await register(built, {});
    const id = created.body.triggerId as string;
    const bad = await built.request(`/v1/schedules/${id}/deliveries?status=sent`, send('GET'));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('`status` must be one of');
    const missing = await built.request(`/v1/schedules/${randomUUID()}/deliveries`, send('GET'));
    expect(missing.status).toBe(404);
  });

  test('a deployment without destinations answers that it has none', async () => {
    const { built } = app();
    const created = await register(built, {});
    const res = await built.request(
      `/v1/schedules/${created.body.triggerId as string}/deliveries`,
      send('GET'),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('trigger-operation-unsupported');
  });
});
