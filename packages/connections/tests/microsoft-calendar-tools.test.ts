// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { type ToolConnection, invokeToolForTest, toolContextForTest } from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  outlookCalendarCalendarsList,
  outlookCalendarEventCreate,
  outlookCalendarEventUpdate,
  outlookCalendarEventsList,
  outlookCalendarFreeBusy,
  outlookCalendarSharedEventsList,
} from '../src/microsoft-tools.js';

const TOKEN = 'eyJ0eXAi.not-a-real-token';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const calendars = outlookCalendarCalendarsList({ id: 'acme.calendar.calendars' });
const list = outlookCalendarEventsList({ id: 'acme.calendar.list' });
const freeBusy = outlookCalendarFreeBusy({ id: 'acme.calendar.free-busy' });
const create = outlookCalendarEventCreate({ id: 'acme.calendar.create' });
const update = outlookCalendarEventUpdate({ id: 'acme.calendar.update' });

function calendar(): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'microsoft',
    appName: 'Microsoft',
    accessToken: TOKEN,
    account: { id: 'm-1', label: 'ana@acme.test' },
  };
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Graph, stubbed: each call's answer in turn, and what each call sent. */
function graphAnswering(...answers: (() => Response)[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      sent.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers as Record<string, string> | undefined) ?? {},
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

function journal() {
  const kept = new Map<string, unknown>();
  return async <T>(key: string, decide: () => T | Promise<T>): Promise<T> => {
    if (!kept.has(key)) kept.set(key, await decide());
    return kept.get(key) as T;
  };
}

const WINDOW = { from: '2026-11-03T00:00:00Z', to: '2026-11-04T00:00:00Z' };

/** An event as Graph gives it in UTC. */
function raw(id: string, start: string, end: string, more: Record<string, unknown> = {}) {
  return {
    id,
    subject: id,
    start: { dateTime: `${start}.0000000`, timeZone: 'UTC' },
    end: { dateTime: `${end}.0000000`, timeZone: 'UTC' },
    isAllDay: false,
    showAs: 'busy',
    isCancelled: false,
    ...more,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what each tool declares', () => {
  it('reads with Calendars.ReadBasic, writes with Calendars.ReadWrite, and asks before an unattended write', () => {
    for (const tool of [calendars, list, freeBusy]) {
      expect(tool).toMatchObject({
        mutating: false,
        network: { kind: 'allowlist', hosts: ['graph.microsoft.com'] },
        needsSpec: {
          connections: {
            calendar: { app: 'microsoft', permissions: ['calendars.readbasic'], as: 'person' },
          },
        },
      });
    }
    expect(calendars.resultIsOutsideData).toBe(true);
    expect(list.resultIsOutsideData).toBe(true);
    for (const tool of [create, update]) {
      expect(tool).toMatchObject({
        mutating: true,
        needsApprovalWhenUnattended: true,
        needsSpec: {
          connections: { calendar: { app: 'microsoft', permissions: ['calendars.readwrite'] } },
        },
      });
    }
  });
});

const ANA = { name: 'Ana', address: 'ana@acme.test' };

describe('outlook calendar calendars list', () => {
  it('lists the calendars, the main one first, then by name, an owner only on one shared', async () => {
    const sent = graphAnswering(() =>
      Response.json({
        value: [
          {
            id: 'AAMkTeam',
            name: 'Team',
            isDefaultCalendar: false,
            canEdit: true,
            isSharedWithMe: true,
            owner: { name: 'Cy', address: 'cy@acme.test' },
          },
          {
            id: 'AAMkMain',
            name: 'Calendar',
            isDefaultCalendar: true,
            canEdit: true,
            isSharedWithMe: false,
            owner: ANA,
          },
          {
            id: 'AAMkBirthdays',
            name: 'Birthdays',
            isDefaultCalendar: false,
            canEdit: false,
            isSharedWithMe: false,
            owner: ANA,
          },
          { name: 'No id', canEdit: true },
          null,
        ],
      }),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        calendars: [
          { id: 'AAMkMain', name: 'Calendar', main: true, access: 'owner' },
          { id: 'AAMkBirthdays', name: 'Birthdays', main: false, access: 'read' },
          {
            id: 'AAMkTeam',
            name: 'Team',
            main: false,
            access: 'write',
            owner: { address: 'cy@acme.test', name: 'Cy' },
          },
        ],
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.split('?')[0]).toBe(`${GRAPH}/me/calendars`);
    expect(sent[0]?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(params(sent[0]?.url ?? '').$top).toBe('100');
    expect(params(sent[0]?.url ?? '').$select?.split(',')).toEqual([
      'id',
      'name',
      'isDefaultCalendar',
      'canEdit',
      'isSharedWithMe',
      'owner',
    ]);
  });

  // What the account may do, by `canEdit` first, then `isSharedWithMe`.
  it.each([
    [{ canEdit: true, isSharedWithMe: false }, 'owner'],
    [{ canEdit: true, isSharedWithMe: true }, 'write'],
    [{ canEdit: false, isSharedWithMe: true }, 'read'],
    [{ canEdit: false, isSharedWithMe: false }, 'read'],
    [{ isSharedWithMe: true }, 'read'],
  ])('a calendar with %o is %s', async (fields, access) => {
    graphAnswering(() => Response.json({ value: [{ id: 'AAMkOne', name: 'One', ...fields }] }));
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'ok' && r.value.calendars[0]?.access).toBe(access);
  });

  it('sorts by name in English order, not by code point', async () => {
    graphAnswering(() =>
      Response.json({
        value: [
          { id: 'AAMkE', name: 'Émile' },
          { id: 'AAMkB', name: 'Bob' },
          { id: 'AAMkA', name: 'ana' },
        ],
      }),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'ok' && r.value.calendars.map((c) => c.name)).toEqual([
      'ana',
      'Bob',
      'Émile',
    ]);
  });

  it("cuts a long owner's name and address", async () => {
    graphAnswering(() =>
      Response.json({
        value: [
          {
            id: 'AAMkTeam',
            name: 'Team',
            isSharedWithMe: true,
            owner: { name: 'n'.repeat(300), address: 'a'.repeat(300) },
          },
        ],
      }),
    );
    const r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'ok' && r.value.calendars[0]?.owner).toEqual({
      address: `${'a'.repeat(253)}…`,
      name: `${'n'.repeat(199)}…`,
    });
  });

  it('follows the next pages on Graph up to four, then fails; a page off Graph is refused', async () => {
    const next = `${GRAPH}/me/calendars?$skip=10`;
    let sent = graphAnswering(
      () =>
        Response.json({
          value: [{ id: 'AAMkMain', name: 'Calendar', isDefaultCalendar: true, canEdit: true }],
          '@odata.nextLink': next,
        }),
      () => Response.json({ value: [{ id: 'AAMkTeam', name: 'Team' }] }),
    );
    let r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'ok' && r.value.calendars.map((c) => c.id)).toEqual(['AAMkMain', 'AAMkTeam']);
    expect(sent[1]?.url).toBe(next);

    sent = graphAnswering(() => Response.json({ value: [], '@odata.nextLink': next }));
    r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain(
      "Outlook's calendar list goes on past 4 pages.",
    );
    expect(sent).toHaveLength(4);

    sent = graphAnswering(() =>
      Response.json({ value: [], '@odata.nextLink': 'https://graph.example.test/next' }),
    );
    r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain(
      "Outlook's next page isn't on Microsoft Graph.",
    );
    expect(sent).toHaveLength(1);
  });

  it("an answer that is not a list fails, and Microsoft's refusal never comes with the token", async () => {
    graphAnswering(
      () => Response.json({ value: { id: 'AAMkMain' } }),
      () =>
        Response.json(
          { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } },
          { status: 403 },
        ),
    );
    let r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain("Outlook's calendar list wasn't a list.");
    r = await invokeToolForTest(calendars, {}, { connections: { calendar: calendar() } });
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'Outlook refused the call (HTTP 403): ErrorAccessDenied: Access is denied.',
    );
    expect(message).not.toContain(TOKEN);
  });
});

