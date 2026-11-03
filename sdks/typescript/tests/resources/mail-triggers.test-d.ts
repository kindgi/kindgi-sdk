// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, it } from 'vitest';

import type {
  MailTrigger,
  MailTriggerMailbox,
  RegisterMailTriggerInput,
  UpdateMailTriggerInput,
} from '../../src/index.js';

describe("mailTriggers — the company connection a trigger's mailbox names", () => {
  it('a mailbox may name a connection', () => {
    expectTypeOf<MailTriggerMailbox>()
      .toHaveProperty('connectionId')
      .toEqualTypeOf<string | undefined>();
  });

  it('a register, an update and a trigger carry the same mailbox', () => {
    expectTypeOf<
      RegisterMailTriggerInput['config']['mailbox']
    >().toEqualTypeOf<MailTriggerMailbox>();
    expectTypeOf<
      NonNullable<NonNullable<UpdateMailTriggerInput['config']>['mailbox']>
    >().toEqualTypeOf<MailTriggerMailbox>();
    expectTypeOf<MailTrigger['mailbox']>().toEqualTypeOf<MailTriggerMailbox>();
  });
});
