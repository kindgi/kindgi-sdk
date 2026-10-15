// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A flow version answers as a row of its versions list does: an
 * unregistered one carries its `unregisteredAt`, as the wire has it.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type { FlowVersionRow, KindgiClient } from '../src/index.js';

/** What a call answers. */
type Answer<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;

describe('flows.versions.get', () => {
  test('answers a FlowVersionRow, with an optional unregisteredAt', () => {
    expectTypeOf<
      Answer<KindgiClient['flows']['versions']['get']>
    >().toEqualTypeOf<FlowVersionRow>();
    expectTypeOf<FlowVersionRow['unregisteredAt']>().toEqualTypeOf<string | undefined>();
  });

  test('so does the deprecated flows.getVersion', () => {
    expectTypeOf<Answer<KindgiClient['flows']['getVersion']>>().toEqualTypeOf<FlowVersionRow>();
  });
});