describe('outlook calendar events list', () => {
  it('reads the calendar view in UTC, by start, and gives each event', async () => {
    const sent = graphAnswering(() =>
      Response.json({
        value: [
          raw('ev1', '2026-11-03T09:00:00', '2026-11-03T09:15:00', {
            subject: 'Stand-up',
            location: { displayName: 'Room 4' },
            organizer: { emailAddress: { address: 'bo@acme.test', name: 'Bo' } },
            attendees: [
              {
                emailAddress: { address: 'ana@acme.test' },
                type: 'required',
                status: { response: 'accepted' },
              },
              {
                emailAddress: { address: 'cy@acme.test' },
                type: 'optional',
                status: { response: 'tentativelyAccepted' },
              },
              { emailAddress: { address: 'room4@acme.test' }, type: 'resource' },
            ],
            webLink: 'https://outlook.office365.com/owa/?itemid=ev1',
          }),
          raw('ev2', '2026-11-03T00:00:00', '2026-11-04T00:00:00', {
            subject: 'Offsite',
            isAllDay: true,
            showAs: 'free',
          }),
          raw('ev3', '2026-11-03T12:00:00', '2026-11-03T13:00:00', { isCancelled: true }),
        ],
      }),
    );
    const r = await invokeToolForTest(list, WINDOW, { connections: { calendar: calendar() } });
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
              { address: 'cy@acme.test', response: 'tentative' },
            ],
            busy: true,
            link: 'https://outlook.office365.com/owa/?itemid=ev1',
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
    expect(sent[0]?.url.split('?')[0]).toBe(`${GRAPH}/me/calendarView`);
    expect(sent[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      prefer: 'outlook.timezone="UTC"',
    });
    expect(params(sent[0]?.url ?? '')).toMatchObject({
      startDateTime: '2026-11-03T00:00:00.000Z',
      endDateTime: '2026-11-04T00:00:00.000Z',
      $top: '25',
      $orderby: 'start/dateTime',
    });
    // Calendars.ReadBasic gives no body, so a list never asks for one.
    expect(params(sent[0]?.url ?? '').$select?.split(',')).not.toContain('body');
  });
});

