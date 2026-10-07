// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { type CreateLoggerOptions, createLogger, noopLogger } from '../src/index.js';

const NOW = new Date('2026-10-07T21:58:03.120Z');

function capture(options: Partial<CreateLoggerOptions> = {}) {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l), now: () => NOW, ...options });
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, lines, records };
}

describe('levels', () => {
  test('the default is info: debug and trace are not written', () => {
    const { log, records } = capture();
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(records().map((r) => r.level)).toEqual(['info', 'warn', 'error']);
  });

  test("a subsystem's own level, else its nearest dotted parent's, else the logger's", () => {
    const { log, records } = capture({
      level: 'warn',
      levels: { kernel: 'debug', 'kernel.sweeper': 'error' },
    });
    log.child({ subsystem: 'kernel' }).debug('kernel debug');
    log.child({ subsystem: 'kernel.leases' }).debug('inherits kernel');
    log.child({ subsystem: 'kernel.sweeper' }).warn('sweeper warn: below its own error');
    log.child({ subsystem: 'http' }).info('http info: below warn');
    log.child({ subsystem: 'http' }).warn('http warn');
    expect(records().map((r) => r.message)).toEqual([
      'kernel debug',
      'inherits kernel',
      'http warn',
    ]);
  });

  test('isLevelEnabled answers for the subsystem', () => {
    const { log } = capture({ levels: { db: 'trace' } });
    expect(log.isLevelEnabled('debug')).toBe(false);
    expect(log.child({ subsystem: 'db' }).isLevelEnabled('trace')).toBe(true);
  });
});

describe('the record', () => {
  test('time, level, severity, subsystem and message first; correlation ids next; then the fields', () => {
    const { log, lines } = capture();
    log
      .child({ subsystem: 'leases', tenantId: 't-1' })
      .warn('could not expire the lease of run r-1', {
        runId: 'r-1',
        attempts: 2,
        traceId: 'a'.repeat(32),
      });
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: '2026-10-07T21:58:03.120Z',
      level: 'warn',
      severity: 'WARNING',
      subsystem: 'leases',
      message: 'could not expire the lease of run r-1',
      traceId: 'a'.repeat(32),
      tenantId: 't-1',
      runId: 'r-1',
      attempts: 2,
    });
    expect(Object.keys(JSON.parse(lines[0] as string))).toEqual([
      'time',
      'level',
      'severity',
      'subsystem',
      'message',
      'traceId',
      'tenantId',
      'runId',
      'attempts',
    ]);
  });

  test('a record with no subsystem binding is root; trace maps to DEBUG severity', () => {
    const { log, records } = capture({ level: 'trace' });
    log.trace('deep');
    expect(records()[0]).toMatchObject({ subsystem: 'root', level: 'trace', severity: 'DEBUG' });
  });

  test("a child's bindings ride on every record; a later child's subsystem replaces its parent's", () => {
    const { log, records } = capture();
    const run = log.child({ subsystem: 'runs', runId: 'r-1' });
    run.info('started');
    run.child({ subsystem: 'runs.turn', agentId: 'acme.agent' }).info('turn');
    expect(records()).toMatchObject([
      { subsystem: 'runs', runId: 'r-1', message: 'started' },
      { subsystem: 'runs.turn', runId: 'r-1', agentId: 'acme.agent', message: 'turn' },
    ]);
  });

  test("a field can't replace the record's own five: it's kept under fields", () => {
    const { log, records } = capture();
    log.info('real', { message: 'fake', level: 'error', time: 'x', other: 1 });
    expect(records()[0]).toMatchObject({
      message: 'real',
      level: 'info',
      time: '2026-10-07T21:58:03.120Z',
      other: 1,
      fields: { message: 'fake', level: 'error', time: 'x' },
    });
  });
});

describe('errors', () => {
  test('err is serialized: name, message, code; its stack at error level', () => {
    const { log, records } = capture();
    const err = Object.assign(new Error('the database stops answering'), { code: 'ECONNREFUSED' });
    log.error('ready check failed', { err });
    log.warn('retrying', { err });
    const [atError, atWarn] = records() as Record<string, Record<string, unknown>>[];
    expect(atError?.err).toMatchObject({
      name: 'Error',
      message: 'the database stops answering',
      code: 'ECONNREFUSED',
    });
    expect(String(atError?.err?.stack)).toContain('at ');
    expect(atWarn?.err).not.toHaveProperty('stack');
  });

  test('a logger at debug includes the stack at any level; a cause is serialized too', () => {
    const { log, records } = capture({ level: 'debug' });
    log.warn('wrapped', { err: new Error('outer', { cause: new TypeError('inner') }) });
    const err = records()[0]?.err as Record<string, unknown>;
    expect(err.stack).toBeDefined();
    expect(err.cause).toMatchObject({ name: 'TypeError', message: 'inner' });
  });

  test('an Error under another key is serialized as well', () => {
    const { log, records } = capture();
    log.info('x', { failure: new RangeError('out of range') });
    expect(records()[0]?.failure).toMatchObject({ name: 'RangeError', message: 'out of range' });
  });
});

describe('robustness', () => {
  test('a sink that throws never reaches the caller', () => {
    const log = createLogger({
      write: () => {
        throw new Error('disk full');
      },
    });
    expect(() => log.info('still fine')).not.toThrow();
  });

  test('bigints, dates and cycles are written', () => {
    const { log, records } = capture();
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    log.info('values', { big: 10n, at: new Date('2026-01-02T03:04:05.000Z'), cyclic });
    expect(records()[0]).toMatchObject({
      big: '10',
      at: '2026-01-02T03:04:05.000Z',
      cyclic: { name: 'a', self: '[circular]' },
    });
  });

  test('noopLogger writes nothing, and its children are no-ops too', () => {
    expect(() => noopLogger.child({ subsystem: 'x' }).error('nothing')).not.toThrow();
    expect(noopLogger.isLevelEnabled('error')).toBe(false);
  });
});
