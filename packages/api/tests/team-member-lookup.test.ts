// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Adding a team member names a person of the tenant, as adding a project
 * member does (`project-member-lookup.test.ts`): the route resolves the id
 * through the identity directory, and someone who isn't a person of this
 * tenant, was removed from it, or is named by an id that isn't one, is
 * refused (`404 identity-user-not-found`) and nothing is added. Without a
 * directory, an id is taken as given.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { makeInMemoryTeamBinding } from '@kindgi/platform';
import type { TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  IdentityDirectoryBinding,
  RunHandlerBinding,
  TokenResolver,
  UserRecord,
} from '../src/index.js';

const TOKEN = 'team-member-lookup-token';
const tenantId = randomUUID() as TenantId;
const alice = randomUUID() as UserId;
/** Removed from the tenant. */
const bob = randomUUID() as UserId;

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

const person = (userId: UserId, removed = false): UserRecord => ({
  userId,
  tenantId,
  displayName: 'someone',
  createdAt: '2026-10-01T00:00:00.000Z' as Timestamp,
  ...(removed && { unregisteredAt: '2026-10-05T00:00:00.000Z' as Timestamp }),
});
const PEOPLE = [person(alice), person(bob, true)];

/** The tenant's people. A lookup returns removed people too: the route must not take them. */
const directory: IdentityDirectoryBinding = {
  getUser: async ({ userId }) => PEOPLE.find((p) => p.userId === userId) ?? null,
  listUsers: async () => ({ data: PEOPLE }),
  listSessions: async () => ({ data: [] }),
  revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
};

async function makeApp(withDirectory: boolean) {
  const pair = makeInMemoryTeamBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    teamBinding: pair.teams,
    teamMembershipBinding: pair.memberships,
    ...(withDirectory && { identityDirectory: directory }),
  });
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const made = await app.request('/v1/teams', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Support crew', slug: 'support-crew' }),
  });
  if (made.status !== 201) throw new Error(`team create failed: ${made.status}`);
  const { id: teamId } = (await made.json()) as { id: string };
  const add = async (userId: string) => {
    const res = await app.request(`/v1/teams/${teamId}/memberships`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId, role: 'member' }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return { status: res.status, code: body.error?.code, message: body.error?.message };
  };
  const members = async () =>
    (await pair.memberships.list(tenantId, teamId as never, {})).items.map((m) => m.userId);
  return { add, members };
}

describe('POST /v1/teams/{teamId}/memberships names a person of the tenant', () => {
  test('a person of the tenant: added', async () => {
    const { add, members } = await makeApp(true);
    expect((await add(alice)).status).toBe(201);
    expect(await members()).toEqual([alice]);
  });

  test.each([
    ['not a person of this tenant', () => randomUUID()],
    ['removed from it', () => bob],
    ['named by an id that is not one', () => 'not-a-uuid'],
  ])('%s: 404 identity-user-not-found, nothing added', async (_what, userId) => {
    const { add, members } = await makeApp(true);
    const id = userId();
    expect(await add(id)).toEqual({
      status: 404,
      code: 'identity-user-not-found',
      message: `User "${id}" is not a member of this workspace`,
    });
    expect(await members()).toEqual([]);
  });

  test('without a directory, an id is taken as given', async () => {
    const { add, members } = await makeApp(false);
    const stranger = randomUUID();
    expect((await add(stranger)).status).toBe(201);
    expect(await members()).toEqual([stranger]);
  });
});
