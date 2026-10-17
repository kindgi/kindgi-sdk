// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** What `kindgi dev` prints for what the pack service reports. */

import { describe, expect, test } from 'vitest';

import { type LogFields, type LogOptions, createLogger } from '@kindgi/log';

import { DEFAULT_DEV_LOG_VIEW, type DevLogView } from '../src/dev/log-view.js';
import { showPackEvent } from '../src/dev/pack-service.js';

const AT = new Date('2026-10-07T14:02:11.130Z');

/** A record line as the pack service writes it, at `level` under `subsystem`. */
function recordLine(
  level: 'error' | 'warn' | 'info' | 'debug',
  subsystem: string,
  message: string,
  fields: LogFields = {},
  how?: LogOptions,
): string {
  const lines: string[] = [];
  createLogger({ level: 'trace', write: (l) => lines.push(l), now: () => AT })
    .child({ subsystem })
    [level](message, fields, how);
  return lines[0] ?? '';
}

/** The supervisor's event for a line: its own records by `event`, any other as `record`. */
function logEvent(line: string) {
  const fields = JSON.parse(line) as Record<string, unknown>;
  const own = fields.subsystem === 'pack' && typeof fields.event === 'string';
  const kind = 'time' in fields ? (own ? fields.event : 'record') : fields.kind;
  return { kind: 'log', event: { ...fields, kind }, line } as const;
}

/** A bare event, from a pack service from before records. */
function bareEvent(event: Record<string, unknown>) {
  return { kind: 'log', event, line: JSON.stringify(event) } as const;
}

const PRETTY = DEFAULT_DEV_LOG_VIEW;
const JSON_VIEW: DevLogView = { ...PRETTY, format: 'json' };
const QUIET: DevLogView = { ...PRETTY, quiet: true, level: 'error' };

const MISSING_ONE =
  "⚠ the pack's env.required name DATABASE_URL has no value: add it to the pack's env files (a deployment won't be ready without it)";

describe('showPackEvent — records', () => {
  test('a call: one [pack] line, without the fields its message states', () => {
    const line = recordLine(
      'info',
      'pack',
      'tool acme.lookup ok 12ms',
      {
        runId: 'run-1',
        event: 'call',
        kind: 'call',
        id: 'acme.lookup',
        outcome: 'ok',
        durationMs: 12,
      },
      { inMessage: ['target', 'id', 'outcome', 'durationMs'] },
    );
    expect(showPackEvent(logEvent(line), PRETTY)).toEqual([
      {
        stream: 'stderr',
        lines: [
          '[pack] 14:02:11.130 INFO  [pack] tool acme.lookup ok 12ms runId=run-1 event=call kind=call',
        ],
      },
    ]);
  });

  test("what the pack's code logs (ctx.log): a [pack] line with its level and subsystem", () => {
    const line = recordLine('warn', 'pack.tool', 'slow lookup', { orderId: 'o-1' });
    expect(showPackEvent(logEvent(line), PRETTY)).toEqual([
      {
        stream: 'stderr',
        lines: ['[pack] 14:02:11.130 WARN  [pack.tool] slow lookup orderId=o-1'],
      },
    ]);
  });

  test('a level below the view is left out; a subsystem raised with --log is shown', () => {
    const line = recordLine('debug', 'pack.tool', 'cache hit');
    expect(showPackEvent(logEvent(line), PRETTY)).toEqual([]);
    expect(showPackEvent(logEvent(line), { ...PRETTY, levels: { pack: 'debug' } })).toHaveLength(1);
  });

  test("the service's lifecycle stays out of the pretty view; --log-format=json passes it on", () => {
    const line = recordLine('info', 'pack', 'draining', { event: 'draining', kind: 'draining' });
    expect(showPackEvent(logEvent(line), PRETTY)).toEqual([]);
    expect(showPackEvent(logEvent(line), JSON_VIEW)).toEqual([{ stream: 'stdout', lines: [line] }]);
  });

  test('--log-format=json: a record as written, on stdout', () => {
    const line = recordLine('warn', 'pack.tool', 'slow lookup');
    expect(showPackEvent(logEvent(line), JSON_VIEW)).toEqual([{ stream: 'stdout', lines: [line] }]);
  });

  test('missing env: one line saying where to add it (and the record too, as JSON)', () => {
    const line = recordLine(
      'warn',
      'pack',
      "The pack's env.required name has no value: DATABASE_URL",
      { event: 'missing-env', kind: 'missing-env', check: 'warn', names: ['DATABASE_URL'] },
    );
    expect(showPackEvent(logEvent(line), PRETTY)).toEqual([
      { stream: 'stderr', lines: [MISSING_ONE] },
    ]);
    expect(showPackEvent(logEvent(line), JSON_VIEW)).toEqual([
      { stream: 'stdout', lines: [line] },
      { stream: 'stderr', lines: [MISSING_ONE] },
    ]);
  });

  test('--quiet: an error record is shown; a warning is not', () => {
    const error = recordLine('error', 'pack.tool', 'lookup failed');
    const warn = recordLine('warn', 'pack.tool', 'slow lookup');
    expect(showPackEvent(logEvent(error), QUIET)).toHaveLength(1);
    expect(showPackEvent(logEvent(warn), QUIET)).toEqual([]);
  });
});

describe('showPackEvent — a pack service from before records', () => {
  test('missing env names: one line, saying where to add them', () => {
    expect(
      showPackEvent(
        bareEvent({ kind: 'missing-env', check: 'warn', names: ['DATABASE_URL'] }),
        PRETTY,
      ),
    ).toEqual([{ stream: 'stderr', lines: [MISSING_ONE] }]);
    expect(
      showPackEvent(
        bareEvent({ kind: 'missing-env', check: 'warn', names: ['A_URL', 'B_URL'] }),
        PRETTY,
      ),
    ).toEqual([
      {
        stream: 'stderr',
        lines: [
          "⚠ the pack's env.required names A_URL, B_URL have no value: add them to the pack's env files (a deployment won't be ready without them)",
        ],
      },
    ]);
  });

  test('a failed call gets a line; a good one and other events do not', () => {
    expect(
      showPackEvent(
        bareEvent({ kind: 'call', id: 'acme.lookup', outcome: 'handler-throw' }),
        PRETTY,
      ),
    ).toEqual([{ stream: 'stderr', lines: ['[pack] ✗ acme.lookup: handler-throw'] }]);
    expect(
      showPackEvent(bareEvent({ kind: 'call', id: 'acme.lookup', outcome: 'ok' }), PRETTY),
    ).toEqual([]);
    expect(showPackEvent(bareEvent({ kind: 'listening', port: 1 }), PRETTY)).toEqual([]);
  });
});

describe('showPackEvent — crashes', () => {
  test('an exit is a warning (not under --quiet); giving up is an error (always)', () => {
    const exited = { kind: 'exited', code: 1, signal: null } as const;
    const gaveUp = { kind: 'gave-up', attempts: 5 } as const;
    expect(showPackEvent(exited, PRETTY)).toEqual([
      { stream: 'stderr', lines: ['⚠ pack service exited (1) — restarting'] },
    ]);
    expect(showPackEvent(exited, QUIET)).toEqual([]);
    expect(showPackEvent(gaveUp, QUIET)).toEqual([
      {
        stream: 'stderr',
        lines: ['✗ pack service kept exiting (5 restarts) — fix the code and save to retry'],
      },
    ]);
  });
});
