// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `users.create` answers with the person it added, and whether their
 * invitation was emailed; `users.resendInvite` with the person and the
 * email's outcome.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type {
  InviteEmail,
  InviteRenewed,
  KindgiClient,
  User,
  UserCreated,
  UserInvite,
} from '../src/index.js';

/** What a call answers. */
type Answer<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;

describe('adding a person answers with them', () => {
  test('users.create answers UserCreated: the person, and inviteEmail when the runtime invites', () => {
    expectTypeOf<Answer<KindgiClient['users']['create']>>().toEqualTypeOf<UserCreated>();
    expectTypeOf<UserCreated>().toMatchTypeOf<User>();
    expectTypeOf<UserCreated['inviteEmail']>().toEqualTypeOf<InviteEmail | undefined>();
  });

  test('users.resendInvite answers the person and the email', () => {
    expectTypeOf<Answer<KindgiClient['users']['resendInvite']>>().toEqualTypeOf<InviteRenewed>();
    expectTypeOf<InviteRenewed['inviteEmail']>().toEqualTypeOf<InviteEmail>();
  });

  test("a person's invitation is optional", () => {
    expectTypeOf<User['invite']>().toEqualTypeOf<UserInvite | undefined>();
  });
});
