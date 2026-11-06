// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Logger } from '@kindgi/log';

import type {
  VersionLock,
  VersionLocksBinding,
  VersionLocksInput,
} from '../version-locks-binding.js';

/**
 * An unregister answer's `lockedBy`, when the deployment can tell what can
 * still run the version (`versionLocks`). The version is unregistered
 * either way, so a read that fails leaves the field out, as a server that
 * can't tell does. It's logged, by the error's name only.
 */
export async function lockedByField(
  versionLocks: VersionLocksBinding | undefined,
  input: VersionLocksInput,
  log: Logger,
): Promise<{ readonly lockedBy?: readonly VersionLock[] }> {
  if (versionLocks === undefined) return {};
  try {
    const locks = await versionLocks.lockedBy(input);
    return {
      lockedBy: locks.map((lock) => ({
        kind: lock.kind,
        id: lock.id,
        version: lock.version,
        ...(lock.unregistered === true && { unregistered: true as const }),
      })),
    };
  } catch (cause) {
    log.warn('What locks an unregistered version could not be read', {
      kind: input.kind,
      id: input.id,
      version: input.version,
      error: cause instanceof Error ? cause.name : typeof cause,
    });
    return {};
  }
}
