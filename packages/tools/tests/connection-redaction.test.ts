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

describe('what holds no token comes back as it is', () => {
  test('an error, cause chain and all, with what it holds', () => {
    const error = Object.assign(new Error('send failed'), {
      cause: new Error('quoted', { cause: { code: 'acme-busy', took: Number.NaN } }),
      issues: [{ path: ['to'], message: 'not an address' }],
      when: new Date(0),
    });
    expect(withoutConnectionTokens(error, [first, renewed])).toBe(error);
  });

  test("a cancelled run's reason and a timed-out fetch's: still the very error thrown", async () => {
    // The kernel cancels a run with a bare `abort()`: a `DOMException`.
    const run = new AbortController();
    run.abort();
    expect(withoutConnectionTokens(run.signal.reason, [first])).toBe(run.signal.reason);
    // A tool's own fetch, given up on: `AbortSignal.timeout`'s `TimeoutError`.
    const timeout = AbortSignal.timeout(1);
    await new Promise((resolve) => timeout.addEventListener('abort', resolve));
    const thrown = { code: 'tool-invocation-failed', message: 'timed out', cause: timeout.reason };
    const out = withoutConnectionTokens(thrown, [first]);
    expect(out).toBe(thrown);
    expect(out.cause).toBe(timeout.reason);
    expect((out.cause as DOMException).code).toBe(DOMException.TIMEOUT_ERR);
  });

  test('inside an error that holds one: each part that holds none is the same object', () => {
    const issues = [{ path: ['to'], message: 'not an address' }];
    const cause = new DOMException('The operation timed out.', 'TimeoutError');
    const thrown = Object.assign(new Error('send failed with tok-first-1234', { cause }), {
      issues,
    });

    const out = withoutConnectionTokens(thrown, [first]);

    expect(out).not.toBe(thrown);
    expect(out.message).toBe(`send failed with ${REDACTED_TOKEN}`);
    expect(out.issues).toBe(issues);
    expect(out.cause).toBe(cause);
    expect((out.cause as DOMException).code).toBe(DOMException.TIMEOUT_ERR);
  });

  test('one with a property that throws when read is copied without it', () => {
    const thrown = new Error('send failed');
    Object.defineProperty(thrown, 'response', {
      enumerable: true,
      get() {
        throw new Error('read after close');
      },
    });

    const out = withoutConnectionTokens(thrown, [first]);

    expect(out).not.toBe(thrown);
    expect(Object.hasOwn(out, 'response')).toBe(false);
    expect(out.message).toBe('send failed');
  });
});

describe('a DOMException that holds a token', () => {
  test('is built anew: still one, every part readable, without the token', () => {
    const out = withoutConnectionTokens(new DOMException('bad tok-first-1234', 'AbortError'), [
      first,
    ]);

    expect(out).toBeInstanceOf(DOMException);
    expect(out).toMatchObject({
      name: 'AbortError',
      message: `bad ${REDACTED_TOKEN}`,
      code: DOMException.ABORT_ERR,
    });
    expect(String(out)).toBe(`AbortError: bad ${REDACTED_TOKEN}`);
    expect(out.stack).toMatch(/^AbortError: bad \[redacted\]\n\s+at /);
    expect(stringsOf(out).join('\n')).not.toContain('tok-first-1234');
  });

  test('its message is looked at where its stack does not hold it', () => {
    const restacked = new DOMException('bad tok-first-1234', 'AbortError');
    restacked.stack = 'AbortError\n    at somewhere';

    const out = withoutConnectionTokens(restacked, [first]);

    expect(out.message).toBe(`bad ${REDACTED_TOKEN}`);
    expect(out.stack).toBe('AbortError\n    at somewhere');
  });

  test('its own cause comes along, redacted; the error thrown stays what it was', () => {
    const thrown = new DOMException('timed out', {
      name: 'TimeoutError',
      cause: new Error('Acme said 401 to tok-first-1234'),
    });

    const out = withoutConnectionTokens(thrown, [first]);

    expect(out).toBeInstanceOf(DOMException);
    expect(out.code).toBe(DOMException.TIMEOUT_ERR);
    expect((out.cause as Error).message).toBe(`Acme said 401 to ${REDACTED_TOKEN}`);
    expect((thrown.cause as Error).message).toBe('Acme said 401 to tok-first-1234');
  });

  test('in its name too', () => {
    const out = withoutConnectionTokens(new DOMException('bad', 'tok-first-1234'), [first]);
    expect(out).toBeInstanceOf(DOMException);
    expect(out.name).toBe(REDACTED_TOKEN);
    expect(out.message).toBe('bad');
  });
});

