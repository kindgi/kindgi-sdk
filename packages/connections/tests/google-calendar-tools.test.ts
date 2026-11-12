// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { type ToolConnection, invokeToolForTest, toolContextForTest } from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  googleCalendarCalendarsList,
  googleCalendarEventCreate,
  googleCalendarEventUpdate,
  googleCalendarEventsList,
  googleCalendarFreeBusy,
  googleCalendarSharedEventsList,
} from '../src/google-tools.js';

const TOKEN = 'ya29.not-a-real-token';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const EVENTS = `${CALENDAR}/calendars/primary/events`;

const calendars = googleCalendarCalendarsList({ id: 'acme.calendar.calendars' });
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
    expect(calendars).toMatchObject({
      mutating: false,
      resultIsOutsideData: true,
      network: { kind: 'allowlist', hosts: ['www.googleapis.com'] },
      needsSpec: {
        connections: {
          calendar: {
            app: 'google',
            permissions: ['calendar.calendarlist.readonly'],
            as: 'person',
          },
        },
      },
    });
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
    const companyCalendars = googleCalendarCalendarsList({
      id: 'acme.store-calendar.calendars',
      as: 'company',
    });
    expect(companyCalendars.needsSpec?.connections?.calendar?.as).toBe('company');
    expect(companyCalendars.description).toContain("the company's Google account");
    expect(calendars.description).toContain("the person's Google account");
  });
});

