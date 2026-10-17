// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A policy version answers as a row of its versions list does: a
 * retired one carries its `unregisteredAt`, as the wire and the Python
 * client have it.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type { KindgiClient, PolicyVersionRow } from '../src/index.js';

/** What a call answers. */
type Answer<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;

describe('policies.getVersion', () => {
  test('answers a PolicyVersionRow, with an optional unregisteredAt', () => {
    expectTypeOf<
      Answer<KindgiClient['policies']['getVersion']>
    >().toEqualTypeOf<PolicyVersionRow>();
    expectTypeOf<PolicyVersionRow['unregisteredAt']>().toEqualTypeOf<string | undefined>();
  });
});