describe('in the errors, arrays and plain objects it holds', () => {
  test("in a pack error's issues, an array that stays one", () => {
    const issues = [{ path: ['to'], message: 'Bearer tok-first-1234 is not an address' }];
    const answer = { code: 'tool-invocation-failed', message: 'invalid', issues };

    const out = withoutConnectionTokens(answer, [first]);

    expect(Array.isArray(out.issues)).toBe(true);
    expect(out.issues).toEqual([
      { path: ['to'], message: `Bearer ${REDACTED_TOKEN} is not an address` },
    ]);
    expect(issues[0]?.message).toBe('Bearer tok-first-1234 is not an address');
  });

  test('two levels down a plain object, which stays one, copied', () => {
    const at = new Date(0);
    const thrown = Object.assign(new Error('send failed'), {
      details: { request: { header: 'Bearer tok-renewed-5678', at } },
    });

    const out = withoutConnectionTokens(thrown, [renewed]);

    expect(out.details.request.header).toBe(`Bearer ${REDACTED_TOKEN}`);
    expect(Object.getPrototypeOf(out.details)).toBe(Object.prototype);
    // Copied, not written out: what it holds stays what it was.
    expect(out.details.request.at).toBe(at);
    expect(thrown.details.request.header).toBe('Bearer tok-renewed-5678');
  });

  test('in the errors an AggregateError holds, each still an error', () => {
    const thrown = new AggregateError([new Error('Acme said 401 to tok-first-1234')], 'all failed');

    const out = withoutConnectionTokens(thrown, [first]);

    expect(out).toBeInstanceOf(AggregateError);
    expect(out.errors[0]).toBeInstanceOf(Error);
    expect((out.errors[0] as Error).message).toBe(`Acme said 401 to ${REDACTED_TOKEN}`);
    expect(stringsOf(out).join('\n')).not.toContain('tok-first-1234');
  });

  test('any other object it holds is kept as it is, when its JSON form holds no token', () => {
    const at = new Date(0);
    const thrown = Object.assign(new Error('send failed with tok-first-1234'), { at });

    const out = withoutConnectionTokens(thrown, [first]);

    expect(out.at).toBe(at);
  });

  test('a cause that is another object is kept as it is too, still working', () => {
    const seen = new Map([['auth', 'Bearer tok-first-1234']]);
    const thrown = new Error('send failed', { cause: seen });

    const out = withoutConnectionTokens(thrown, [first]);

    expect(out.cause).toBe(seen);
    expect((out.cause as Map<string, string>).get('auth')).toBe('Bearer tok-first-1234');
    // What a run writes of it holds no token.
    expect(JSON.stringify(out.cause)).toBe('{}');
  });

  test('an object or an array that holds itself ends at the depth looked at', () => {
    const loop: Record<string, unknown> = { message: 'echo tok-first-1234' };
    loop.self = loop;
    const list: unknown[] = ['echo tok-first-1234'];
    list.push(list);

    const out = withoutConnectionTokens({ loop, list }, [first]);

    expect((out.loop as Record<string, unknown>).message).toBe(`echo ${REDACTED_TOKEN}`);
    expect(out.loop.self).not.toBe(loop);
    expect(out.list[0]).toBe(`echo ${REDACTED_TOKEN}`);
    expect(stringsOf(out).join('\n')).not.toContain('tok-first-1234');
  });
});

