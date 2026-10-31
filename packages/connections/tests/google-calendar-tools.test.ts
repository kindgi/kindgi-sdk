// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { type ToolConnection, invokeToolForTest, toolContextForTest } from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  googleCalendarEventCreate,
  googleCalendarEventUpdate,
  googleCalendarEventsList,
  googleCalendarFreeBusy,
} from '../src/google-tools.js';

const TOKEN = 'ya29.not-a-real-token';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const list = googleCalendarEventsList({ id: 'acme.calendar.list' });
const freeBusy = googleCalendarFreeBusy({ id: 'acme.calendar.free-busy' });
const create = googleCalendarEventCreate({ id: 'acme.calendar.create' });
const update = googleCalendarEventUpdate({ id: 'acme.calendar.update' });

function calendar(): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'google',
    appName: 'Google',
    accessToken: TOKEN,
    account: { id: 'g-1', label: 'ana@acme.test' },
  };
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
  readonly body: unknown;
}

/** Google Calendar, stubbed: each call's answer in turn, and what each call sent. */
function googleAnswering(...answers: (() => Response)[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      sent.push({
        url,
        method: init.method ?? 'GET',
        authorization: (init.headers as Record<string, string> | undefined)?.authorization ?? '',
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const answer = answers[sent.length - 1] ?? answers.at(-1);
      if (answer === undefined) throw new Error('no answer stubbed');
      return answer();
    }),
  );
  return sent;
}

const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

/** A record that keeps each key's first answer, as a run's journal does. */
function journal() {
  const kept = new Map<string, unknown>();
  return async <T>(key: string, decide: () => T | Promise<T>): Promise<T> => {
    if (!kept.has(key)) kept.set(key, await decide());
    return kept.get(key) as T;
  };
}

const WINDOW = { from: '2026-11-03T00:00:00+01:00', to: '2026-11-04T00:00:00+01:00' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what each tool declares', () => {
  it('reads with the narrowest scope each call takes, and asks before an unattended create or update', () => {
    expect(list).toMatchObject({
      mutating: false,
      resultIsOutsideData: true,
      network: { kind: 'allowlist', hosts: ['www.googleapis.com'] },
      needsSpec: {
        connections: {
          calendar: {
            app: 'google',
            permissions: ['calendar.events.owned.readonly'],
            as: 'person',
          },
        },
      },
    });
    expect(freeBusy).toMatchObject({
      mutating: false,
      needsSpec: {
        connections: { calendar: { app: 'google', permissions: ['calendar.freebusy'] } },
      },
    });
    for (const tool of [create, update]) {
      expect(tool).toMatchObject({
        mutating: true,
        needsApprovalWhenUnattended: true,
        needsSpec: {
          connections: { calendar: { app: 'google', permissions: ['calendar.events.owned'] } },
        },
      });
      expect(tool.effects?.map((e) => e.kind)).toEqual([
        'external-side-effect',
        'sensitive-data-egress',
      ]);
    }
  });

  it("the company's calendar is another declaration, and says so", () => {
    const company = googleCalendarEventCreate({ id: 'acme.store-calendar.create', as: 'company' });
    expect(company.needsSpec?.connections?.calendar?.as).toBe('company');
    expect(company.description).toContain("the company's Google calendar");
    expect(create.description).toContain("the person's own Google calendar");
  });
});

