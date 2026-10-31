// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the calendar tools take and give, the same for Google and Outlook:
 * an event, a busy time, and how a time is written. Not a package
 * subpath: the tools' subpaths export the types.
 */

import type { AppToolOptions } from './app-tool.js';
import { MAIL_PERSON } from './mail-schema.js';
import { LIST_MAX, clipText, clippedPerson } from './mail-text.js';
import type { MailPerson } from './mail.js';

/** Whose calendar a calendar tool uses. */
export type CalendarOwner = 'person' | 'company';

/** What a pack gives one of the calendar tools: its id, and whose calendar it uses. */
export interface CalendarToolOptions extends AppToolOptions {
  /**
   * Whose calendar: `'person'` (the default), the run's person's own, in
   * the account they connected; `'company'`, the company's, which a
   * tenant admin connected by signing in as it. It's part of what the
   * tool declares, so give a company calendar its own tool id
   * (`acme.store-calendar.create`).
   */
  readonly as?: CalendarOwner;
}

/** How someone invited answered. */
export type CalendarResponse = 'accepted' | 'declined' | 'tentative' | 'none';

/** Someone invited to an event, and their answer. */
export interface CalendarAttendee extends MailPerson {
  readonly response: CalendarResponse;
}

/**
 * An event on the calendar. A time is in UTC (`2026-11-03T09:00:00Z`); an
 * event that lasts all day gives days (`2026-11-03`), its `end` the day
 * after its last.
 */
export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  /** Its place, as the calendar names it. */
  readonly location?: string;
  readonly organizer?: MailPerson;
  /** The first 20, each cut as a mail's people are. */
  readonly attendees: readonly CalendarAttendee[];
  /** How many past those 20. */
  readonly attendeesLeftOut?: number;
  /** Whether its time counts as busy: `false` for one marked free. */
  readonly busy: boolean;
  /** Its page in the calendar, for a person to open. */
  readonly link?: string;
}

/** A busy time, in UTC. */
export interface CalendarBusy {
  readonly start: string;
  readonly end: string;
}

/** What a create or an update answers. */
export interface CalendarEventWritten {
  readonly eventId: string;
  /** Its page in the calendar. */
  readonly link?: string;
}

/** The longest window a list or a free/busy reads. */
export const WINDOW_DAYS = 31;

/** Events a list gives, unless the call asks for fewer. */
export const LIST_DEFAULT = 25;

/** A time with its offset (RFC 3339), or a day. */
export const TIME_OR_DAY = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2}))?$',
} as const;

/** A time with its offset (RFC 3339). */
export const TIME = { type: 'string', format: 'date-time' } as const;

/** An address to invite. Line breaks and list separators are refused, as for mail. */
export const ATTENDEE_ADDRESS = {
  type: 'string',
  format: 'email',
  maxLength: 254,
  pattern: '^[^\\r\\n,;<>"]+$',
} as const;

/** What a create or an update takes, but the event's id. */
export const EVENT_FIELDS = {
  title: { type: 'string', minLength: 1, maxLength: 500, pattern: '^[^\\r\\n]+$' },
  start: TIME_OR_DAY,
  end: TIME_OR_DAY,
  location: { type: 'string', minLength: 1, maxLength: 500, pattern: '^[^\\r\\n]+$' },
  description: { type: 'string', minLength: 1, maxLength: 8000 },
  attendees: { type: 'array', maxItems: 100, items: ATTENDEE_ADDRESS },
} as const;

/** A `CalendarAttendee`. */
const ATTENDEE = {
  type: 'object',
  additionalProperties: false,
  required: ['address', 'response'],
  properties: {
    ...MAIL_PERSON.properties,
    response: { enum: ['accepted', 'declined', 'tentative', 'none'] },
  },
} as const;

/** A `CalendarEvent`. */
export const CALENDAR_EVENT = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'start', 'end', 'allDay', 'attendees', 'busy'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    allDay: { type: 'boolean' },
    location: { type: 'string' },
    organizer: MAIL_PERSON,
    attendees: { type: 'array', items: ATTENDEE },
    attendeesLeftOut: { type: 'integer', minimum: 1 },
    busy: { type: 'boolean' },
    link: { type: 'string' },
  },
} as const;

