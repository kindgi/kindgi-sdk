// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { isRecallReadableBy } from '../src/index.js';
import type { MemoryReaders } from '../src/index.js';

/** The recall guard: a conversation is always someone's. */
describe('isRecallReadableBy', () => {
  const p1 = 'p-1' as never;
  const p2 = 'p-2' as never;
  const mine: MemoryReaders = {
    projectIds: [p1],
    participantIds: ['end-7'],
    threadIds: ['conv-now' as never],
  };

  test("the same end user's other conversations in the run's project", () => {
    expect(
      isRecallReadableBy({ conversationId: 'c-1', projectId: 'p-1', participantId: 'end-7' }, mine),
    ).toBe(true);
  });

  test("another end user's are not, unless the readers act in the project for all of them", () => {
    const theirs = { conversationId: 'c-2', projectId: 'p-1', participantId: 'end-8' };
    expect(isRecallReadableBy(theirs, mine)).toBe(false);
    expect(isRecallReadableBy(theirs, { ...mine, onBehalfOfProjectIds: [p1] })).toBe(true);
  });

  test("another project's are not, even the same end user's", () => {
    expect(
      isRecallReadableBy({ conversationId: 'c-3', projectId: 'p-2', participantId: 'end-7' }, mine),
    ).toBe(false);
    // Acting for every end user in one project gives no right on another.
    expect(
      isRecallReadableBy(
        { conversationId: 'c-3', projectId: 'p-2', participantId: 'end-8' },
        { ...mine, onBehalfOfProjectIds: [p1] },
      ),
    ).toBe(false);
    expect(
      isRecallReadableBy(
        { conversationId: 'c-3', projectId: 'p-2', participantId: 'end-8' },
        { ...mine, projectIds: [p1, p2], onBehalfOfProjectIds: [p2] },
      ),
    ).toBe(true);
  });

  test('a conversation naming no person is readable only from inside it, or for its whole project', () => {
    const anonymous = { conversationId: 'c-4', projectId: 'p-1' };
    expect(isRecallReadableBy(anonymous, mine)).toBe(false);
    expect(isRecallReadableBy({ ...anonymous, conversationId: 'conv-now' }, mine)).toBe(true);
    expect(isRecallReadableBy(anonymous, { ...mine, onBehalfOfProjectIds: [p1] })).toBe(true);
  });

  test('without a project: only by the person, or from inside it', () => {
    expect(isRecallReadableBy({ conversationId: 'c-5', participantId: 'end-7' }, mine)).toBe(true);
    expect(isRecallReadableBy({ conversationId: 'c-5', participantId: 'end-8' }, mine)).toBe(false);
    expect(
      isRecallReadableBy({ conversationId: 'c-5' }, { ...mine, onBehalfOfProjectIds: [p1] }),
    ).toBe(false);
  });

  test("an app's credential is one user for all its end users: the user never opens an end user's conversation", () => {
    const app: MemoryReaders = {
      projectIds: [p1],
      userIds: ['app-user' as never],
      participantIds: ['end-7'],
    };
    expect(
      isRecallReadableBy(
        { conversationId: 'c-8', projectId: 'p-1', participantId: 'end-8', userId: 'app-user' },
        app,
      ),
    ).toBe(false);
    expect(
      isRecallReadableBy(
        { conversationId: 'c-9', projectId: 'p-1', participantId: 'end-7', userId: 'app-user' },
        app,
      ),
    ).toBe(true);
  });

  test('the user the run acts for: their own conversations', () => {
    const readers: MemoryReaders = { projectIds: [p1], userIds: ['alice' as never] };
    expect(
      isRecallReadableBy({ conversationId: 'c-6', projectId: 'p-1', userId: 'alice' }, readers),
    ).toBe(true);
    expect(
      isRecallReadableBy({ conversationId: 'c-6', projectId: 'p-1', userId: 'bob' }, readers),
    ).toBe(false);
  });

  test('a tenant admin reads all', () => {
    expect(isRecallReadableBy({ conversationId: 'c-7', projectId: 'p-2' }, { all: true })).toBe(
      true,
    );
  });
});