describe('another object whose JSON form holds a token: that form, redacted, in its place', () => {
  class Request {
    readonly method = 'POST';
    readonly header: string;
    constructor(token: string) {
      this.header = `Bearer ${token}`;
    }
  }
  /** Headers written out by `toJSON`, as a client's header class does. */
  class Headers {
    readonly #values: Record<string, string>;
    constructor(values: Record<string, string>) {
      this.#values = values;
    }
    toJSON(): Record<string, string> {
      return { ...this.#values };
    }
  }

  test('an instance with the token in its own properties', () => {
    const request = new Request('tok-first-1234');
    const thrown = { message: 'send failed', request };

    const out = withoutConnectionTokens(thrown, [first]);

    expect(out.request).toEqual({ method: 'POST', header: `Bearer ${REDACTED_TOKEN}` });
    expect(Object.getPrototypeOf(out.request)).toBe(Object.prototype);
    expect(request.header).toBe('Bearer tok-first-1234');
  });

  test('an instance whose toJSON writes the token', () => {
    const thrown = {
      message: 'send failed',
      config: { headers: new Headers({ Authorization: 'Bearer tok-renewed-5678' }) },
    };

    const out = withoutConnectionTokens(thrown, [first, renewed]);

    expect(out.config.headers).toEqual({ Authorization: `Bearer ${REDACTED_TOKEN}` });
    expect(JSON.stringify(out)).not.toContain('tok-renewed-5678');
  });

  test('a token JSON writes escaped is found as JSON writes it', () => {
    const odd = { mail: connection('tok"quote\\1') };
    const thrown = { message: 'send failed', request: new Request('tok"quote\\1') };

    const out = withoutConnectionTokens(thrown, [odd]);

    expect(out.request).toEqual({ method: 'POST', header: `Bearer ${REDACTED_TOKEN}` });
  });

  test("one that can't be written out is left out, in an object or an array", () => {
    const broken = {
      toJSON() {
        throw new Error('no JSON form');
      },
    };
    const unwritable = Object.setPrototypeOf(broken, Headers.prototype) as Headers;
    const thrown = {
      message: 'send failed with tok-first-1234',
      headers: unwritable,
      all: [unwritable, 'x'],
    };

    const out = withoutConnectionTokens(thrown, [first]);

    expect(Object.hasOwn(out, 'headers')).toBe(false);
    expect(out.all).toEqual([undefined, 'x']);
    expect(out.message).toBe(`send failed with ${REDACTED_TOKEN}`);
  });
});

describe('what it reads and how it replaces', () => {
  test('a property that throws when read is left out, and the rest is copied', () => {
    const thrown = new Error('send failed with tok-first-1234');
    Object.defineProperty(thrown, 'response', {
      enumerable: true,
      get() {
        throw new Error('read after close');
      },
    });

    const out = withoutConnectionTokens(thrown, [first]);

    expect(Object.hasOwn(out, 'response')).toBe(false);
    expect(out.message).toBe(`send failed with ${REDACTED_TOKEN}`);
  });

  test('a token inside another, or overlapping one, leaves no part of either', () => {
    const short = { a: connection('tok-ab') };
    const long = { b: connection('tok-abcdef') };
    const tail = { c: connection('cdef-tail') };

    expect(withoutConnectionTokens({ message: 'x tok-abcdef y' }, [short, long]).message).toBe(
      `x ${REDACTED_TOKEN} y`,
    );
    expect(withoutConnectionTokens({ message: 'x tok-abcdef-tail y' }, [long, tail]).message).toBe(
      `x ${REDACTED_TOKEN} y`,
    );
  });

  test('a string that starts with a token', () => {
    expect(withoutConnectionTokens({ message: 'tok-first-1234 refused' }, [first]).message).toBe(
      `${REDACTED_TOKEN} refused`,
    );
  });
});
