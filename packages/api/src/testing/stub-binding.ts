// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Thrown when code under test calls a method on a stub binding. The
 * message names the binding and method so the fix — supply a real
 * implementation or a test double for that binding — is obvious.
 */
export class StubBindingError extends Error {
  readonly binding: string;
  readonly method: string;

  constructor(binding: string, method: string) {
    super(
      `${binding}.${method}() was called on a stub binding from @kindgi/testing. ` +
        `Pass a real implementation or a test double for \`${binding}\` to exercise this code path.`,
    );
    this.name = 'StubBindingError';
    this.binding = binding;
    this.method = method;
  }
}

/**
 * One `true` entry per method of `T`. Typed as a complete mapping, so a
 * method added to the interface (or a stale one left behind) fails to
 * compile at the stub definition instead of slipping through at runtime.
 */
export type StubMethods<T> = { readonly [K in keyof T]-?: true };

/**
 * Build a stub implementation of the binding interface `T`: every method
 * listed in `methods` throws {@link StubBindingError} when called.
 *
 * ```ts
 * const memory = createStubBinding<MemoryQueryBinding>('memoryBinding', {
 *   listFacts: true,
 *   searchByKeyword: true,
 *   searchBySemantic: true,
 *   appendLog: true,
 *   readLog: true,
 * });
 * ```
 */
export function createStubBinding<T extends object>(name: string, methods: StubMethods<T>): T {
  const stub: Record<string, () => never> = {};
  for (const method of Object.keys(methods)) {
    stub[method] = () => {
      throw new StubBindingError(name, method);
    };
  }
  return stub as T;
}