describe('google calendar events list', () => {
  it('lists the window by start, each occurrence apart, in UTC, with the token', async () => {
    const sent = googleAnswering(() =>
      Response.json({
        items: [
          {
            id: 'ev1',
            status: 'confirmed',
            summary: 'Stand-up',
            location: 'Room 4',
            start: { dateTime: '2026-11-03T10:00:00+01:00' },
            end: { dateTime: '2026-11-03T10:15:00+01:00' },
            organizer: { email: 'bo@acme.test', displayName: 'Bo' },
            attendees: [
              { email: 'ana@acme.test', responseStatus: 'accepted', self: true },
              { email: 'cy@acme.test', responseStatus: 'needsAction' },
              { email: 'room-4@resource.calendar.google.com', resource: true },
            ],
            htmlLink: 'https://www.google.com/calendar/event?eid=ev1',
          },
          {
            id: 'ev2',
            summary: 'Offsite',
            start: { date: '2026-11-03' },
            end: { date: '2026-11-04' },
            transparency: 'transparent',
          },
          { id: 'ev3', status: 'cancelled' },
        ],
      }),
    );
    const r = await invokeToolForTest(
      list,
      { ...WINDOW, query: 'stand-up', top: 10 },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        events: [
          {
            id: 'ev1',
            title: 'Stand-up',
            start: '2026-11-03T09:00:00Z',
            end: '2026-11-03T09:15:00Z',
            allDay: false,
            location: 'Room 4',
            organizer: { address: 'bo@acme.test', name: 'Bo' },
            attendees: [
              { address: 'ana@acme.test', response: 'accepted' },
              { address: 'cy@acme.test', response: 'none' },
            ],
            busy: true,
            link: 'https://www.google.com/calendar/event?eid=ev1',
          },
          {
            id: 'ev2',
            title: 'Offsite',
            start: '2026-11-03',
            end: '2026-11-04',
            allDay: true,
            attendees: [],
            busy: false,
          },
        ],
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.split('?')[0]).toBe(EVENTS);
    expect(sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(params(sent[0]?.url ?? '')).toEqual({
      timeMin: '2026-11-02T23:00:00.000Z',
      timeMax: '2026-11-03T23:00:00.000Z',
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '10',
      q: 'stand-up',
    });
  });

  it('gives the first 20 attendees, and how many more', async () => {
    const attendees = Array.from({ length: 23 }, (_, i) => ({ email: `p${i}@acme.test` }));
    googleAnswering(() =>
      Response.json({
        items: [
          {
            id: 'all-hands',
            summary: 'All hands',
            start: { dateTime: '2026-11-03T15:00:00Z' },
            end: { dateTime: '2026-11-03T16:00:00Z' },
            attendees,
          },
        ],
      }),
    );
    const r = await invokeToolForTest(list, WINDOW, { connections: { calendar: calendar() } });
    const event = r.kind === 'ok' ? r.value.events[0] : undefined;
    expect(event?.attendees).toHaveLength(20);
    expect(event?.attendeesLeftOut).toBe(3);
  });

  it('nothing in the window is an empty list', async () => {
    googleAnswering(() => Response.json({ kind: 'calendar#events' }));
    expect(
      await invokeToolForTest(list, WINDOW, { connections: { calendar: calendar() } }),
    ).toEqual({ kind: 'ok', value: { events: [] } });
  });

  it('refuses a window backwards, past 31 days, or a time with no offset, and calls nothing', async () => {
    const sent = googleAnswering(() => Response.json({ items: [] }));
    for (const input of [
      { from: WINDOW.to, to: WINDOW.from },
      { from: '2026-11-01T00:00:00Z', to: '2026-12-02T00:00:01Z' },
    ]) {
      const r = await invokeToolForTest(list, input, { connections: { calendar: calendar() } });
      expect(r.kind === 'err' && r.error.code).toBe('handler-error');
    }
    const r = await invokeToolForTest(
      list,
      { from: '2026-11-03T09:00:00', to: WINDOW.to },
      { connections: { calendar: calendar() } },
    );
    expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    expect(sent).toHaveLength(0);
  });
});

describe('google calendar free/busy', () => {
  it('asks for the primary calendar and gives the busy times merged, in UTC', async () => {
    const sent = googleAnswering(() =>
      Response.json({
        calendars: {
          primary: {
            busy: [
              { start: '2026-11-03T11:00:00+01:00', end: '2026-11-03T12:00:00+01:00' },
              { start: '2026-11-03T09:30:00Z', end: '2026-11-03T10:30:00Z' },
              { start: '2026-11-03T14:00:00Z', end: '2026-11-03T15:00:00Z' },
            ],
          },
        },
      }),
    );
    const r = await invokeToolForTest(freeBusy, WINDOW, { connections: { calendar: calendar() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        busy: [
          { start: '2026-11-03T09:30:00Z', end: '2026-11-03T11:00:00Z' },
          { start: '2026-11-03T14:00:00Z', end: '2026-11-03T15:00:00Z' },
        ],
      },
    });
    expect(sent[0]).toMatchObject({
      url: 'https://www.googleapis.com/calendar/v3/freeBusy',
      method: 'POST',
      body: {
        timeMin: '2026-11-02T23:00:00.000Z',
        timeMax: '2026-11-03T23:00:00.000Z',
        items: [{ id: 'primary' }],
      },
    });
  });

  it("a calendar Google can't read fails, naming its reason", async () => {
    googleAnswering(() =>
      Response.json({
        calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } },
      }),
    );
    const r = await invokeToolForTest(freeBusy, WINDOW, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain('(notFound)');
  });
});

