// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project role to give is `owner`, `admin`, `editor` or `viewer`:
 * `member`, retired, doesn't compile there (the API refuses it). A role
 * read back may still be `member`, on one given before.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type {
  AddProjectMembershipInput,
  AssignableProjectRoleValue,
  CreateServiceAccountInput,
  KindgiClient,
  ProjectRoleValue,
  ServiceAccountGrantInput,
} from '../src/index.js';

type Assignable = 'viewer' | 'editor' | 'owner' | 'admin';
type ProjectGrantRole = Extract<ServiceAccountGrantInput, { kind: 'project' }>['role'];

describe('a project role to give is never `member`', () => {
  test('memberships: add and updateRole', () => {
    expectTypeOf<AssignableProjectRoleValue>().toEqualTypeOf<Assignable>();
    expectTypeOf<AddProjectMembershipInput['role']>().toEqualTypeOf<Assignable>();
    expectTypeOf<
      Parameters<KindgiClient['projects']['memberships']['updateRole']>[2]
    >().toEqualTypeOf<Assignable>();
  });
  test("service accounts: create's grants and grant", () => {
    expectTypeOf<ProjectGrantRole>().toEqualTypeOf<Assignable>();
    expectTypeOf<
      NonNullable<CreateServiceAccountInput['grants']>[number]
    >().toEqualTypeOf<ServiceAccountGrantInput>();
    expectTypeOf<
      Parameters<KindgiClient['serviceAccounts']['grant']>[1]
    >().toEqualTypeOf<ServiceAccountGrantInput>();
  });
});

describe('a role read back', () => {
  test('may be `member`', () => {
    expectTypeOf<'member'>().toMatchTypeOf<ProjectRoleValue>();
  });
});