/** `raw`'s event as a list gives it, on `calendarId`. */
function listed(id: string, start: string, end: string, calendarId: string) {
  return { id, title: id, start, end, allDay: false, attendees: [], busy: true, calendarId };
}

describe('outlook calendar events list, several calendars', () => {
  it('reads each calendar named, by its id, and merges them by start, cut at `top`', async () => {
    const sent = graphAnswering(
      () =>
        Response.json({
          value: [
            raw('a1', '2026-11-03T10:00:00', '2026-11-03T10:30:00'),
            raw('a2', '2026-11-03T15:00:00', '2026-11-03T16:00:00'),
          ],
        }),
      () =>
        Response.json({
          value: [
            raw('t1', '2026-11-03T09:00:00', '2026-11-03T09:15:00'),
            raw('t2', '2026-11-03T13:00:00', '2026-11-03T14:00:00'),
          ],
        }),
    );
    const r = await invokeToolForTest(
      list,
      { ...WINDOW, top: 3, calendarIds: ['AAMkMain=', 'AAMk-Team_1'] },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        events: [
          listed('t1', '2026-11-03T09:00:00Z', '2026-11-03T09:15:00Z', 'AAMk-Team_1'),
          listed('a1', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z', 'AAMkMain='),
          listed('t2', '2026-11-03T13:00:00Z', '2026-11-03T14:00:00Z', 'AAMk-Team_1'),
        ],
      },
    });
    expect(sent.map((s) => s.url.split('?')[0])).toEqual([
      `${GRAPH}/me/calendars/AAMkMain%3D/calendarView`,
      `${GRAPH}/me/calendars/AAMk-Team_1/calendarView`,
    ]);
    for (const s of sent) {
      expect(s.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        prefer: 'outlook.timezone="UTC"',
      });
      expect(params(s.url)).toMatchObject({ $top: '3', $orderby: 'start/dateTime' });
    }
  });

  it('gives an all-day event before the times on its day, and an event on two calendars twice', async () => {
    const meeting = raw('m1', '2026-11-03T08:00:00', '2026-11-03T09:00:00');
    const day = raw('off', '2026-11-03T00:00:00', '2026-11-04T00:00:00', { isAllDay: true });
    graphAnswering(
      () => Response.json({ value: [meeting] }),
      () => Response.json({ value: [day, meeting] }),
    );
    const r = await invokeToolForTest(
      list,
      { ...WINDOW, calendarIds: ['AAMkMain', 'AAMkTeam'] },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        events: [
          { ...listed('off', '2026-11-03', '2026-11-04', 'AAMkTeam'), allDay: true },
          listed('m1', '2026-11-03T08:00:00Z', '2026-11-03T09:00:00Z', 'AAMkMain'),
          listed('m1', '2026-11-03T08:00:00Z', '2026-11-03T09:00:00Z', 'AAMkTeam'),
        ],
      },
    });
  });

  it('refuses no calendar, 11, one twice, or an id that is not one path segment, and calls nothing', async () => {
    const sent = graphAnswering(() => Response.json({ value: [] }));
    const context = { connections: { calendar: calendar() } };
    for (const calendarIds of [
      [],
      Array.from({ length: 11 }, (_, i) => `AAMk${i}`),
      ['AAMkMain', 'AAMkMain'],
      ['..'],
      ['AAMkMain', 'AAMk/Team'],
      ['AAMk.Team'],
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
    // The handlers check each id again, past the schema.
    for (const id of ['.', '..', 'AAMk/Team']) {
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
      [403, 'ErrorAccessDenied', 'Access is denied.'],
      [404, 'ErrorItemNotFound', 'The specified object was not found in the store.'],
    ] as const) {
      graphAnswering(
        () => Response.json({ value: [] }),
        () => Response.json({ error: { code, message: says } }, { status }),
      );
      const r = await invokeToolForTest(
        list,
        { ...WINDOW, calendarIds: ['AAMkMain', 'AAMkTeam'] },
        { connections: { calendar: calendar() } },
      );
      const message = r.kind === 'err' ? r.error.message : '';
      expect(message).toContain(
        `Outlook refused the call for calendar "AAMkTeam" (HTTP ${status}): ${code}: ${says}`,
      );
      expect(message).not.toContain(TOKEN);
    }
  });
});