describe('google calendar event create', () => {
  const EVENT = {
    title: 'Intro call',
    start: '2026-11-05T14:00:00+01:00',
    end: '2026-11-05T14:30:00+01:00',
    location: 'Video',
    description: 'Thirty minutes to meet.',
    attendees: ['bo@acme.test'],
  };

  it("adds the event with Google's invitations, the call's key as its id, once per call", async () => {
    const sent = googleAnswering(() =>
      Response.json({ id: 'c0ffee', htmlLink: 'https://www.google.com/calendar/event?eid=c0ffee' }),
    );
    const key = randomUUID().toUpperCase();
    const ctx = { connections: { calendar: calendar() }, idempotencyKey: key, record: journal() };
    const first = await invokeToolForTest(create, EVENT, ctx);
    expect(first).toEqual({
      kind: 'ok',
      value: { eventId: 'c0ffee', link: 'https://www.google.com/calendar/event?eid=c0ffee' },
    });
    // The step run again gets the first answer, and adds nothing.
    expect(await invokeToolForTest(create, EVENT, ctx)).toEqual(first);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toBe(`${EVENTS}?sendUpdates=all`);
    expect(sent[0]?.body).toEqual({
      id: key.toLowerCase().replaceAll('-', ''),
      summary: 'Intro call',
      start: { dateTime: '2026-11-05T13:00:00.000Z' },
      end: { dateTime: '2026-11-05T13:30:00.000Z' },
      location: 'Video',
      description: 'Thirty minutes to meet.',
      attendees: [{ email: 'bo@acme.test' }],
    });
  });

  it('an all-day event goes as days', async () => {
    const sent = googleAnswering(() => Response.json({ id: 'day1' }));
    await invokeToolForTest(
      create,
      { title: 'Offsite', start: '2026-11-05', end: '2026-11-07' },
      { connections: { calendar: calendar() } },
    );
    expect(sent[0]?.body).toEqual({
      summary: 'Offsite',
      start: { date: '2026-11-05' },
      end: { date: '2026-11-07' },
    });
  });

  it('the event this call made before, its answer lost, is the answer; deleted since, it fails', async () => {
    const key = randomUUID();
    const id = key.replaceAll('-', '');
    let sent = googleAnswering(
      () =>
        Response.json(
          { error: { code: 409, message: 'The requested identifier already exists.' } },
          { status: 409 },
        ),
      () => Response.json({ id, status: 'confirmed' }),
    );
    const ctx = { connections: { calendar: calendar() }, idempotencyKey: key };
    expect(await invokeToolForTest(create, EVENT, ctx)).toEqual({
      kind: 'ok',
      value: { eventId: id },
    });
    expect(sent.map((s) => s.method)).toEqual(['POST', 'GET']);
    expect(sent[1]?.url).toBe(`${EVENTS}/${id}`);

    sent = googleAnswering(
      () => Response.json({ error: { code: 409 } }, { status: 409 }),
      () => Response.json({ id, status: 'cancelled' }),
    );
    const r = await invokeToolForTest(create, EVENT, ctx);
    expect(r.kind === 'err' && r.error.message).toContain('deleted since');
  });

  it('refuses a time and a day together, an end before the start, or a day that is not one', async () => {
    const sent = googleAnswering(() => Response.json({ id: 'x' }));
    for (const span of [
      { start: '2026-11-05', end: '2026-11-05T15:00:00Z' },
      { start: '2026-11-05T15:00:00Z', end: '2026-11-05T14:00:00Z' },
      { start: '2026-11-05', end: '2026-11-05' },
      { start: '2026-02-30', end: '2026-03-01' },
    ]) {
      const r = await invokeToolForTest(
        create,
        { title: 'x', ...span },
        { connections: { calendar: calendar() } },
      );
      expect(r.kind === 'err' && r.error.code, JSON.stringify(span)).toBe('handler-error');
    }
    expect(sent).toHaveLength(0);
  });

  it("Google's refusal comes back in its words, never with the token", async () => {
    googleAnswering(() =>
      Response.json(
        { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Insufficient Permission' } },
        { status: 403 },
      ),
    );
    const r = await invokeToolForTest(create, EVENT, { connections: { calendar: calendar() } });
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      "Google Calendar didn't add the event (HTTP 403): PERMISSION_DENIED: Insufficient Permission",
    );
    expect(message).not.toContain(TOKEN);
  });
});

