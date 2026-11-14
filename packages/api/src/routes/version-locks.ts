// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectId } from '@kindgi/types';

import type { ItemRights } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import type {
  VersionLock,
  VersionLocksBinding,
  VersionLocksInput,
} from '../version-locks-binding.js';

/** What an unregister answer's `lockedBy` is read with. */
export interface LockedByDeps {
  /** What can still run a version; absent → the answer has no `lockedBy`. */
  readonly versionLocks: VersionLocksBinding | undefined;
  /** Absent → every caller reads every lock. */
  readonly authorizer: Authorizer | undefined;
  /** Rights on an item more than one project serves (`item-rights.ts`); absent → the item's own. */
  readonly itemRights: ItemRights | undefined;
}

/**
 * An unregister answer's `lockedBy`, when the deployment can tell what can
 * still run the version (`versionLocks`): the locks the caller may read,
 * as every list leaves out what it may not. The version is unregistered
 * either way, so a read that fails leaves the field out, as a server that
 * can't tell does. It's logged, by the error's name only.
 */
export async function lockedByField(
  c: Context<AppEnv>,
  deps: LockedByDeps,
  input: VersionLocksInput,
): Promise<{ readonly lockedBy?: readonly VersionLock[] }> {
  if (deps.versionLocks === undefined) return {};
  try {
    const locks = (await deps.versionLocks.lockedBy(input)).map(
      (lock): VersionLock => ({
        kind: lock.kind,
        id: lock.id,
        version: lock.version,
        ...(lock.unregistered === true && { unregistered: true as const }),
      }),
    );
    return { lockedBy: await readable(c, locks, deps) };
  } catch (cause) {
    c.get('log').warn('What locks an unregistered version could not be read', {
      kind: input.kind,
      id: input.id,
      version: input.version,
      error: cause instanceof Error ? cause.name : typeof cause,
    });
    return {};
  }
}

/**
 * The locks the caller may read, in their order: today's read on the
 * agent or flow, or for one more than one project serves, rules 1 and 2
 * at the lock's own version, as `GET …/versions/:version` asks.
 */
async function readable(
  c: Context<AppEnv>,
  locks: readonly VersionLock[],
  { authorizer, itemRights }: LockedByDeps,
): Promise<readonly VersionLock[]> {
  if (authorizer === undefined || locks.length === 0) return locks;
  const today = (lock: VersionLock) => ref(lock.kind, lock.id);
  if (itemRights === undefined) return authorizer.filterByCan(c, 'read', locks, today);
  const served = new Map<VersionLock, readonly ProjectId[]>();
  for (const kind of ['agent', 'flow'] as const) {
    const ofKind = locks.filter((lock) => lock.kind === kind);
    const many = await itemRights.multiOfMany(
      c,
      kind,
      ofKind.map((lock) => lock.id),
    );
    for (const lock of ofKind) {
      const projects = many.get(lock.id);
      if (projects !== undefined) served.set(lock, projects);
    }
  }
  const kept = new Set(
    await authorizer.filterByCan(
      c,
      'read',
      locks.filter((lock) => !served.has(lock)),
      today,
    ),
  );
  for (const [lock, projects] of served) {
    if (await itemRights.versionVisible(c, lock.kind, lock.id, projects, lock.version)) {
      kept.add(lock);
    }
  }
  return locks.filter((lock) => kept.has(lock));
}
