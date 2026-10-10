// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every time the API reads goes through one rule (`parseTimeInput`): ISO
 * 8601 with a time and a zone, or Postgres's `timestamptz` text, naming a
 * real calendar time. Before, each route checked with `Date.parse` (or
 * `new Date`), which took `"Oct 9"`, a date with no time and a time with no
 * zone; eval runs' `from` / `to` weren't checked at all. Each such value
 * reached a binding's `::timestamptz` or named another instant.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { parseTimeInput } from '../src/routes/time-input.js';

describe('parseTimeInput', () => {
  test.each([
    ['2026-10-09T12:00:00.123Z', '2026-10-09T12:00:00.123Z'],
    ['2026-10-09T12:00:00Z', '2026-10-09T12:00:00.000Z'],
    ['2026-10-09T14:00:00.5+02:00', '2026-10-09T12:00:00.500Z'],
    ['2026-10-09T07:30:00-04:30', '2026-10-09T12:00:00.000Z'],
    ['2026-10-09T12:00:00.123456789Z', '2026-10-09T12:00:00.123Z'],
    ['2026-10-09 12:00:00.123456+00', '2026-10-09T12:00:00.123Z'],
    ['2026-10-09 17:30:00+05:30', '2026-10-09T12:00:00.000Z'],
    ['1890-01-01 00:53:28+00:53:28', '1890-01-01T00:00:00.000Z'],
    ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
  ])('%s is %s', (value, instant) => {
    expect(parseTimeInput(value)?.toISOString()).toBe(instant);
  });

  test.each<[unknown, string]>([
    ['1', 'a number'],
    ['x 1', 'text Date.parse reads as a date'],
    ['Oct 9', 'a month and day'],
    ['Fri Oct 09 2026 12:00:00 GMT+0000', "Date's toString()"],
    ['2026-10-09', 'a date with no time'],
    ['2026-10-09T12:00:00', 'a time with no zone'],
    ['2026-10-09T12:00Z', 'no seconds'],
    ['2026-10-09T12:00:00+0200', 'an offset without its colon'],
    ['2026-02-29T00:00:00Z', 'February 29 of a common year'],
    ['2026-10-09T24:00:00Z', 'hour 24'],
    ['2026-10-09T12:00:00+16:00', 'an offset past 15 hours'],
    ['0999-01-01T00:00:00Z', 'a year before 1000'],
    ['2026-10-09T12:00:00Z ', 'a trailing space'],
    [1_791_000_000_000, 'a number, not a string'],
    [undefined, 'nothing'],
  ])('refuses %j (%s)', (value) => {
    expect(parseTimeInput(value)).toBeNull();
  });
});

const tenantId = randomUUID() as TenantId;
const TOKEN = 'time-input';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN
    ? {
        tenantId,
        userId: 'user-1' as UserId,
        reviewerRole: 'admin',
        scopes: ['tenant-admin'],
        capabilities: ['secrets:write'],
      }
    : null;

/** Never reached: each request here is refused before its binding is called. */
const unreachable = new Proxy(
  {},
  {
    get: (_target, name) => () => {
      throw new Error(`binding method ${String(name)} reached`);
    },
  },
) as never;

const stubs = createStubAppBindings();
const app = createApp({
  ...stubs,
  resolveToken,
  runHandler: {} as RunHandlerBinding,
  cost: unreachable,
  enableObservations: true,
  supervisor: unreachable,
  provenanceBinding: unreachable,
  hitlBinding: unreachable,
  reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
  tokenAdmin: unreachable,
  auditEvents: unreachable,
  complianceClassifier: unreachable,
  complianceGenerator: unreachable,
  memory: unreachable,
  memoryErasures: unreachable,
  judgmentRegistry: unreachable,
  evalSuiteRegistry: unreachable,
  evalCaseStore: unreachable,
  deploymentRegistry: unreachable,
  signingKeyRegistry: unreachable,
  imageRegistry: unreachable,
  exportSigning: unreachable,
  evalRunBinding: unreachable,
  secretsBinding: unreachable,
});

