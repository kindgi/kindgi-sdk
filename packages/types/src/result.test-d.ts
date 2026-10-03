// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, test } from 'vitest';
import type { ErrOf, OkOf, Result } from './result.js';

describe('Result<T, E>', () => {
  test('kind narrows to the corresponding member', () => {
    // Wrapped in a function so TS keeps the full Result<number, string> type
    // rather than narrowing to the assigned object literal at a `const` binding.
    function inspect(r: Result<number, string>): void {
      if (r.kind === 'ok') {
        expectTypeOf(r.value).toEqualTypeOf<number>();
        // The err member is not accessible in the ok branch.
        // @ts-expect-error — 'error' is only on the err member.
        const _e = r.error;
      } else {
        expectTypeOf(r.error).toEqualTypeOf<string>();
        // Symmetric: 'value' is not accessible in the err branch.
        // @ts-expect-error — 'value' is only on the ok member.
        const _v = r.value;
      }
    }
    inspect({ kind: 'ok', value: 42 });
    inspect({ kind: 'err', error: 'bad' });
  });

  test('Result cannot be constructed without a kind tag', () => {
    // @ts-expect-error — missing 'kind' discriminator.
    const _bad: Result<number, string> = { value: 1 };
    // @ts-expect-error — 'kind' must be 'ok' or 'err'.
    const _bad2: Result<number, string> = { kind: 'maybe', value: 1 };
  });

  test('OkOf extracts the success type', () => {
    type R = Result<{ id: string }, Error>;
    expectTypeOf<OkOf<R>>().toEqualTypeOf<{ id: string }>();
  });

  test('ErrOf extracts the error type', () => {
    type R = Result<number, { code: 'timeout' } | { code: 'refused' }>;
    expectTypeOf<ErrOf<R>>().toEqualTypeOf<{ code: 'timeout' } | { code: 'refused' }>();
  });

  test('OkOf / ErrOf return never for non-Result inputs', () => {
    expectTypeOf<OkOf<string>>().toEqualTypeOf<never>();
    expectTypeOf<ErrOf<{ foo: 'bar' }>>().toEqualTypeOf<never>();
  });

  test('values are readonly by declaration', () => {
    function mutate(r: Result<number, string>): void {
      if (r.kind === 'ok') {
        // @ts-expect-error — value is readonly.
        r.value = 2;
      }
    }
    mutate({ kind: 'ok', value: 1 });
  });
});
