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

  test("a storage error as a cause: its code and message, never its own cause's text", () => {
    // A storage error is a plain object; its cause is the driver's error,
    // whose text names the query and the values bound to it.
    const driver = Object.assign(
      new Error('Failed query: insert into "people" values ($1)\nparams: owner@acme.test'),
      { detail: 'Key (email)=(owner@acme.test) already exists.' },
    );
    const storage = {
      code: 'query-error',
      message: 'Tenant-scoped query failed: a unique constraint',
      step: 'insert people',
      cause: driver,
    };
    const err = new Error('saving the person failed', { cause: storage });
    const json = capture();
    json.log.error('save failed', { err });
    expect((json.records()[0]?.err as Record<string, unknown>).cause).toEqual({
      name: 'Object',
      code: 'query-error',
      message: 'Tenant-scoped query failed: a unique constraint',
    });
    const pretty = capture({ format: 'pretty' });
    pretty.log.error('save failed', { err });
    expect(pretty.lines[0]).toContain(
      'caused by: Object: Tenant-scoped query failed: a unique constraint (query-error)',
    );
    for (const line of [...json.lines, ...pretty.lines]) {
      expect(line).not.toContain('owner@acme.test');
      expect(line).not.toContain('Failed query');
      expect(line).not.toContain('insert people');
    }
  });

  test('a plain object as err: its own name, else Object; String(err) with neither code nor message', () => {
    const { log, records } = capture();
    log.warn('a', { err: { name: 'StorageError', code: 'database-busy', message: 'too busy' } });
    log.warn('b', { err: { code: 404 } });
    log.warn('c', { err: { reason: 'no code, no message' } });
    log.warn('d', { err: { name: 7, code: 'query-error', message: 'm' } });
    log.warn('e', { err: { name: '', code: 'query-error', message: 'm' } });
    expect(records().map((r) => r.err)).toEqual([
      { name: 'StorageError', code: 'database-busy', message: 'too busy' },
      { name: 'Object', code: '404', message: '' },
      '[object Object]',
      { name: 'Object', code: 'query-error', message: 'm' },
      { name: 'Object', code: 'query-error', message: 'm' },
    ]);
  });

  test("a plain object's message is scrubbed like an Error's", () => {
    const { log, records } = capture();
    log.warn('x', {
      err: {
        code: 'connection-error',
        message: 'postgres://app:s3cret@db.internal:5432/app refused; sent Bearer abc.def',
      },
    });
    expect(records()[0]?.err).toEqual({
      name: 'Object',
      code: 'connection-error',
      message: 'postgres://app:***@db.internal:5432/app refused; sent Bearer [redacted]',
    });
  });

  test('a plain object that resists being read never makes a log call throw', () => {
    const { log, records } = capture();
    const bare = Object.assign(Object.create(null), { reason: 'no code, no message' });
    const bareWithFields = Object.assign(Object.create(null), {
      code: 'query-error',
      message: 'm',
    });
    const throwingMessage = {
      code: 'query-error',
      get message(): string {
        throw new Error('no message today');
      },
    };
    const revocable = Proxy.revocable({ code: 'query-error' }, {});
    revocable.revoke();
    for (const err of [bare, bareWithFields, throwingMessage, revocable.proxy]) {
      expect(() => log.warn('x', { err })).not.toThrow();
    }
    expect(() => log.warn('y', { err: new Error('outer', { cause: bare }) })).not.toThrow();
    expect(records().map((r) => r.err)).toEqual([
      '[object Object]',
      { name: 'Object', code: 'query-error', message: 'm' },
      { name: 'Object', code: 'query-error', message: '' },
      '[unreadable]',
      expect.objectContaining({ message: 'outer', cause: '[object Object]' }),
    ]);
  });

  test('an Error under another key is serialized as well', () => {
    const { log, records } = capture();
    log.info('x', { failure: new RangeError('out of range') });
    expect(records()[0]?.failure).toMatchObject({ name: 'RangeError', message: 'out of range' });
  });

  test('an Error deeper in a field: name, message and code, no stack at any level, none of its other fields', () => {
    // A database error's own fields carry the values the query was bound to.
    const unique = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      detail: 'Key (email)=(owner@acme.test) already exists.',
    });
    const { log, lines, records } = capture({ level: 'debug' });
    log.error('import failed', {
      batch: { failures: [unique], last: new TypeError('outer', { cause: unique }) },
    });
    expect(records()[0]?.batch).toEqual({
      failures: [
        { name: 'Error', message: 'duplicate key value violates unique constraint', code: '23505' },
      ],
      last: {
        name: 'TypeError',
        message: 'outer',
        cause: {
          name: 'Error',
          message: 'duplicate key value violates unique constraint',
          code: '23505',
        },
      },
    });
    expect(lines[0]).not.toContain('owner@acme.test');
  });

  test('an Error that resists being read never makes a log call throw', () => {
    // A TypeError, so the name's fallback (`Error`) differs from its own.
    const resisting = (key: string): Error => {
      const err = new TypeError('m');
      // V8 writes the stack's first line, from the name and message, when
      // the stack is first read: read it now, so only `key` resists.
      void err.stack;
      return Object.defineProperty(err, key, {
        get: () => {
          throw new Error('not today');
        },
      });
    };
    const noName = resisting('name');
    const noMessage = resisting('message');
    const numericMessage = Object.assign(new Error('m'), { message: 42 });
    const noStack = resisting('stack');
    const noCause = resisting('cause');
    const all = [noName, noMessage, numericMessage, noStack, noCause];
    const { log, records } = capture();
    for (const err of all) {
      expect(() => log.error('x', { err })).not.toThrow();
      expect(() => log.error('y', { failure: err })).not.toThrow();
    }
    const errs = records().map((r) => r.err ?? r.failure) as Record<string, unknown>[];
    const shapes = errs.map(({ stack, ...rest }) => ({ ...rest, stack: typeof stack }));
    const expected = [
      { name: 'Error', message: 'm', stack: 'string' },
      { name: 'TypeError', message: '', stack: 'string' },
      { name: 'Error', message: '42', stack: 'string' },
      { name: 'TypeError', message: 'm', stack: 'undefined' },
      { name: 'TypeError', message: 'm', stack: 'string' },
    ];
    expect(shapes).toEqual(expected.flatMap((e) => [e, e]));
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

  test('a field that resists being read is [unreadable], and never makes a log call throw', () => {
    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();
    const getter = {
      a: 1,
      get b(): number {
        throw new Error('not today');
      },
    };
    const array = new Proxy([1, 2], {
      get: (target, key, receiver) => {
        if (key === '1') throw new Error('not today');
        return Reflect.get(target, key, receiver);
      },
    });
    const date = new Proxy(new Date('2026-01-02T03:04:05.000Z'), {});
    const { log, records } = capture();
    expect(() =>
      log.info('values', {
        revoked: revocable.proxy,
        getter,
        array,
        date,
        inArray: [revocable.proxy],
      }),
    ).not.toThrow();
    expect(records()[0]).toMatchObject({
      revoked: '[unreadable]',
      getter: { a: 1, b: '[unreadable]' },
      array: [1, '[unreadable]'],
      date: '[unreadable]',
      inArray: ['[unreadable]'],
    });
  });

  test("a call's own field that resists being read is [unreadable], its siblings kept", () => {
    const fields = {
      a: 1,
      get bad(): number {
        throw new Error('not today');
      },
    };
    const { log, records } = capture();
    expect(() => log.info('x', fields)).not.toThrow();
    expect(records()[0]).toMatchObject({ message: 'x', a: 1, bad: '[unreadable]' });
  });

  test("fields whose keys can't be listed still get a record written, without them", () => {
    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();
    const { log, records } = capture();
    expect(() => log.child({ runId: 'run-1' }).info('x', revocable.proxy)).not.toThrow();
    const [rec] = records();
    expect(rec).toMatchObject({ message: 'x', runId: 'run-1' });
    expect(rec).not.toHaveProperty('a');
  });

  test("a child's binding that resists being read is [unreadable] on its records", () => {
    const bindings = {
      runId: 'run-1',
      get bad(): number {
        throw new Error('not today');
      },
    };
    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();
    const { log, records } = capture();
    expect(() => log.child(bindings).info('x')).not.toThrow();
    expect(() => log.child(revocable.proxy).info('y')).not.toThrow();
    const [x, y] = records();
    expect(x).toMatchObject({ message: 'x', runId: 'run-1', bad: '[unreadable]' });
    expect(y).toMatchObject({ message: 'y' });
    expect(y).not.toHaveProperty('a');
  });

  test('noopLogger writes nothing, and its children are no-ops too', () => {
    expect(() => noopLogger.child({ subsystem: 'x' }).error('nothing')).not.toThrow();
    expect(noopLogger.isLevelEnabled('error')).toBe(false);
  });
});