/** A list's answer. */
export const EVENTS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: { events: { type: 'array', items: CALENDAR_EVENT } },
} as const;

/** A free/busy's answer. */
export const BUSY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['busy'],
  properties: {
    busy: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: { start: { type: 'string' }, end: { type: 'string' } },
      },
    },
  },
} as const;

/** A create's or an update's answer. */
export const WRITTEN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['eventId'],
  properties: { eventId: { type: 'string' }, link: { type: 'string' } },
} as const;

/** When an event starts or ends, as a call gives it: a time, or a day. */
export type EventTime =
  | { readonly kind: 'time'; readonly at: Date }
  | { readonly kind: 'day'; readonly day: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `value` as a time or a day, or a thrown error naming `field`. */
export function eventTime(value: string, field: string): EventTime {
  if (DAY.test(value)) {
    // A day that doesn't exist (`2026-02-30`) parses to another one.
    const at = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value) {
      throw new Error(`\`${field}\` is ${value}, which isn't a day.`);
    }
    return { kind: 'day', day: value };
  }
  return { kind: 'time', at: instant(value, field) };
}

/**
 * An event's `start` and `end`: both times, or both days, the end after
 * the start.
 */
export function eventSpan(
  start: string,
  end: string,
): { readonly start: EventTime; readonly end: EventTime } {
  const s = eventTime(start, 'start');
  const e = eventTime(end, 'end');
  if (s.kind !== e.kind) {
    throw new Error(
      '`start` and `end` are both times (an event at a time) or both days (one that lasts all day).',
    );
  }
  const after = s.kind === 'day' && e.kind === 'day' ? e.day > s.day : instantOf(e) > instantOf(s);
  if (!after) throw new Error('`end` is after `start`.');
  return { start: s, end: e };
}

/** An update's new `start` and `end`, which go together; `undefined` when it changes neither. */
export function updatedSpan(
  start: string | undefined,
  end: string | undefined,
): { readonly start: EventTime; readonly end: EventTime } | undefined {
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined || end === undefined) throw new Error('`start` and `end` go together.');
  return eventSpan(start, end);
}

/** The window a list or a free/busy reads: `from` before `to`, at most `WINDOW_DAYS` apart. */
export function eventWindow(from: string, to: string): { readonly from: Date; readonly to: Date } {
  const f = instant(from, 'from');
  const t = instant(to, 'to');
  if (t <= f) throw new Error('`to` is after `from`.');
  if (t.getTime() - f.getTime() > WINDOW_DAYS * 86_400_000) {
    throw new Error(`The window is at most ${WINDOW_DAYS} days.`);
  }
  return { from: f, to: t };
}

/** A time in UTC, to the second: `2026-11-03T09:00:00Z`. */
export function utc(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The first 20 attendees, cut as a mail's people are, and how many past them. */
export function listedAttendees(
  all: readonly CalendarAttendee[],
): Pick<CalendarEvent, 'attendees' | 'attendeesLeftOut'> {
  const past = Math.max(all.length - LIST_MAX, 0);
  return {
    attendees: all.slice(0, LIST_MAX).map((a) => ({ ...clippedPerson(a), response: a.response })),
    ...(past > 0 && { attendeesLeftOut: past }),
  };
}

/** The longest title or place a read gives. */
const LINE_MAX = 1_024;

/** A title or a place as the calendar gives it, cut at 1,024 characters. */
export function clippedLine(text: string): string {
  return clipText(text, LINE_MAX);
}

/**
 * Busy times as one list: sorted, and those that overlap or touch made
 * one.
 */
export function mergedBusy(times: readonly CalendarBusy[]): CalendarBusy[] {
  const sorted = [...times].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: CalendarBusy[] = [];
  for (const t of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && t.start <= last.end) {
      if (t.end > last.end) merged[merged.length - 1] = { start: last.start, end: t.end };
    } else {
      merged.push(t);
    }
  }
  return merged;
}

function instant(value: string, field: string): Date {
  const at = new Date(value);
  if (DAY.test(value) || Number.isNaN(at.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(
      `\`${field}\` is ${value}: give a time with its offset (2026-11-03T09:00:00Z).`,
    );
  }
  return at;
}

function instantOf(t: EventTime): number {
  return t.kind === 'time' ? t.at.getTime() : Date.parse(`${t.day}T00:00:00Z`);
}
