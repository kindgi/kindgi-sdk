// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A time flag (`--since`, `--as-of`, `--created-after`, `--expires`,
 * `--published-at`, `--rotation-due-at`) goes to the API as `toISOString()`:
 * the API takes a `date-time` (a time with a zone) and refuses a bare date
 * with 400. The CLI takes a date too (that day's start in UTC), and
 * refuses anything else itself, before any call.
 */

import { describe, expect, test } from 'vitest';

import { timeFlagValue } from '../src/commands/helpers.js';
import { UsageError } from '../src/errors.js';

describe('timeFlagValue', () => {
  test.each([
    ['2026-10-09', '2026-10-09T00:00:00.000Z'],
    ['2026-10-09T12:00:00Z', '2026-10-09T12:00:00.000Z'],
    ['2026-10-09T14:00:00.5+02:00', '2026-10-09T12:00:00.500Z'],
    ['2026-10-09T07:30:00-04:30', '2026-10-09T12:00:00.000Z'],
    ['2028-02-29', '2028-02-29T00:00:00.000Z'],
  ])('%s is sent as %s', (raw, sent) => {
    expect(timeFlagValue(raw, 'since')).toBe(sent);
  });

  test.each([
    ['Oct 9'],
    ['1'],
    ['2026-10-09T12:00:00'],
    ['2026-10-09T12:00'],
    ['2026-02-30'],
    ['2026-02-29'],
    ['2026-10-09T24:00:00Z'],
    ['10/09/2026'],
  ])('refuses %j, naming the flag and the forms it takes', (raw) => {
    expect(() => timeFlagValue(raw, 'since')).toThrow(UsageError);
    expect(() => timeFlagValue(raw, 'since')).toThrow(
      /--since must be an ISO 8601 time with a zone \(2026-10-09T12:00:00Z\) or a date \(2026-10-09\)/,
    );
  });
});
