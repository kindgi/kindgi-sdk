// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { createClientsByKey } from '../src/clients-by-key.js';

/** A client stand-in: which key it was built for, and the order it was built in. */
function builder() {
  const built: string[] = [];
  const build = (key: string) => () => {
    built.push(key);
    return { key, n: built.length };
  };
  return { built, build };
}

describe('createClientsByKey', () => {
  test('one client per key: keys taking turns each reuse their own', () => {
    const clients = createClientsByKey<{ key: string; n: number }>();
    const { built, build } = builder();
    const got = ['key-a', 'key-b', 'key-a', 'key-b', 'key-a'].map((k) => clients.get(k, build(k)));
    expect(built).toEqual(['key-a', 'key-b']);
    expect(got.map((c) => c.key)).toEqual(['key-a', 'key-b', 'key-a', 'key-b', 'key-a']);
    expect(got[0]).toBe(got[2]);
    expect(got[1]).toBe(got[3]);
  });

  test('at most `max`: the least recently used goes first', () => {
    const clients = createClientsByKey<{ key: string; n: number }>(2);
    const { built, build } = builder();
    for (const k of ['key-a', 'key-b', 'key-a', 'key-c']) clients.get(k, build(k));
    // key-b was used least recently, so key-c's client took its place.
    clients.get('key-a', build('key-a'));
    expect(built).toEqual(['key-a', 'key-b', 'key-c']);
    clients.get('key-b', build('key-b'));
    expect(built).toEqual(['key-a', 'key-b', 'key-c', 'key-b']);
  });

  test('a build that throws keeps nothing: the next call builds again', () => {
    const clients = createClientsByKey<string>();
    expect(() =>
      clients.get('key-a', () => {
        throw new Error('no client');
      }),
    ).toThrow('no client');
    expect(clients.get('key-a', () => 'built')).toBe('built');
  });

  test('max is a whole number, 1 or more', () => {
    for (const max of [0, -1, 1.5, Number.NaN]) {
      expect(() => createClientsByKey(max)).toThrow(RangeError);
    }
  });
});
