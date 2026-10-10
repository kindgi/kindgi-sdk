// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectRole } from '@kindgi/platform';

/** A role to give on a project: any `ProjectRole` but `member`, which is only read. */
export type AssignableProjectRole = Exclude<ProjectRole, 'member'>;

export const ASSIGNABLE_PROJECT_ROLES: readonly AssignableProjectRole[] = [
  'viewer',
  'editor',
  'owner',
  'admin',
];

/**
 * `role` as a role to give on a project, or why it isn't one (`field`
 * names it). `member` is retired: it's refused naming `viewer`, which
 * grants the same; one given before it was retired still reads as `member`.
 */
export function parseAssignableProjectRole(
  role: unknown,
  field: string,
):
  | { readonly kind: 'ok'; readonly value: AssignableProjectRole }
  | { readonly kind: 'err'; readonly message: string } {
  if (role === 'member') {
    return {
      kind: 'err',
      message: "`member` isn't a project role: use `viewer`, which grants the same",
    };
  }
  if (!ASSIGNABLE_PROJECT_ROLES.includes(role as AssignableProjectRole)) {
    return {
      kind: 'err',
      message: `${field} must be one of: ${ASSIGNABLE_PROJECT_ROLES.join(', ')}`,
    };
  }
  return { kind: 'ok', value: role as AssignableProjectRole };
}
