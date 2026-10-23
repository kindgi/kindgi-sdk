// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  ConnectionRejectedError,
  REDACTED_TOKEN,
  type ToolConnection,
  connectionRejectionOf,
  isConnectionRejectedError,
  withoutConnectionTokens,
} from '../src/index.js';

const connection = (accessToken: string): ToolConnection => ({
  connectionId: 'conn-1',
  app: 'acme',
  appName: 'Acme',
  accessToken,
  account: { id: 'acct-1', label: 'owner@acme.example' },
});
const first = { mail: connection('tok-first-1234') };
const renewed = { mail: connection('tok-renewed-5678') };

/** Every string an error holds as its own, down its causes. */
function stringsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null || depth > 10) return [];
  return Reflect.ownKeys(value).flatMap((key) =>
    stringsOf(Reflect.get(value, key), key === 'cause' ? depth + 1 : 11),
  );
}

describe("a failed call's error, without its connections' tokens", () => {
  test('in its message, its stack and its own strings, down its causes', () => {
    const inner = Object.assign(new Error('Acme said 401 to tok-first-1234'), {
      detail: 'Bearer tok-first-1234',
    });
    const thrown = new Error('send failed with tok-renewed-5678', { cause: inner });
    const wrapped = { code: 'tool-invocation-failed', message: thrown.message, cause: thrown };

    const out = withoutConnectionTokens(wrapped, [first, renewed]);

    expect(out.message).toBe(`send failed with ${REDACTED_TOKEN}`);
    const strings = stringsOf(out);
    expect(strings.join('\n')).not.toMatch(/tok-(first|renewed)/);
    expect(strings).toContain(`Acme said 401 to ${REDACTED_TOKEN}`);
    expect(strings).toContain(`Bearer ${REDACTED_TOKEN}`);
    expect(out.code).toBe('tool-invocation-failed');
  });

  test('each error is copied, never changed, and stays what it was', () => {
    const rejected = new ConnectionRejectedError('mail', 'Acme refused tok-first-1234.');
    const thrown = new Error('send failed', { cause: rejected });

    const out = withoutConnectionTokens(thrown, [first]);

    expect(rejected.message).toBe('Acme refused tok-first-1234.');
    expect(out).toBeInstanceOf(Error);
    expect(out.cause).toBeInstanceOf(ConnectionRejectedError);
    expect(isConnectionRejectedError(out.cause)).toBe(true);
    expect(connectionRejectionOf(out)).toEqual({
      connection: 'mail',
      message: `Acme refused ${REDACTED_TOKEN}.`,
    });
    // Its message stays its own, not listed, as an error's is.
    expect(Object.keys(out)).not.toContain('message');
  });

  test('with no tokens, the error itself', () => {
    const thrown = new Error('send failed');
    expect(withoutConnectionTokens(thrown, [])).toBe(thrown);
    expect(withoutConnectionTokens(thrown, [undefined])).toBe(thrown);
    expect(withoutConnectionTokens(thrown, [{ mail: connection('') }])).toBe(thrown);
  });

  test('a cause past the depth looked at is left out', () => {
    let at: unknown = new Error('deep tok-first-1234');
    for (let i = 0; i < 10; i += 1) at = new Error(`level ${i}`, { cause: at });

    const out = withoutConnectionTokens(at, [first]);

    expect(stringsOf(out).join('\n')).not.toContain('tok-first-1234');
    // Eight errors, the eighth with no cause: the rest are left out.
    let errors = 0;
    for (let e: unknown = out; typeof e === 'object' && e !== null; e = (e as Error).cause) {
      errors += 1;
    }
    expect(errors).toBe(8);
  });

  test('a string cause is a string still, redacted', () => {
    const out = withoutConnectionTokens({ message: 'x', cause: 'echo tok-first-1234' }, [first]);
    expect(out.cause).toBe(`echo ${REDACTED_TOKEN}`);
  });
});
