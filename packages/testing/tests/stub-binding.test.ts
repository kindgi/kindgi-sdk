// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { StubBindingError, createStubBinding } from '../src/index.js';

interface Greeter {
  greet(name: string): string;
  farewell(name: string): Promise<string>;
}

describe('createStubBinding', () => {
  test('every listed method throws StubBindingError naming binding + method', () => {
    const greeter = createStubBinding<Greeter>('greeter', { greet: true, farewell: true });
    let caught: unknown;
    try {
      greeter.greet('ada');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StubBindingError);
    const err = caught as StubBindingError;
    expect(err.name).toBe('StubBindingError');
    expect(err.binding).toBe('greeter');
    expect(err.method).toBe('greet');
    expect(err.message).toContain('greeter.greet()');
  });

  test('async-shaped methods throw synchronously (fail loud, no dangling promise)', () => {
    const greeter = createStubBinding<Greeter>('greeter', { greet: true, farewell: true });
    expect(() => greeter.farewell('ada')).toThrow(StubBindingError);
  });
});

// Compile-time completeness: checked by `pnpm typecheck` (tsc over tests/).
// Never executed — the assertions are the @ts-expect-error directives.
function _compileTimeCompleteness(): void {
  // @ts-expect-error — `farewell` missing: an interface method without a stub must not compile.
  createStubBinding<Greeter>('greeter', { greet: true });
  // @ts-expect-error — `wave` is not a Greeter method: stale stub entries must not compile.
  createStubBinding<Greeter>('greeter', { greet: true, farewell: true, wave: true });
}
void _compileTimeCompleteness;
