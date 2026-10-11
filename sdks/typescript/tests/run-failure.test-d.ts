// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run's `failure` has what the wire's `RunFailure` has, `reason`
 * included, as the Python client does.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type { RunFailure as WireRunFailure } from '../src/generated/api.js';
import type { RunFailure } from '../src/resources/runs.js';

describe('RunFailure', () => {
  test('has the fields the wire has, no more and no fewer', () => {
    expectTypeOf<keyof RunFailure>().toEqualTypeOf<keyof WireRunFailure>();
  });

  test('with the same types and the same optionality', () => {
    // Each way: a field the client types otherwise, or makes optional, fails one of them.
    expectTypeOf<RunFailure>().toMatchTypeOf<WireRunFailure>();
    expectTypeOf<WireRunFailure>().toMatchTypeOf<RunFailure>();
  });

  test('carries the reason, when the error gives one', () => {
    expectTypeOf<RunFailure['reason']>().toEqualTypeOf<string | undefined>();
    const timedOut: RunFailure = {
      code: 'hitl-cancelled',
      message: 'Nobody decided the approval in time',
      reason: 'timeout',
    };
    expectTypeOf(timedOut.reason).toEqualTypeOf<string | undefined>();
  });
});
