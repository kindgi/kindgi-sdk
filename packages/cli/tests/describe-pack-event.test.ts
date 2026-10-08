// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The lines `kindgi dev` prints for what the pack service reports. */

import { describe, expect, test } from 'vitest';

import { describePackEvent } from '../src/dev/pack-service.js';

const log = (event: Record<string, unknown>) => ({ kind: 'log', event }) as never;

describe('describePackEvent', () => {
  test("the pack service's missing env names: one line, saying where to add them", () => {
    expect(
      describePackEvent(log({ kind: 'missing-env', check: 'warn', names: ['DATABASE_URL'] })),
    ).toBe(
      "  ⚠ the pack's env.required name DATABASE_URL has no value: add it to the pack's env files (a deployment won't be ready without it)",
    );
    expect(
      describePackEvent(log({ kind: 'missing-env', check: 'warn', names: ['A_URL', 'B_URL'] })),
    ).toBe(
      "  ⚠ the pack's env.required names A_URL, B_URL have no value: add them to the pack's env files (a deployment won't be ready without them)",
    );
  });

  test('a failed call gets a line; a good one and other log lines do not', () => {
    expect(
      describePackEvent(log({ kind: 'call', id: 'acme.lookup', outcome: 'handler-throw' })),
    ).toBe('  [pack] ✗ acme.lookup: handler-throw');
    expect(
      describePackEvent(log({ kind: 'call', id: 'acme.lookup', outcome: 'ok' })),
    ).toBeUndefined();
    expect(describePackEvent(log({ kind: 'listening', port: 1 }))).toBeUndefined();
  });

  test("what the pack's code logs (ctx.log): a [pack] line, its level shown unless info", () => {
    expect(
      describePackEvent(
        log({ kind: 'record', level: 'info', subsystem: 'pack.tool', message: 'looked up order' }),
      ),
    ).toBe('  [pack] looked up order');
    expect(
      describePackEvent(
        log({ kind: 'record', level: 'warn', subsystem: 'pack.tool', message: 'slow lookup' }),
      ),
    ).toBe('  [pack] WARN slow lookup');
  });
});
