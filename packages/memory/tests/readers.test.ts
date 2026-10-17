// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { OrgId, ProjectId, TenantId, ThreadId, UserId } from '@kindgi/types';

import { type MemoryReaders, type MemoryScope, isReadableBy } from '../src/index.js';

const tenantId = 't-1' as TenantId;
const acme = 'p-acme' as ProjectId;
const globex = 'p-globex' as ProjectId;
const org = 'o-1' as OrgId;
const thread = 'th-1' as ThreadId;

const scope = (s: Partial<MemoryScope>): MemoryScope => ({ tenantId, ...s });

/** A run in acme, for end user `e-1`, in conversation `th-1`, acting for `u-1`. */
const run: MemoryReaders = {
  projectIds: [acme],
  orgIds: [org],
  userIds: ['u-1' as UserId],
  participantIds: ['e-1'],
  threadIds: [thread],
};

describe('isReadableBy', () => {
  test.each([
    ['tenant-wide', {}, true],
    ['its org', { orgId: org }, true],
    ['another org', { orgId: 'o-2' as OrgId }, false],
    ['its project', { projectId: acme }, true],
    ['another project', { projectId: globex }, false],
    ['its project in another org field', { projectId: acme, orgId: 'o-2' as OrgId }, true],
    ['its user', { userId: 'u-1' as UserId }, true],
    ['another user', { userId: 'u-2' as UserId }, false],
    ['its end user', { projectId: acme, participantId: 'e-1' }, true],
    ['another end user', { projectId: acme, participantId: 'e-2' }, false],
    ['its conversation', { projectId: acme, threadId: thread }, true],
    ['another conversation', { projectId: acme, threadId: 'th-2' as ThreadId }, false],
    ['its end user in another project', { projectId: globex, participantId: 'e-1' }, false],
    ['a session (not a container)', { sessionId: 's-9' as never }, true],
  ] as const)('a run sees %s: %s', (_name, s, expected) => {
    expect(isReadableBy(scope(s), run)).toBe(expected);
  });

  test("a fact in globex's project never reaches acme", () => {
    expect(isReadableBy(scope({ projectId: globex }), { projectIds: [acme] })).toBe(false);
  });

  test("acting for a project's end users reads every participant and thread there, nowhere else", () => {
    const app: MemoryReaders = { projectIds: [acme], onBehalfOfProjectIds: [acme] };
    expect(isReadableBy(scope({ projectId: acme, participantId: 'any' }), app)).toBe(true);
    expect(isReadableBy(scope({ projectId: acme, threadId: thread }), app)).toBe(true);
    expect(isReadableBy(scope({ projectId: globex, participantId: 'any' }), app)).toBe(false);
    expect(isReadableBy(scope({ userId: 'u-1' as UserId }), app)).toBe(false);
  });

  test('no readers: tenant-wide facts only; all: everything', () => {
    expect(isReadableBy(scope({}), {})).toBe(true);
    expect(isReadableBy(scope({ projectId: acme }), {})).toBe(false);
    expect(isReadableBy(scope({ userId: 'u-2' as UserId, projectId: globex }), { all: true })).toBe(
      true,
    );
  });
});