describe('google calendar calendars list', () => {
  it('lists the calendars, the main one first, then by name, with what the account may do on each', async () => {
    const sent = googleAnswering(() =>
      Response.json({
        items: [
          {
            id: 'team@group.calendar.google.com',
            summary: 'Team',
            accessRole: 'writer',
            dataOwner: 'bo@acme.test',
          },
          {
            id: 'ana@acme.test',
            summary: 'ana@acme.test',
            summaryOverride: 'Ana',
            primary: true,
            accessRole: 'owner',
          },
          {
            id: 'en.usa#holiday@group.v.calendar.google.com',
            summary: 'Holidays',
            accessRole: 'reader',
          },
          {
            id: 'cy@acme.test',
            summary: 'cy@acme.test',
            accessRole: 'freeBusyReader',
            dataOwner: 'cy@acme.test',
          },
          {
            id: 'desk@group.calendar.google.com',
            summary: 'Front desk',
            accessRole: 'writerWithoutPrivateAccess',
            dataOwner: 'desk@acme.test',
          },
          {
            id: 'side@group.calendar.google.com',
            summary: 'Side projects',
            accessRole: 'owner',
            dataOwner: 'Ana@acme.test',
          },
          { id: 'odd@group.calendar.google.com', summary: 'Odd', accessRole: 'none' },
          { summary: 'No id', accessRole: 'owner' },
          null,
        ],
      }),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        calendars: [
          { id: 'ana@acme.test', name: 'Ana', main: true, access: 'owner' },
          {
            id: 'cy@acme.test',
            name: 'cy@acme.test',
            main: false,
            access: 'free-busy',
            owner: { address: 'cy@acme.test' },
          },
          {
            id: 'desk@group.calendar.google.com',
            name: 'Front desk',
            main: false,
            access: 'write',
            owner: { address: 'desk@acme.test' },
          },
          {
            id: 'en.usa#holiday@group.v.calendar.google.com',
            name: 'Holidays',
            main: false,
            access: 'read',
          },
          // The account's own address, in another case: no owner.
          {
            id: 'side@group.calendar.google.com',
            name: 'Side projects',
            main: false,
            access: 'owner',
          },
          {
            id: 'team@group.calendar.google.com',
            name: 'Team',
            main: false,
            access: 'write',
            owner: { address: 'bo@acme.test' },
          },
        ],
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.split('?')[0]).toBe(`${CALENDAR}/users/me/calendarList`);
    expect(sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(params(sent[0]?.url ?? '')).toEqual({ maxResults: '250' });
  });

  it('reads every page first: an owned calendar has no owner when the main one comes later', async () => {
    const sent = googleAnswering(
      () =>
        Response.json({
          items: [
            {
              id: 'side@group.calendar.google.com',
              summary: 'Side',
              accessRole: 'owner',
              dataOwner: 'ana@acme.test',
            },
          ],
          nextPageToken: 'page-2',
        }),
      () =>
        Response.json({
          items: [
            { id: 'ana@acme.test', summary: 'ana@acme.test', primary: true, accessRole: 'owner' },
          ],
        }),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        calendars: [
          { id: 'ana@acme.test', name: 'ana@acme.test', main: true, access: 'owner' },
          { id: 'side@group.calendar.google.com', name: 'Side', main: false, access: 'owner' },
        ],
      },
    });
    expect(params(sent[1]?.url ?? '')).toEqual({ maxResults: '250', pageToken: 'page-2' });
  });

  it('with no main calendar in the list, gives each data owner as the owner', async () => {
    googleAnswering(() =>
      Response.json({
        items: [
          {
            id: 'side@group.calendar.google.com',
            summary: 'Side',
            accessRole: 'owner',
            dataOwner: 'ana@acme.test',
          },
        ],
      }),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        calendars: [
          {
            id: 'side@group.calendar.google.com',
            name: 'Side',
            main: false,
            access: 'owner',
            owner: { address: 'ana@acme.test' },
          },
        ],
      },
    });
  });

  it("cuts a long owner's address", async () => {
    googleAnswering(() =>
      Response.json({
        items: [
          {
            id: 'side@group.calendar.google.com',
            accessRole: 'reader',
            dataOwner: 'a'.repeat(300),
          },
        ],
      }),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'ok' && r.value.calendars[0]?.owner).toEqual({
      address: `${'a'.repeat(253)}…`,
    });
  });

  it('follows the pages up to 1000 calendars, then fails', async () => {
    const sent = googleAnswering(() => Response.json({ items: [], nextPageToken: 'more' }));
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain(
      "Google Calendar's calendar list goes on past 1000 calendars.",
    );
    expect(sent).toHaveLength(4);
  });

  it('an answer that is not a list fails', async () => {
    googleAnswering(() => Response.json({ items: { id: 'ana@acme.test' } }));
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain(
      "Google Calendar's calendar list wasn't a list.",
    );
  });

  it("Google's refusal comes back in its words, never with the token", async () => {
    googleAnswering(() =>
      Response.json(
        { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Insufficient Permission' } },
        { status: 403 },
      ),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'Google Calendar refused the call (HTTP 403): PERMISSION_DENIED: Insufficient Permission',
    );
    expect(message).not.toContain(TOKEN);
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

/** A timed event as Google gives it, in UTC. */
function timed(id: string, start: string, end: string) {
  return { id, summary: id, start: { dateTime: start }, end: { dateTime: end } };
}

/** `timed`'s event as a list gives it, on `calendarId`. */
function listed(id: string, start: string, end: string, calendarId: string) {
  return { id, title: id, start, end, allDay: false, attendees: [], busy: true, calendarId };
}

describe('google calendar events list, several calendars', () => {
  it('reads each calendar named, its id one path segment, and merges them by start, cut at `top`', async () => {
    const team = 'team/ops#1@group.calendar.google.com';
    const sent = googleAnswering(
      () =>
        Response.json({
          items: [
            timed('a1', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z'),
            timed('a2', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
          ],
        }),
      () =>
        Response.json({
          items: [
            timed('t1', '2026-11-03T09:00:00Z', '2026-11-03T09:15:00Z'),
            timed('t2', '2026-11-03T13:00:00Z', '2026-11-03T14:00:00Z'),
          ],
        }),
    );
    const r = await invokeToolForTest(
      list,
      { ...WINDOW, top: 3, calendarIds: ['ana@acme.test', team] },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        events: [
          listed('t1', '2026-11-03T09:00:00Z', '2026-11-03T09:15:00Z', team),
          listed('a1', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z', 'ana@acme.test'),
          listed('t2', '2026-11-03T13:00:00Z', '2026-11-03T14:00:00Z', team),
        ],
      },
    });
    expect(sent.map((s) => s.url.split('?')[0])).toEqual([
      `${CALENDAR}/calendars/ana%40acme.test/events`,
      `${CALENDAR}/calendars/team%2Fops%231%40group.calendar.google.com/events`,
    ]);
    for (const s of sent) {
      expect(s.authorization).toBe(`Bearer ${TOKEN}`);
      expect(params(s.url)).toMatchObject({ maxResults: '3', singleEvents: 'true' });
    }
  });

  it('gives an all-day event before the times on its day, and an event on two calendars twice', async () => {
    const meeting = timed('m1', '2026-11-03T08:00:00Z', '2026-11-03T09:00:00Z');
    const day = {
      id: 'off',
      summary: 'off',
      start: { date: '2026-11-03' },
      end: { date: '2026-11-04' },
    };
    googleAnswering(
      () => Response.json({ items: [meeting] }),
      () => Response.json({ items: [day, meeting] }),
    );
    const r = await invokeToolForTest(
      list,
      { ...WINDOW, calendarIds: ['ana@acme.test', 'team@group.calendar.google.com'] },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        events: [
          {
            ...listed('off', '2026-11-03', '2026-11-04', 'team@group.calendar.google.com'),
            allDay: true,
          },
          listed('m1', '2026-11-03T08:00:00Z', '2026-11-03T09:00:00Z', 'ana@acme.test'),
          listed(
            'm1',
            '2026-11-03T08:00:00Z',
            '2026-11-03T09:00:00Z',
            'team@group.calendar.google.com',
          ),
        ],
      },
    });
  });

  it('refuses no calendar, 11, one twice, or `.` or `..`, and calls nothing', async () => {
    const sent = googleAnswering(() => Response.json({ items: [] }));
    const context = { connections: { calendar: calendar() } };
    for (const calendarIds of [
      [],
      Array.from({ length: 11 }, (_, i) => `c${i}@acme.test`),
      ['ana@acme.test', 'ana@acme.test'],
      ['.'],
      ['ana@acme.test', '..'],
    ]) {
      const input = { ...WINDOW, calendarIds };
      for (const r of [
        await invokeToolForTest(list, input, context),
        await invokeToolForTest(freeBusy, input, context),
      ]) {
        expect(r.kind === 'err' && r.error.code, JSON.stringify(calendarIds)).toBe(
          'input-validation-failed',
        );
      }
    }
    // The handlers check each id again, past the schema, and refuse a lone
    // surrogate, which no URL can carry.
    for (const id of ['.', '..', `ana${String.fromCharCode(0xd800)}@acme.test`]) {
      const input = { ...WINDOW, calendarIds: [id] };
      await expect(list.handler(input, toolContextForTest(context))).rejects.toThrow(
        `"${id}" isn't a calendar id.`,
      );
      await expect(freeBusy.handler(input, toolContextForTest(context))).rejects.toThrow(
        `"${id}" isn't a calendar id.`,
      );
    }
    expect(sent).toHaveLength(0);
  });

  it("one calendar's refusal fails the call, naming that calendar", async () => {
    for (const [status, code, says] of [
      [403, 'PERMISSION_DENIED', 'Insufficient Permission'],
      [404, 'NOT_FOUND', 'Not Found'],
    ] as const) {
      googleAnswering(
        () => Response.json({ items: [] }),
        () => Response.json({ error: { code: status, status: code, message: says } }, { status }),
      );
      const r = await invokeToolForTest(
        list,
        { ...WINDOW, calendarIds: ['ana@acme.test', 'team@group.calendar.google.com'] },
        { connections: { calendar: calendar() } },
      );
      const message = r.kind === 'err' ? r.error.message : '';
      expect(message).toContain(
        `Google Calendar refused the call for calendar "team@group.calendar.google.com" (HTTP ${status}): ${code}: ${says}`,
      );
      expect(message).not.toContain(TOKEN);
    }
  });
});

describe('google calendar shared events list', () => {
  const shared = googleCalendarSharedEventsList({ id: 'acme.calendar.shared-list' });

  it('asks for the events on all the calendars, and is the events list otherwise', () => {
    expect(shared).toMatchObject({
      version: '1.0.0',
      mutating: false,
      resultIsOutsideData: true,
      network: { kind: 'allowlist', hosts: ['www.googleapis.com'] },
      needsSpec: {
        connections: {
          calendar: { app: 'google', permissions: ['calendar.events.readonly'], as: 'person' },
        },
      },
    });
    expect(shared.input).toEqual(list.input);
    expect(shared.output).toEqual(list.output);
    expect(shared.effects).toEqual(list.effects);
    expect(shared.description).toContain(
      "the person's Google calendars (the account they connected), those others share with them included",
    );
    expect(shared.description).not.toContain('others are refused');
    // The events list still asks only for the calendars the account owns.
    expect(list.needsSpec?.connections?.calendar?.permissions).toEqual([
      'calendar.events.owned.readonly',
    ]);
    const company = googleCalendarSharedEventsList({
      id: 'acme.store-calendar.shared-list',
      as: 'company',
    });
    expect(company.needsSpec?.connections?.calendar).toEqual({
      app: 'google',
      permissions: ['calendar.events.readonly'],
      as: 'company',
    });
    expect(company.description).toContain(
      "the company's Google calendars (the account a tenant admin connected), those others share with it included",
    );
  });

  it('reads the main calendar, or each named, one another owns too, merged by start', async () => {
    const colleague = 'ben@acme.test';
    const sent = googleAnswering(
      () =>
        Response.json({ items: [timed('own', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z')] }),
      () =>
        Response.json({ items: [timed('own', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z')] }),
      () =>
        Response.json({ items: [timed('ben', '2026-11-03T09:00:00Z', '2026-11-03T09:30:00Z')] }),
    );
    const context = { connections: { calendar: calendar() } };
    expect(await invokeToolForTest(shared, WINDOW, context)).toEqual({
      kind: 'ok',
      value: {
        events: [
          {
            id: 'own',
            title: 'own',
            start: '2026-11-03T10:00:00Z',
            end: '2026-11-03T10:30:00Z',
            allDay: false,
            attendees: [],
            busy: true,
          },
        ],
      },
    });
    expect(
      await invokeToolForTest(
        shared,
        { ...WINDOW, calendarIds: ['ana@acme.test', colleague] },
        context,
      ),
    ).toEqual({
      kind: 'ok',
      value: {
        events: [
          listed('ben', '2026-11-03T09:00:00Z', '2026-11-03T09:30:00Z', colleague),
          listed('own', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z', 'ana@acme.test'),
        ],
      },
    });
    expect(sent.map((s) => s.url.split('?')[0])).toEqual([
      EVENTS,
      `${CALENDAR}/calendars/ana%40acme.test/events`,
      `${CALENDAR}/calendars/ben%40acme.test/events`,
    ]);
    for (const s of sent) expect(s.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('a calendar Google refuses fails the call, naming it', async () => {
    googleAnswering(
      () => Response.json({ items: [] }),
      () =>
        Response.json(
          { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Insufficient Permission' } },
          { status: 403 },
        ),
    );
    const r = await invokeToolForTest(
      shared,
      { ...WINDOW, calendarIds: ['ana@acme.test', 'ben@acme.test'] },
      { connections: { calendar: calendar() } },
    );
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'Google Calendar refused the call for calendar "ben@acme.test" (HTTP 403): PERMISSION_DENIED: Insufficient Permission',
    );
    expect(message).not.toContain(TOKEN);
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

  it('asks for every calendar named in one call, and joins their busy times', async () => {
    const team = 'team@group.calendar.google.com';
    const sent = googleAnswering(() =>
      Response.json({
        calendars: {
          'ana@acme.test': {
            busy: [{ start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z' }],
          },
          [team]: {
            busy: [
              { start: '2026-11-03T09:30:00Z', end: '2026-11-03T11:00:00Z' },
              { start: '2026-11-03T14:00:00Z', end: '2026-11-03T15:00:00Z' },
            ],
          },
        },
      }),
    );
    const r = await invokeToolForTest(
      freeBusy,
      { ...WINDOW, calendarIds: ['ana@acme.test', team] },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        busy: [
          { start: '2026-11-03T09:00:00Z', end: '2026-11-03T11:00:00Z' },
          { start: '2026-11-03T14:00:00Z', end: '2026-11-03T15:00:00Z' },
        ],
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `${CALENDAR}/freeBusy`,
      method: 'POST',
      body: { items: [{ id: 'ana@acme.test' }, { id: team }] },
    });
  });

  it("a calendar named that Google can't read, or leaves out, fails, naming it", async () => {
    const team = 'team@group.calendar.google.com';
    googleAnswering(
      () =>
        Response.json({
          calendars: {
            'ana@acme.test': { busy: [] },
            [team]: { errors: [{ domain: 'global', reason: 'notFound' }] },
          },
        }),
      () => Response.json({ calendars: { 'ana@acme.test': { busy: [] } } }),
    );
    const input = { ...WINDOW, calendarIds: ['ana@acme.test', team] };
    let r = await invokeToolForTest(freeBusy, input, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain(
      `Google Calendar gave no free/busy for the calendar "${team}" (notFound).`,
    );
    r = await invokeToolForTest(freeBusy, input, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain(
      `Google Calendar's free/busy had no busy list for the calendar "${team}".`,
    );
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

  it('a key that is not a UUID gives the event no id, and a 409 is a refusal', async () => {
    const sent = googleAnswering(
      () => Response.json({ id: 'c0ffee' }),
      () => Response.json({ error: { code: 409, message: 'Conflict.' } }, { status: 409 }),
    );
    const kinds: string[] = [];
    for (const key of ['ab-1', `${randomUUID()}-2`, 'v'.repeat(32)]) {
      const ctx = { connections: { calendar: calendar() }, idempotencyKey: key };
      kinds.push((await invokeToolForTest(create, EVENT, ctx)).kind);
    }
    expect(kinds).toEqual(['ok', 'err', 'err']);
    expect(sent.map((s) => [s.method, 'id' in (s.body as object)])).toEqual([
      ['POST', false],
      ['POST', false],
      ['POST', false],
    ]);
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
      start: { dateTime: '2026-11-03T10:00:00.000Z', date: null },
      end: { dateTime: '2026-11-03T10:30:00.000Z', date: null },
      attendees: [{ email: 'bo@acme.test' }, { email: 'cy@acme.test' }],
    });
  });

  it('switches an event between a time and a day, sending the key it drops as null', async () => {
    const sent = googleAnswering(() => Response.json({ id: 'ev1' }));
    const ctx = { connections: { calendar: calendar() } };
    const toDays = await invokeToolForTest(
      update,
      { eventId: 'ev1', start: '2026-11-03', end: '2026-11-04' },
      ctx,
    );
    const toTimes = await invokeToolForTest(
      update,
      { eventId: 'ev1', start: '2026-11-03T09:00:00+01:00', end: '2026-11-03T10:00:00+01:00' },
      ctx,
    );
    expect([toDays.kind, toTimes.kind]).toEqual(['ok', 'ok']);
    expect(sent.filter((s) => s.method === 'PATCH').map((s) => s.body)).toEqual([
      {
        start: { date: '2026-11-03', dateTime: null },
        end: { date: '2026-11-04', dateTime: null },
      },
      {
        start: { dateTime: '2026-11-03T08:00:00.000Z', date: null },
        end: { dateTime: '2026-11-03T09:00:00.000Z', date: null },
      },
    ]);
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
