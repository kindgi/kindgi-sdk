// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A schedule's `sendResultsTo` (`send-results-to.ts`): how a body names it,
 * and why a save is refused. At most five places, each a destination id or
 * `me`, named once; `on` defaults to every event. A destination must exist
 * and be one the schedule's project may use; `me` needs an owner who is a
 * person, and a deployment that sends email.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { SCHEDULE_RESULT_EVENTS, type TriggerOwner } from '@kindgi/runtime';
import type { DestinationId, ProjectId, TenantId, Timestamp } from '@kindgi/types';

import type { Destination, DestinationBinding } from '../src/destination-binding.js';
import {
  SEND_RESULTS_TO_MAX,
  parseSendResultsTo,
  sameResultTargets,
  sendResultsToJson,
  sendResultsToOwnerProblem,
  sendResultsToProblem,
} from '../src/routes/send-results-to.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID() as ProjectId;
const OTHER = randomUUID() as ProjectId;
const PERSON: TriggerOwner = { kind: 'user', id: randomUUID() };
const BOT: TriggerOwner = { kind: 'service', id: 'sa-orders' };

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

/** A binding that knows `known` and nothing else. */
function destinations(...known: Destination[]): Pick<DestinationBinding, 'get'> {
  return {
    async get(input) {
      return known.find((d) => d.destinationId === input.destinationId) ?? null;
    },
  };
}

describe('parseSendResultsTo', () => {
  test('absent when the body does not name it', () => {
    expect(parseSendResultsTo({})).toEqual({ kind: 'absent' });
  });

  test('`[]` is a list: on a PATCH it clears the field', () => {
    expect(parseSendResultsTo({ sendResultsTo: [] })).toEqual({ kind: 'ok', value: [] });
  });

  test('`on` defaults to every event, and a list keeps each event once', () => {
    const id = randomUUID();
    const parsed = parseSendResultsTo({
      sendResultsTo: [{ to: 'me' }, { to: id, on: ['failed', 'failed', 'waiting'] }],
    });
    expect(parsed).toEqual({
      kind: 'ok',
      value: [
        { to: 'me', on: SCHEDULE_RESULT_EVENTS },
        { to: id, on: ['failed', 'waiting'] },
      ],
    });
  });

  test.each([
    [{ sendResultsTo: 'me' }, '`sendResultsTo` must be a list'],
    [{ sendResultsTo: ['me'] }, '`sendResultsTo[0]` must be an object'],
    [{ sendResultsTo: [{ to: 'me', at: 'noon' }] }, 'unknown field `at`'],
    [{ sendResultsTo: [{ to: 'acme-team' }] }, '`sendResultsTo[0].to` must be a destination id'],
    [{ sendResultsTo: [{ to: 'me', on: [] }] }, '`sendResultsTo[0].on` must list one or more'],
    [{ sendResultsTo: [{ to: 'me', on: ['finished'] }] }, 'has "finished"'],
    [
      { sendResultsTo: [{ to: 'me' }, { to: 'me' }] },
      '`sendResultsTo[1].to` ("me") is named twice',
    ],
  ])('refuses %j', (body, message) => {
    const parsed = parseSendResultsTo(body);
    expect(parsed.kind).toBe('err');
    expect(parsed.kind === 'err' && parsed.message).toContain(message);
  });

  test('a destination id is kept in lowercase, so one id in two cases is named twice', () => {
    const id = randomUUID();
    expect(parseSendResultsTo({ sendResultsTo: [{ to: id.toUpperCase() }] })).toEqual({
      kind: 'ok',
      value: [{ to: id, on: SCHEDULE_RESULT_EVENTS }],
    });
    const twice = parseSendResultsTo({ sendResultsTo: [{ to: id }, { to: id.toUpperCase() }] });
    expect(twice.kind === 'err' && twice.message).toContain('`sendResultsTo[1].to`');
    expect(twice.kind === 'err' && twice.message).toContain('is named twice');
  });

  test(`takes at most ${SEND_RESULTS_TO_MAX} places`, () => {
    const places = Array.from({ length: SEND_RESULTS_TO_MAX + 1 }, () => ({ to: randomUUID() }));
    const parsed = parseSendResultsTo({ sendResultsTo: places });
    expect(parsed.kind === 'err' && parsed.message).toContain(
      `at most ${SEND_RESULTS_TO_MAX} places`,
    );
  });
});

