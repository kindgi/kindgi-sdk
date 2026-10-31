// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { type ToolConnection, invokeToolForTest } from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  outlookCalendarEventCreate,
  outlookCalendarEventUpdate,
  outlookCalendarEventsList,
  outlookCalendarFreeBusy,
} from '../src/microsoft-tools.js';

const TOKEN = 'eyJ0eXAi.not-a-real-token';
const GRAPH = 'https://graph.microsoft.com/v1.0';

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
    for (const tool of [list, freeBusy]) {
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
});

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
});
