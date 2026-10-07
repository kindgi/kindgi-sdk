// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  childSpan,
  createLogger,
  formatTraceparent,
  loggerFromEnv,
  newTraceContext,
  parseLogLevels,
  parseTraceparent,
  resolveLogFormat,
  traceFromHeader,
} from '../src/index.js';

const GOOD = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('traceparent', () => {
  test('a valid header gives its trace id, parent span and flags', () => {
    expect(parseTraceparent(GOOD)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      flags: '01',
    });
  });

  test.each([
    ['absent', undefined],
    ['empty', ''],
    ['garbage', 'not-a-traceparent'],
    ['uppercase hex', GOOD.toUpperCase()],
    ['all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
    ['version ff', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['version 00 with a fifth field', `${GOOD}-extra`],
    ['a short trace id', '00-4bf92f3577b34da6-00f067aa0ba902b7-01'],
  ])('%s is ignored', (_name, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  test('a future version is read by its first four fields', () => {
    expect(
      parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-more'),
    ).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
  });

  test('a fresh trace, a child span in it, and their header form', () => {
    const root = newTraceContext();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    const child = childSpan(root);
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.spanId).not.toBe(root.spanId);
    expect(parseTraceparent(formatTraceparent(child))).toMatchObject({
      traceId: root.traceId,
      parentSpanId: child.spanId,
    });
  });

  test("a request honours the caller's trace, and replaces a malformed one", () => {
    const honoured = traceFromHeader(GOOD);
    expect(honoured.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(honoured.parentSpanId).toBe('00f067aa0ba902b7');
    const replaced = traceFromHeader('00-zzz');
    expect(replaced.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(replaced.parentSpanId).toBeUndefined();
  });
});

describe('the pretty format', () => {
  test('HH:MM:SS.mmm LEVEL [subsystem] message key=value; an error with its frames after', () => {
    const lines: string[] = [];
    const log = createLogger({
      format: 'pretty',
      write: (l) => lines.push(l),
      now: () => new Date('2026-10-07T21:58:03.120Z'),
    });
    log
      .child({ subsystem: 'leases' })
      .warn('expired 2 leases', { runId: 'r-1', note: 'two words' });
    log.error('sweep failed', { err: new Error('boom') });
    expect(lines[0]).toBe(
      '21:58:03.120 WARN  [leases] expired 2 leases runId=r-1 note="two words"',
    );
    expect(lines[1]).toMatch(
      /^21:58:03\.120 ERROR \[root\] sweep failed err="Error: boom"\n {4}at /,
    );
  });

  test('fields the message states (inMessage) are left out of the line, and kept in JSON', () => {
    const at = () => new Date('2026-10-07T21:58:03.120Z');
    const lines: string[] = [];
    const fields = {
      method: 'POST',
      route: '/v1/runs',
      status: 201,
      durationMs: 12,
      tenantId: 't-1',
    };
    const how = { inMessage: ['method', 'route', 'status', 'durationMs'] };
    createLogger({ format: 'pretty', write: (l) => lines.push(l), now: at })
      .child({ subsystem: 'http' })
      .info('POST /v1/runs 201 12ms', fields, how);
    expect(lines[0]).toBe('21:58:03.120 INFO  [http] POST /v1/runs 201 12ms tenantId=t-1');
    createLogger({ format: 'json', write: (l) => lines.push(l), now: at }).info(
      'POST /v1/runs 201 12ms',
      fields,
      how,
    );
    expect(JSON.parse(lines[1] ?? '')).toMatchObject(fields);
  });

  test('colours only when asked', () => {
    const lines: string[] = [];
    createLogger({ format: 'pretty', color: true, write: (l) => lines.push(l) }).info('x');
    expect(lines[0]).toContain('\u001b[');
  });
});

describe('KINDGI_LOG_LEVELS', () => {
  test('a comma list of subsystem=level; spaces and case are fine; empty is none', () => {
    expect(parseLogLevels(' kernel=DEBUG , http=warn ')).toEqual({
      kind: 'ok',
      levels: { kernel: 'debug', http: 'warn' },
    });
    expect(parseLogLevels('')).toEqual({ kind: 'ok', levels: {} });
  });

  test.each(['kernel', 'kernel=loud', '=debug'])('"%s" is refused, quoting it', (raw) => {
    const parsed = parseLogLevels(raw);
    expect(parsed.kind).toBe('err');
    expect(parsed.kind === 'err' && parsed.message).toContain(`"${raw}"`);
  });
});

describe('loggerFromEnv', () => {
  test('auto is pretty on a terminal or in development mode, and JSON otherwise', () => {
    expect(resolveLogFormat(undefined, { isTTY: true })).toBe('pretty');
    expect(resolveLogFormat('auto', { isTTY: false, dev: true })).toBe('pretty');
    expect(resolveLogFormat('auto', { isTTY: false })).toBe('json');
    expect(resolveLogFormat('PRETTY', { isTTY: false })).toBe('pretty');
    expect(resolveLogFormat('xml', { isTTY: false })).toBeUndefined();
  });

  test('the three variables become the root logger', () => {
    const lines: string[] = [];
    const got = loggerFromEnv({
      env: {
        KINDGI_LOG_LEVEL: 'warn',
        KINDGI_LOG_LEVELS: 'kernel=debug',
        KINDGI_LOG_FORMAT: 'json',
      },
      write: (l) => lines.push(l),
    });
    if (got.kind !== 'ok') throw new Error(got.message);
    got.logger.info('dropped');
    got.logger.child({ subsystem: 'kernel.sweeper' }).debug('kept');
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(['kept']);
    expect(got.problems).toEqual([]);
  });

  test('an unknown level or format refuses, naming the variable', () => {
    expect(loggerFromEnv({ env: { KINDGI_LOG_LEVEL: 'loud' } })).toEqual({
      kind: 'err',
      message: 'KINDGI_LOG_LEVEL must be one of error, warn, info, debug, trace, got "loud".',
    });
    expect(loggerFromEnv({ env: { KINDGI_LOG_LEVELS: 'kernel=loud' } })).toMatchObject({
      kind: 'err',
      message: expect.stringContaining('KINDGI_LOG_LEVELS: "kernel=loud"'),
    });
    expect(loggerFromEnv({ env: { KINDGI_LOG_FORMAT: 'xml' } })).toMatchObject({
      kind: 'err',
      message: 'KINDGI_LOG_FORMAT must be auto, json or pretty, got "xml".',
    });
  });

  test('an unknown subsystem is a problem to report, not a refusal; a dotted child of a known one is fine', () => {
    const got = loggerFromEnv({
      env: { KINDGI_LOG_LEVELS: 'kernal=debug,kernel.sweeper=trace' },
      subsystems: ['kernel', 'http'],
      write: () => undefined,
    });
    expect(got).toMatchObject({
      kind: 'ok',
      problems: [
        'KINDGI_LOG_LEVELS names "kernal", which no subsystem logs under; it has no effect.',
      ],
    });
  });

  test('KINDGI_DEV=true under auto is pretty: a newer runtime under an older kindgi dev', () => {
    const lines: string[] = [];
    const got = loggerFromEnv({ env: { KINDGI_DEV: 'true' }, write: (l) => lines.push(l) });
    if (got.kind !== 'ok') throw new Error(got.message);
    got.logger.info('readable');
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} INFO {2}\[root\] readable$/);
  });

  test('NO_COLOR turns colours off on a terminal', () => {
    const lines: string[] = [];
    const got = loggerFromEnv({ env: { NO_COLOR: '1' }, isTTY: true, write: (l) => lines.push(l) });
    if (got.kind !== 'ok') throw new Error(got.message);
    got.logger.info('plain');
    expect(lines[0]).not.toContain('\u001b[');
  });
});
