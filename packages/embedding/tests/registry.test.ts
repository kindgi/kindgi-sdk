// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { createEmbeddingProviderRegistry } from '../src/index.js';
import type { EmbeddingProvider } from '../src/index.js';

function stub(model: string, dim = 4): EmbeddingProvider {
  return {
    async embed(): Promise<Float32Array> {
      return new Float32Array(dim);
    },
    dimensions: () => dim,
    describe: () => ({ name: 'stub', version: '0.0.0', model }),
  };
}

describe('createEmbeddingProviderRegistry', () => {
  test('register + getByModel + has + size + list', () => {
    const r = createEmbeddingProviderRegistry();
    expect(r.size()).toBe(0);

    const p1 = stub('m1');
    const p2 = stub('m2');
    expect(r.register(p1).kind).toBe('ok');
    expect(r.register(p2).kind).toBe('ok');

    expect(r.size()).toBe(2);
    expect(r.has('m1')).toBe(true);
    expect(r.has('nope')).toBe(false);
    expect(r.getByModel('m1')).toBe(p1);
    expect(r.getByModel('m2')).toBe(p2);
    expect(r.getByModel('nope')).toBeUndefined();
    expect(r.list()).toEqual([p1, p2]);
  });

  test('duplicate register returns error, does not clobber', () => {
    const r = createEmbeddingProviderRegistry();
    const first = stub('same-model');
    const second = stub('same-model');
    expect(r.register(first).kind).toBe('ok');
    const dup = r.register(second);
    expect(dup.kind).toBe('err');
    if (dup.kind === 'err') expect(dup.error.code).toBe('duplicate-embedding-provider');
    // First registration wins.
    expect(r.getByModel('same-model')).toBe(first);
  });

  test('seed applies duplicates as a synchronous throw', () => {
    const p = stub('seeded');
    expect(() => createEmbeddingProviderRegistry([p, stub('seeded')])).toThrow(
      /already registered/i,
    );
  });

  test('resolve() with explicit model returns provider', () => {
    const r = createEmbeddingProviderRegistry([stub('m1'), stub('m2')]);
    const got = r.resolve('m2');
    expect(got.kind).toBe('ok');
    if (got.kind === 'ok') expect(got.value.describe().model).toBe('m2');
  });

  test('resolve() with unknown model returns unknown-embedding-model + known set', () => {
    const r = createEmbeddingProviderRegistry([stub('m1'), stub('m2')]);
    const got = r.resolve('m9');
    expect(got.kind).toBe('err');
    if (got.kind === 'err') {
      expect(got.error.code).toBe('unknown-embedding-model');
      if (got.error.code === 'unknown-embedding-model') {
        expect(got.error.model).toBe('m9');
        expect(got.error.known).toEqual(['m1', 'm2']);
      }
    }
  });

  test('resolve() with no arg + empty registry returns no-embedding-provider', () => {
    const r = createEmbeddingProviderRegistry();
    const got = r.resolve();
    expect(got.kind).toBe('err');
    if (got.kind === 'err') expect(got.error.code).toBe('no-embedding-provider');
  });

  test('resolve() with no arg + single provider returns it', () => {
    const p = stub('only-one');
    const r = createEmbeddingProviderRegistry([p]);
    const got = r.resolve();
    expect(got.kind).toBe('ok');
    if (got.kind === 'ok') expect(got.value).toBe(p);
  });

  test('resolve() with no arg + multiple providers requires explicit model', () => {
    const r = createEmbeddingProviderRegistry([stub('m1'), stub('m2')]);
    const got = r.resolve();
    expect(got.kind).toBe('err');
    if (got.kind === 'err') {
      expect(got.error.code).toBe('ambiguous-default-provider');
      if (got.error.code === 'ambiguous-default-provider') {
        expect(got.error.known).toEqual(['m1', 'm2']);
      }
    }
  });
});