async function send(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

const OK = '2026-10-09T12:00:00Z';
const q = (value: string) => encodeURIComponent(value);

/** Each time input, as the route takes it, with `value` in the time's place. */
const INPUTS: ReadonlyArray<
  readonly [string, string, (value: string) => [string, string, unknown?]]
> = [
  ['cost records `from`', 'from', (v) => ['GET', `/v1/cost/records?from=${q(v)}&to=${q(OK)}`]],
  [
    'cost aggregate `to`',
    'to',
    (v) => ['GET', `/v1/cost/aggregate?groupBy=category&from=${q(OK)}&to=${q(v)}`],
  ],
  [
    'deployments `publishedAt`',
    'publishedAt',
    (v) => ['POST', '/v1/deployments', { publishedAt: v }],
  ],
  [
    'judged suites `since`',
    'since',
    (v) => [
      'POST',
      '/v1/eval-suites/s-1/versions/from-judgments',
      { version: '1.0.0', projectId: randomUUID(), agentId: 'acme.desk-agent', since: v },
    ],
  ],
  [
    'memory erasures replay `createdAt`',
    'createdAt',
    (v) => [
      'POST',
      '/v1/memory/erasures/replay',
      {
        erasures: [
          {
            id: randomUUID(),
            selectorKind: 'fact',
            requestedBy: 'user-1',
            status: 'completed',
            createdAt: v,
            completedAt: OK,
          },
        ],
      },
    ],
  ],
  ['memory facts `asOf`', 'asOf', (v) => ['GET', `/v1/memory/facts?asOf=${q(v)}`]],
  [
    'memory fact `validFrom`',
    'validFrom',
    (v) => [
      'POST',
      '/v1/memory/facts',
      { type: 'note', scope: { tenantId }, content: 'x', validFrom: v },
    ],
  ],
  [
    'provenance `createdAfter`',
    'createdAfter',
    (v) => ['GET', `/v1/provenance?createdAfter=${q(v)}`],
  ],
  ['observations `since`', 'since', (v) => ['GET', `/v1/observations?since=${q(v)}`]],
  [
    'approvals `createdAfter`',
    'createdAfter',
    (v) => ['GET', `/v1/approvals?createdAfter=${q(v)}`],
  ],
  ['tokens `expiresAt`', 'expiresAt', (v) => ['POST', '/v1/tokens', { name: 'k', expiresAt: v }]],
  ['compliance evidence `from`', 'from', (v) => ['GET', `/v1/compliance/evidence?from=${q(v)}`]],
  [
    'compliance export `filter.to`',
    'to',
    (v) => ['POST', '/v1/compliance/evidence/export', { filter: { to: v } }],
  ],
  ['authz audit `from`', 'from', (v) => ['GET', `/v1/audit/authz?from=${q(v)}`]],
  [
    'secrets `rotationDueAt`',
    'rotationDueAt',
    (v) => [
      'POST',
      '/v1/secrets',
      {
        scope: { kind: 'tenant', tenantId },
        envName: 'production',
        name: 'stripe-key',
        value: 'x',
        writeMode: 'create-new',
        rotationDueAt: v,
      },
    ],
  ],
  ['eval runs `to`', 'to', (v) => ['GET', `/v1/eval-runs?to=${q(v)}`]],
];

describe('every time input answers 400 to a time the rule refuses', () => {
  test.each(INPUTS)('%s', async (_name, field, request) => {
    for (const loose of ['Oct 9', '2026-10-09', '2026-10-09T12:00:00']) {
      const [method, path, body] = request(loose);
      const answer = await send(method, path, body);
      expect({ loose, status: answer.status }).toEqual({ loose, status: 400 });
      expect(answer.text).toContain(field);
    }
  });
});