describe('sendResultsToProblem', () => {
  const on = SCHEDULE_RESULT_EVENTS;

  test('a destination any project may use, and `me` for a person: no problem', async () => {
    const open = destination();
    const ours = destination({ projects: [PROJECT] });
    const targets = [
      { to: 'me' as const, on },
      { to: open.destinationId, on },
      { to: ours.destinationId, on },
    ];
    expect(
      await sendResultsToProblem(destinations(open, ours), tenantId, PROJECT, PERSON, targets),
    ).toBeUndefined();
  });

  test('`me` on a schedule a service account owns is refused', async () => {
    const problem = await sendResultsToProblem(destinations(), tenantId, PROJECT, BOT, [
      { to: 'me', on },
    ]);
    expect(problem).toContain('runs as a service account');
  });

  test('a destination this deployment has no binding for is refused, and `me` named instead', async () => {
    const problem = await sendResultsToProblem(undefined, tenantId, PROJECT, PERSON, [
      { to: randomUUID() as DestinationId, on },
    ]);
    expect(problem).toContain('send to `me` instead');
  });

  test('`me` on a deployment that sends no email is refused, naming the setting', async () => {
    const problem = await sendResultsToProblem(
      destinations(),
      tenantId,
      PROJECT,
      PERSON,
      [{ to: 'me', on }],
      { on: false, setting: 'KINDGI_AUTH_EMAIL_SMTP_URL' },
    );
    expect(problem).toBe(
      "`sendResultsTo[0].to` is `me`, its owner's own email, but this deployment sends no email: `me` needs `KINDGI_AUTH_EMAIL_SMTP_URL`",
    );
    expect(
      await sendResultsToProblem(destinations(), tenantId, PROJECT, PERSON, [{ to: 'me', on }], {
        on: true,
      }),
    ).toBeUndefined();
  });

  test('`me` is named instead of a destination only where `me` would be taken', async () => {
    const to = randomUUID() as DestinationId;
    const noMail = await sendResultsToProblem(undefined, tenantId, PROJECT, PERSON, [{ to, on }], {
      on: false,
      setting: 'KINDGI_AUTH_EMAIL_SMTP_URL',
    });
    const bot = await sendResultsToProblem(undefined, tenantId, PROJECT, BOT, [{ to, on }]);
    for (const problem of [noMail, bot]) {
      expect(problem).toBe(
        '`sendResultsTo[0].to` names a destination, but this deployment has no destinations',
      );
    }
  });

  test('an unknown or removed destination is refused by id', async () => {
    const id = randomUUID() as DestinationId;
    const problem = await sendResultsToProblem(destinations(), tenantId, PROJECT, PERSON, [
      { to: 'me', on },
      { to: id, on },
    ]);
    expect(problem).toBe(`\`sendResultsTo[1].to\`: no destination with id "${id}"`);
  });

  test('a destination for other projects is refused, by name', async () => {
    const theirs = destination({ name: 'acme ops', projects: [OTHER] });
    const problem = await sendResultsToProblem(destinations(theirs), tenantId, PROJECT, PERSON, [
      { to: theirs.destinationId, on },
    ]);
    expect(problem).toContain(`destination "acme ops" isn't for this schedule's project`);
  });
});

describe('sendResultsToOwnerProblem', () => {
  const on = SCHEDULE_RESULT_EVENTS;

  test('a service account can not own a schedule that sends to `me`', () => {
    expect(
      sendResultsToOwnerProblem(BOT, [
        { to: randomUUID() as DestinationId, on },
        { to: 'me', on },
      ]),
    ).toBe(
      "`sendResultsTo[1].to` is `me`, its owner's own email, and a service account has none: change `sendResultsTo` with PATCH first",
    );
  });

  test('a person may own it, and anyone may own one without `me`', () => {
    expect(sendResultsToOwnerProblem(PERSON, [{ to: 'me', on }])).toBeUndefined();
    expect(
      sendResultsToOwnerProblem(BOT, [{ to: randomUUID() as DestinationId, on }]),
    ).toBeUndefined();
    expect(sendResultsToOwnerProblem(BOT, [])).toBeUndefined();
  });
});

describe('sameResultTargets and sendResultsToJson', () => {
  test('the same places and events in another order are the same', () => {
    const id = randomUUID() as DestinationId;
    expect(
      sameResultTargets(
        [
          { to: 'me', on: ['failed', 'completed'] },
          { to: id, on: ['waiting'] },
        ],
        [
          { to: id, on: ['waiting'] },
          { to: 'me', on: ['completed', 'failed'] },
        ],
      ),
    ).toBe(true);
    expect(
      sameResultTargets([{ to: 'me', on: ['failed'] }], [{ to: 'me', on: ['completed'] }]),
    ).toBe(false);
    expect(sameResultTargets([{ to: 'me', on: ['failed'] }], [])).toBe(false);
  });

  test('the wire form copies each place', () => {
    const targets = [{ to: 'me' as const, on: ['failed' as const] }];
    const json = sendResultsToJson(targets);
    expect(json).toEqual([{ to: 'me', on: ['failed'] }]);
    expect(json[0]?.on).not.toBe(targets[0]?.on);
  });
});
