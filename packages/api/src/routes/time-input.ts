// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one rule for a time the API reads: a caller's (a query value or a
 * body field, `format: date-time` in the spec) and a cursor's alike.
 *
 * It takes ISO 8601 with a time and a zone (`2026-10-09T12:00:00Z`,
 * `2026-10-09T14:00:00.5+02:00`) or Postgres's `timestamptz` text, which a
 * cursor carries (`2026-10-09 12:00:00.123456+00`, any zone offset), and it
 * must name a real calendar time. `Date.parse` alone took `"1"`, `"x 1"`
 * and `"Oct 9"`, a date with no time, and a time with no zone, which it
 * reads in the server's zone. Such a value got past a route's check and
 * then failed at a binding's `::timestamptz`, or named a different
 * instant than the caller meant.
 */

const TIME_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?)$/;

/** The instant `value` names, or `null` when it isn't a time this rule takes. */
export function parseTimeInput(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parts = TIME_INPUT.exec(value);
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fraction = parts[7] ?? '';
  const sign = parts[8] === '-' ? -1 : 1;
  const [offsetHours, offsetMinutes, offsetSeconds] = [parts[9], parts[10], parts[11]].map((p) =>
    Number(p ?? 0),
  ) as [number, number, number];

  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    year >= 1000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60 &&
    offsetHours < 16 &&
    offsetMinutes < 60 &&
    offsetSeconds < 60;
  if (!real) return null;

  const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
  const offset = sign * ((offsetHours * 60 + offsetMinutes) * 60 + offsetSeconds) * 1000;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset);
}

/** Whether `value` is a time this rule takes. */
export function isTimeInput(value: unknown): value is string {
  return parseTimeInput(value) !== null;
}