describe('outlook calendar shared events list', () => {
  const shared = outlookCalendarSharedEventsList({ id: 'acme.calendar.shared-list' });

  it('asks for Calendars.Read, and is the events list otherwise', () => {
    expect(shared).toMatchObject({
      version: '1.0.0',
      mutating: false,
      resultIsOutsideData: true,
      network: { kind: 'allowlist', hosts: ['graph.microsoft.com'] },
      needsSpec: {
        connections: {
          calendar: { app: 'microsoft', permissions: ['calendars.read'], as: 'person' },
        },
      },
    });
    expect(shared.input).toEqual(list.input);
    expect(shared.output).toEqual(list.output);
    expect(shared.effects).toEqual(list.effects);
    expect(shared.description).toContain(
      "the person's Outlook calendars (the Microsoft account they connected), those others share with them included",
    );
    // The events list still asks only for Calendars.ReadBasic.
    expect(list.needsSpec?.connections?.calendar?.permissions).toEqual(['calendars.readbasic']);
    const company = outlookCalendarSharedEventsList({
      id: 'acme.store-calendar.shared-list',
      as: 'company',
    });
    expect(company.needsSpec?.connections?.calendar).toEqual({
      app: 'microsoft',
      permissions: ['calendars.read'],
      as: 'company',
    });
    expect(company.description).toContain(
      "the company's Outlook calendars (the account a tenant admin connected), those others share with it included",
    );
  });

  it('reads the main calendar, or each named, one shared with the account too, merged by start', async () => {
    const sent = graphAnswering(
      () => Response.json({ value: [raw('own', '2026-11-03T10:00:00', '2026-11-03T10:30:00')] }),
      () => Response.json({ value: [raw('own', '2026-11-03T10:00:00', '2026-11-03T10:30:00')] }),
      () => Response.json({ value: [raw('ben', '2026-11-03T09:00:00', '2026-11-03T09:30:00')] }),
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
      await invokeToolForTest(shared, { ...WINDOW, calendarIds: ['AAMkMain', 'AAMkBen'] }, context),
    ).toEqual({
      kind: 'ok',
      value: {
        events: [
          listed('ben', '2026-11-03T09:00:00Z', '2026-11-03T09:30:00Z', 'AAMkBen'),
          listed('own', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z', 'AAMkMain'),
        ],
      },
    });
    expect(sent.map((s) => s.url.split('?')[0])).toEqual([
      `${GRAPH}/me/calendarView`,
      `${GRAPH}/me/calendars/AAMkMain/calendarView`,
      `${GRAPH}/me/calendars/AAMkBen/calendarView`,
    ]);
    for (const s of sent) expect(s.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('a calendar Microsoft refuses fails the call, naming it', async () => {
    graphAnswering(
      () => Response.json({ value: [] }),
      () =>
        Response.json(
          { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } },
          { status: 403 },
        ),
    );
    const r = await invokeToolForTest(
      shared,
      { ...WINDOW, calendarIds: ['AAMkMain', 'AAMkBen'] },
      { connections: { calendar: calendar() } },
    );
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'Outlook refused the call for calendar "AAMkBen" (HTTP 403): ErrorAccessDenied: Access is denied.',
    );
    expect(message).not.toContain(TOKEN);
  });
});

describe('outlook calendar free/busy', () => {
  it('reads every page of the window and gives what shows as busy, tentative or away, merged', async () => {
    const next = `${GRAPH}/me/calendarView?$skip=100`;
    const sent = graphAnswering(
      () =>
        Response.json({
          value: [
            raw('a', '2026-11-03T09:00:00', '2026-11-03T10:00:00'),
            raw('b', '2026-11-03T09:30:00', '2026-11-03T11:00:00', { showAs: 'tentative' }),
            raw('c', '2026-11-03T12:00:00', '2026-11-03T13:00:00', { showAs: 'free' }),
            raw('d', '2026-11-03T13:00:00', '2026-11-03T14:00:00', {
              showAs: 'workingElsewhere',
            }),
          ],
          '@odata.nextLink': next,
        }),
      () =>
        Response.json({
          value: [raw('e', '2026-11-03T15:00:00', '2026-11-03T16:00:00', { showAs: 'oof' })],
        }),
    );
    const r = await invokeToolForTest(freeBusy, WINDOW, { connections: { calendar: calendar() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        busy: [
          { start: '2026-11-03T09:00:00Z', end: '2026-11-03T11:00:00Z' },
          { start: '2026-11-03T15:00:00Z', end: '2026-11-03T16:00:00Z' },
        ],
      },
    });
    expect(sent.map((s) => s.url)).toEqual([expect.stringContaining('$top=100'), next]);
  });

  it('follows no next page off Microsoft Graph, and stops at a window too full to say', async () => {
    graphAnswering(() =>
      Response.json({ value: [], '@odata.nextLink': 'https://graph.example.test/next' }),
    );
    let r = await invokeToolForTest(freeBusy, WINDOW, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain("isn't on Microsoft Graph");

    const sent = graphAnswering(() =>
      Response.json({ value: [], '@odata.nextLink': `${GRAPH}/me/calendarView?$skip=1` }),
    );
    r = await invokeToolForTest(freeBusy, WINDOW, { connections: { calendar: calendar() } });
    expect(r.kind === 'err' && r.error.message).toContain('ask for a shorter one');
    expect(sent).toHaveLength(10);
  });

  it('without calendarIds, a window too full says so in the words it always has', async () => {
    graphAnswering(() =>
      Response.json({ value: [], '@odata.nextLink': `${GRAPH}/me/calendarView?$skip=1` }),
    );
    const r = await invokeToolForTest(freeBusy, WINDOW, { connections: { calendar: calendar() } });
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain('The window holds more than 1000 events: ask for a shorter one.');
    expect(message).not.toContain('across');
  });

  it('reads each calendar named, one after another, and joins their busy times', async () => {
    const sent = graphAnswering(
      () => Response.json({ value: [raw('a', '2026-11-03T09:00:00', '2026-11-03T10:00:00')] }),
      () =>
        Response.json({
          value: [
            raw('b', '2026-11-03T09:30:00', '2026-11-03T11:00:00'),
            raw('c', '2026-11-03T14:00:00', '2026-11-03T15:00:00'),
            raw('d', '2026-11-03T16:00:00', '2026-11-03T17:00:00', { showAs: 'free' }),
          ],
        }),
    );
    const r = await invokeToolForTest(
      freeBusy,
      { ...WINDOW, calendarIds: ['AAMkMain', 'AAMkTeam'] },
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
    expect(sent.map((s) => s.url.split('?')[0])).toEqual([
      `${GRAPH}/me/calendars/AAMkMain/calendarView`,
      `${GRAPH}/me/calendars/AAMkTeam/calendarView`,
    ]);
    expect(params(sent[0]?.url ?? '')).toMatchObject({ $top: '100' });
  });

  it('ten calendars of a full page each, 1000 events in all, still answer', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `AAMk${i}`);
    const sent = graphAnswering(...ids.flatMap((id) => pagesOf(id, [100]).answers));
    const r = await invokeToolForTest(
      freeBusy,
      { ...WINDOW, calendarIds: ids },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: { busy: [{ start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z' }] },
    });
    expect(sent).toHaveLength(10);
  });

  it('past 1000 events across the calendars fails in either order, reading no page past it', async () => {
    // A: 950 events on 10 pages of 95. B: 200 on 2 pages of 100.
    const a = pagesOf(
      'AAMkA',
      Array.from({ length: 10 }, () => 95),
    );
    const b = pagesOf('AAMkB', [100, 100]);
    const orders: [string[], (() => Response)[], string][] = [
      // 950 on A, then 100 on B's first page: 1050. B's second page is never read.
      [['AAMkA', 'AAMkB'], [...a.answers, ...b.answers], b.next(0)],
      // 200 on B, then 855 on A's first 9 pages: 1055. A's 10th page is never read.
      [['AAMkB', 'AAMkA'], [...b.answers, ...a.answers], a.next(8)],
    ];
    for (const [calendarIds, answers, unread] of orders) {
      const sent = graphAnswering(...answers);
      const r = await invokeToolForTest(
        freeBusy,
        { ...WINDOW, calendarIds },
        { connections: { calendar: calendar() } },
      );
      expect(r.kind === 'err' && r.error.message, calendarIds.join()).toContain(
        'The window holds more than 1000 events across these calendars: ask for a shorter one, or fewer calendars.',
      );
      expect(sent).toHaveLength(11);
      expect(sent[0]?.url).toContain(`/me/calendars/${calendarIds[0]}/calendarView?`);
      expect(sent.map((s) => s.url)).not.toContain(unread);
    }
  });

  it("a calendar's 11th page fails, naming that calendar", async () => {
    const sent = graphAnswering(
      () => Response.json({ value: [] }),
      () =>
        Response.json({
          value: [],
          '@odata.nextLink': `${GRAPH}/me/calendars/AAMkTeam/calendarView?$skip=1`,
        }),
    );
    const r = await invokeToolForTest(
      freeBusy,
      { ...WINDOW, calendarIds: ['AAMkMain', 'AAMkTeam'] },
      { connections: { calendar: calendar() } },
    );
    expect(r.kind === 'err' && r.error.message).toContain(
      'Calendar "AAMkTeam" gave more than 10 pages for the window: ask for a shorter one.',
    );
    expect(sent).toHaveLength(11);
  });

  it('follows no next page off Microsoft Graph for a calendar named', async () => {
    const sent = graphAnswering(() =>
      Response.json({ value: [], '@odata.nextLink': 'https://graph.example.test/next' }),
    );
    const r = await invokeToolForTest(
      freeBusy,
      { ...WINDOW, calendarIds: ['AAMkMain'] },
      { connections: { calendar: calendar() } },
    );
    expect(r.kind === 'err' && r.error.message).toContain(
      "Outlook's next page isn't on Microsoft Graph.",
    );
    expect(sent).toHaveLength(1);
  });
});

/**
 * A calendar's pages of a calendar view: `sizes[k]` events on page `k`,
 * each at the same hour, and each page but the last linking the next.
 * `next(k)` is the link page `k` gives.
 */
function pagesOf(id: string, sizes: readonly number[]) {
  const next = (k: number) => `${GRAPH}/me/calendars/${id}/calendarView?$skip=${(k + 1) * 100}`;
  return {
    next,
    answers: sizes.map(
      (size, k) => () =>
        Response.json({
          value: Array.from({ length: size }, (_, j) =>
            raw(`${id}-${k}-${j}`, '2026-11-03T09:00:00', '2026-11-03T10:00:00'),
          ),
          ...(k < sizes.length - 1 && { '@odata.nextLink': next(k) }),
        }),
    ),
  };
}

describe('outlook calendar event create', () => {
  it("posts the event in UTC with the call's key as its transaction id, once per call", async () => {
    const sent = graphAnswering(() =>
      Response.json(
        { id: 'AAMk=', webLink: 'https://outlook.office365.com/owa/?itemid=AAMk' },
        { status: 201 },
      ),
    );
    const key = randomUUID();
    const ctx = { connections: { calendar: calendar() }, idempotencyKey: key, record: journal() };
    const input = {
      title: 'Intro call',
      start: '2026-11-05T14:00:00+01:00',
      end: '2026-11-05T14:30:00+01:00',
      description: 'Thirty minutes to meet.',
      attendees: ['bo@acme.test'],
    };
    const first = await invokeToolForTest(create, input, ctx);
    expect(first).toEqual({
      kind: 'ok',
      value: { eventId: 'AAMk=', link: 'https://outlook.office365.com/owa/?itemid=AAMk' },
    });
    expect(await invokeToolForTest(create, input, ctx)).toEqual(first);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `${GRAPH}/me/events`,
      method: 'POST',
      body: {
        subject: 'Intro call',
        start: { dateTime: '2026-11-05T13:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-11-05T13:30:00', timeZone: 'UTC' },
        isAllDay: false,
        body: { contentType: 'text', content: 'Thirty minutes to meet.' },
        attendees: [{ emailAddress: { address: 'bo@acme.test' }, type: 'required' }],
        transactionId: key,
      },
    });
  });

  it('an all-day event goes as midnights, all day', async () => {
    const sent = graphAnswering(() => Response.json({ id: 'd1' }, { status: 201 }));
    await invokeToolForTest(
      create,
      { title: 'Offsite', start: '2026-11-05', end: '2026-11-07' },
      { connections: { calendar: calendar() } },
    );
    expect(sent[0]?.body).toMatchObject({
      start: { dateTime: '2026-11-05T00:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-07T00:00:00', timeZone: 'UTC' },
      isAllDay: true,
    });
  });

  it("Microsoft's refusal comes back in its words, never with the token", async () => {
    graphAnswering(() =>
      Response.json(
        { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } },
        { status: 403 },
      ),
    );
    const r = await invokeToolForTest(
      create,
      { title: 'x', start: '2026-11-05T14:00:00Z', end: '2026-11-05T15:00:00Z' },
      { connections: { calendar: calendar() } },
    );
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'Outlook refused the call (HTTP 403): ErrorAccessDenied: Access is denied.',
    );
    expect(message).not.toContain(TOKEN);
  });
});