describe('google calendar event update', () => {
  it('reads the event, then patches what the call changes, with the updates sent, once per call', async () => {
    const sent = googleAnswering(
      () => Response.json({ id: 'ev1_20261103T090000Z', recurringEventId: 'ev1' }),
      () => Response.json({ id: 'ev1_20261103T090000Z' }),
    );
    const ctx = { connections: { calendar: calendar() }, record: journal() };
    const input = {
      eventId: 'ev1_20261103T090000Z',
      start: '2026-11-03T10:00:00Z',
      end: '2026-11-03T10:30:00Z',
      attendees: ['bo@acme.test', 'cy@acme.test'],
    };
    const first = await invokeToolForTest(update, input, ctx);
    expect(first).toEqual({ kind: 'ok', value: { eventId: 'ev1_20261103T090000Z' } });
    expect(await invokeToolForTest(update, input, ctx)).toEqual(first);
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['GET', `${EVENTS}/ev1_20261103T090000Z`],
      ['PATCH', `${EVENTS}/ev1_20261103T090000Z?sendUpdates=all`],
    ]);
    expect(sent[1]?.body).toEqual({
      start: { dateTime: '2026-11-03T10:00:00.000Z' },
      end: { dateTime: '2026-11-03T10:30:00.000Z' },
      attendees: [{ email: 'bo@acme.test' }, { email: 'cy@acme.test' }],
    });
  });

  it('never changes a whole series', async () => {
    const sent = googleAnswering(() =>
      Response.json({ id: 'ev1', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] }),
    );
    const r = await invokeToolForTest(
      update,
      { eventId: 'ev1', title: 'Weekly stand-up' },
      { connections: { calendar: calendar() } },
    );
    expect(r.kind === 'err' && r.error.message).toContain('a whole repeating series');
    expect(sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('refuses a start without its end, or nothing to change, and calls nothing', async () => {
    const sent = googleAnswering(() => Response.json({ id: 'ev1' }));
    for (const input of [{ eventId: 'ev1', start: '2026-11-03T10:00:00Z' }, { eventId: 'ev1' }]) {
      const r = await invokeToolForTest(update, input, { connections: { calendar: calendar() } });
      expect(r.kind === 'err' && r.error.code).toBe('handler-error');
    }
    await expect(
      update.handler(
        { eventId: '../../calendars', title: 'x' },
        toolContextForTest({ connections: { calendar: calendar() } }),
      ),
    ).rejects.toThrow("isn't an event id");
    expect(sent).toHaveLength(0);
  });
});
