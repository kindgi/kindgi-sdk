// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MemoryReaders, MemoryScope } from './types.js';

/**
 * Whether `readers` may see a fact in `scope`: the scope guard, as every
 * memory binding applies it inside its queries (a SQL binding's guard
 * must agree with this one, case for case).
 *
 * Each container the scope names must be one the readers have:
 *   - its project (or one they act in for all end users,
 *     `onBehalfOfProjectIds`);
 *   - its org, for an org-wide fact (no project);
 *   - its user;
 *   - its participant, or the project on behalf of all of them;
 *   - its thread, or the project on behalf of all of them.
 * A fact naming none of them is tenant-wide: every reader sees it. The
 * session is not a container.
 */
export function isReadableBy(scope: MemoryScope, readers: MemoryReaders): boolean {
  if (readers.all === true) return true;
  const project = scope.projectId;
  const has = <T>(ids: readonly T[] | undefined, id: T) => ids?.includes(id) === true;
  const onBehalf = project !== undefined && has(readers.onBehalfOfProjectIds, project);
  if (project !== undefined && !(has(readers.projectIds, project) || onBehalf)) return false;
  if (project === undefined && scope.orgId !== undefined && !has(readers.orgIds, scope.orgId)) {
    return false;
  }
  if (scope.userId !== undefined && !has(readers.userIds, scope.userId)) return false;
  if (
    scope.participantId !== undefined &&
    !(has(readers.participantIds, scope.participantId) || onBehalf)
  ) {
    return false;
  }
  if (scope.threadId !== undefined && !(has(readers.threadIds, scope.threadId) || onBehalf)) {
    return false;
  }
  return true;
}