describe('outlook calendar event update', () => {
  it('reads the event type, then patches what the call changes', async () => {
    const sent = graphAnswering(
      () => Response.json({ type: 'occurrence' }),
      () => Response.json({ id: 'AAMk=' }),
    );
    const r = await invokeToolForTest(
      update,
      { eventId: 'AAMk=', title: 'Stand-up (moved)', location: 'Room 5' },
      { connections: { calendar: calendar() } },
    );
    expect(r).toEqual({ kind: 'ok', value: { eventId: 'AAMk=' } });
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['GET', `${GRAPH}/me/events/AAMk%3D?$select=type`],
      ['PATCH', `${GRAPH}/me/events/AAMk%3D`],
    ]);
    expect(sent[1]?.body).toEqual({
      subject: 'Stand-up (moved)',
      location: { displayName: 'Room 5' },
    });
  });

  it('switches an event between a time and a day, saying which with isAllDay', async () => {
    const sent = graphAnswering(
      () => Response.json({ type: 'singleInstance' }),
      () => Response.json({ id: 'AAMk=' }),
    );
    const ctx = { connections: { calendar: calendar() } };
    const toDays = await invokeToolForTest(
      update,
      { eventId: 'AAMk=', start: '2026-11-03', end: '2026-11-04' },
      ctx,
    );
    const toTimes = await invokeToolForTest(
      update,
      { eventId: 'AAMk=', start: '2026-11-03T09:00:00+01:00', end: '2026-11-03T10:00:00+01:00' },
      ctx,
    );
    expect([toDays.kind, toTimes.kind]).toEqual(['ok', 'ok']);
    expect(sent.filter((s) => s.method === 'PATCH').map((s) => s.body)).toEqual([
      {
        start: { dateTime: '2026-11-03T00:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-11-04T00:00:00', timeZone: 'UTC' },
        isAllDay: true,
      },
      {
        start: { dateTime: '2026-11-03T08:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-11-03T09:00:00', timeZone: 'UTC' },
        isAllDay: false,
      },
    ]);
  });

  it('never changes a whole series', async () => {
    const sent = graphAnswering(() => Response.json({ type: 'seriesMaster' }));
    const r = await invokeToolForTest(
      update,
      { eventId: 'AAMk=', title: 'x' },
      { connections: { calendar: calendar() } },
    );
    expect(r.kind === 'err' && r.error.message).toContain('a whole repeating series');
    expect(sent).toHaveLength(1);
  });

  it('an event gone is said so', async () => {
    graphAnswering(() =>
      Response.json(
        { error: { code: 'ErrorItemNotFound', message: 'Not found.' } },
        { status: 404 },
      ),
    );
    const r = await invokeToolForTest(
      update,
      { eventId: 'AAMk=', title: 'x' },
      { connections: { calendar: calendar() } },
    );
    expect(r.kind === 'err' && r.error.message).toContain('Outlook found no such event');
  });

  it('refuses a start without its end, or nothing to change, and calls nothing', async () => {
    const sent = graphAnswering(() => Response.json({ type: 'singleInstance' }));
    for (const input of [
      { eventId: 'AAMk=', start: '2026-11-03T10:00:00Z' },
      { eventId: 'AAMk=' },
    ]) {
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
