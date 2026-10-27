// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { createLogger, describeCauses } from '../src/index.js';

/** An error with a `code`, as Node and undici make them. */
function coded(name: string, message: string, code: string, cause?: unknown): Error {
  const err = new Error(message, cause === undefined ? undefined : { cause });
  err.name = name;
  return Object.assign(err, { code });
}

const CONNECT_TIMEOUT = coded(
  'ConnectTimeoutError',
  'Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)',
  'UND_ERR_CONNECT_TIMEOUT',
);

describe('describeCauses', () => {
  test('an error with no cause, or a value that is not an error, has none', () => {
    expect(describeCauses(new Error('No order Z-9'))).toBe('');
    expect(describeCauses('fetch failed')).toBe('');
    expect(describeCauses({ message: 'x', cause: new Error('y') })).toBe('');
    expect(describeCauses(undefined)).toBe('');
  });

  test("fetch's failure says undici's reason, in Node's Name [code]: message form", () => {
    const err = new TypeError('fetch failed', { cause: CONNECT_TIMEOUT });
    expect(describeCauses(err)).toBe(
      '; caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)',
    );
  });

  test("a refused connection's AggregateError says its errors, its code kept", () => {
    const refused = Object.assign(
      new AggregateError(
        [
          coded('Error', 'connect ECONNREFUSED ::1:4000', 'ECONNREFUSED'),
          coded('Error', 'connect ECONNREFUSED 127.0.0.1:4000', 'ECONNREFUSED'),
          coded('Error', 'connect ECONNREFUSED 127.0.0.1:4000', 'ECONNREFUSED'),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    );
    expect(describeCauses(new TypeError('fetch failed', { cause: refused }))).toBe(
      '; caused by AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:4000, connect ECONNREFUSED 127.0.0.1:4000',
    );
  });

  test('an empty message with a code and no errors is Name [code] alone', () => {
    const err = new Error('outer', { cause: coded('SystemError', '', 'EPIPE') });
    expect(describeCauses(err)).toBe('; caused by SystemError [EPIPE]');
  });

  test("a code the cause's message already holds isn't said twice", () => {
    const err = new Error('outer', {
      cause: coded('Error', 'connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED'),
    });
    expect(describeCauses(err)).toBe('; caused by Error: connect ECONNREFUSED 127.0.0.1:443');
  });

  test('three causes are said, and no more', () => {
    let chain: Error = new Error('c5');
    for (const message of ['c4', 'c3', 'c2', 'c1']) chain = new Error(message, { cause: chain });
    expect(describeCauses(new Error('top', { cause: chain }))).toBe(
      '; caused by Error: c1; caused by Error: c2; caused by Error: c3',
    );
  });

  test('a cycle ends the walk', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(describeCauses(a)).toBe('; caused by Error: b');
    const self = new Error('self');
    Object.assign(self, { cause: self });
    expect(describeCauses(self)).toBe('');
  });

  test('a null cause ends the walk', () => {
    expect(describeCauses(new Error('x', { cause: null }))).toBe('');
  });

  test('each cause is one line', () => {
    const err = new Error('outer', { cause: new Error('first line\n  second\tline  ') });
    expect(describeCauses(err)).toBe('; caused by Error: first line second line');
  });

  test('a long cause is cut to 500 characters with …, never inside a word', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(
      ' ',
    );
    const said = describeCauses(new Error('outer', { cause: new Error(words) }));
    const text = said.slice('; caused by '.length);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith('…')).toBe(true);
    // Every word kept is whole.
    for (const word of text.slice(0, -1).split(' ').slice(1)) expect(word).toMatch(/^word\d\d$/);
    expect(text.startsWith('Error: word00 word01')).toBe(true);
  });

  test('a word longer than the cut is left out whole', () => {
    const err = new Error('outer', { cause: 'x'.repeat(600) });
    expect(describeCauses(err)).toBe('; caused by …');
  });

  test('an opaque token straddling the cut leaves no part of itself', () => {
    const token = 'tok_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH';
    const message = `${'a'.repeat(480)} ${token} rejected`;
    const said = describeCauses(new Error('outer', { cause: new Error(message) }));
    expect(said.endsWith('a…')).toBe(true);
    for (let n = 4; n <= token.length; n += 1) expect(said).not.toContain(token.slice(0, n));
  });

  test("a cause its effect's message already says, code and all, is passed over", () => {
    const failure = { code: 'pack-unreachable', message: 'connect ECONNREFUSED' };
    const transport = new Error(`${failure.code}: ${failure.message}`, { cause: failure });
    expect(describeCauses(new Error('Tool "acme.probe" threw', { cause: transport }))).toBe(
      '; caused by Error: pack-unreachable: connect ECONNREFUSED',
    );
    // And the walk goes on below a cause passed over.
    const below = new Error('handler-throw: x', {
      cause: new Error('x', { cause: coded('Error', 'socket hang up', 'ECONNRESET') }),
    });
    expect(describeCauses(below)).toBe('; caused by Error [ECONNRESET]: socket hang up');
  });

  test("an empty-message cause is never passed over, nor one whose code its effect doesn't say", () => {
    const empty = new TypeError('fetch failed', {
      cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }),
    });
    expect(describeCauses(empty)).toBe('; caused by AggregateError [ECONNREFUSED]');
    const newCode = new Error('read failed: timeout', {
      cause: coded('Error', 'timeout', 'ETIMEDOUT'),
    });
    expect(describeCauses(newCode)).toBe('; caused by Error [ETIMEDOUT]: timeout');
  });

  test("a plain object is said like an error, and its own cause isn't looked at", () => {
    const err = new Error('save failed', {
      cause: { code: 'E1', message: 'msg', cause: new Error('select * from orders where id = 7') },
    });
    expect(describeCauses(err)).toBe('; caused by Object [E1]: msg');
    const named = new Error('x', { cause: { name: 'StorageError', message: 'gone' } });
    expect(describeCauses(named)).toBe('; caused by StorageError: gone');
  });

  test('a string cause is said as it is, any other value as String(value)', () => {
    expect(describeCauses(new Error('x', { cause: 'the socket closed' }))).toBe(
      '; caused by the socket closed',
    );
    expect(describeCauses(new Error('x', { cause: 42 }))).toBe('; caused by 42');
    expect(describeCauses(new Error('x', { cause: Object.create(null) }))).toBe(
      '; caused by [object Object]',
    );
  });

  test('a getter that throws, or a revoked proxy, never makes it throw', () => {
    const throwing = new Error('x');
    Object.defineProperty(throwing, 'cause', {
      get() {
        throw new Error('no');
      },
    });
    expect(describeCauses(throwing)).toBe('');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describeCauses(new Error('x', { cause: proxy }))).toBe('; caused by [unreadable]');
    const badMessage = new Error('x', {
      cause: Object.defineProperty(new Error('y'), 'message', {
        get() {
          throw new Error('no');
        },
      }),
    });
    expect(describeCauses(badMessage)).toBe('; caused by Error');
  });

  test("each cause is masked with the full mask: a token whole, a URL's secret parameters", () => {
    const err = new TypeError('fetch failed', {
      cause: new Error(
        'request to https://shop.acme.example/orders?token=canary-q-0123456789&page=2 failed: Bearer canary-b-0123456789abcdef rejected; retry with kgi_bt_canary0123456789abcdWXYZ',
      ),
    });
    expect(describeCauses(err)).toBe(
      '; caused by Error: request to https://shop.acme.example/orders?token=[redacted]&page=2 failed: Bearer [redacted] rejected; retry with [redacted]',
    );
  });

  test('a token that straddles character 500 is masked before the cut, which then has less to cut', () => {
    const token = 'kgi_bt_0123456789abcdefghijklmnopWXYZ';
    const message = `${'a'.repeat(470)} ${token} rejected`;
    expect(describeCauses(new Error('outer', { cause: new Error(message) }))).toBe(
      `; caused by Error: ${'a'.repeat(470)} [redacted] rejected`,
    );
  });

  test("a log line of the same error keeps the logger's form, the token's last four", () => {
    const err = new TypeError('fetch failed', {
      cause: new Error('retry with kgi_bt_canary0123456789abcdWXYZ'),
    });
    const lines: string[] = [];
    createLogger({ write: (line) => lines.push(line) }).error('tool failed', { err });
    expect(lines[0]).toContain('retry with kgi_bt_…WXYZ');
    expect(describeCauses(err)).toBe('; caused by Error: retry with [redacted]');
  });
});
