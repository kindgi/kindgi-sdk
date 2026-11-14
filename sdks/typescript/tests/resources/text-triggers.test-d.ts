// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, it } from 'vitest';

import type {
  RegisterTextTriggerInput,
  RunTrigger,
  TextTrigger,
  TextTriggerVersion,
  UpdateTextTriggerInput,
} from '../../src/index.js';

describe('textTriggers - the connection a trigger answers, and its limits', () => {
  it('a register names the connection; an update may', () => {
    expectTypeOf<RegisterTextTriggerInput['config']['connectionId']>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<UpdateTextTriggerInput['config']>['connectionId']>().toEqualTypeOf<
      string | undefined
    >();
  });

  it('a trigger and its versions carry the connection and both limits', () => {
    expectTypeOf<TextTrigger['connectionId']>().toEqualTypeOf<string>();
    expectTypeOf<TextTrigger['runsPerHour']>().toEqualTypeOf<number>();
    expectTypeOf<TextTrigger['perSenderPerHour']>().toEqualTypeOf<number>();
    expectTypeOf<TextTriggerVersion['definition']['connectionId']>().toEqualTypeOf<string>();
  });

  it('the limits are optional at register', () => {
    expectTypeOf<RegisterTextTriggerInput['config']['runsPerHour']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<RegisterTextTriggerInput['config']['perSenderPerHour']>().toEqualTypeOf<
      number | undefined
    >();
  });

  it("a run a text started names the trigger's kind", () => {
    expectTypeOf<'text'>().toMatchTypeOf<RunTrigger['kind']>();
  });
});
