// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * What can still run a tool or agent version: the agent and flow versions
 * that lock it. `POST /v1/tools/:toolId/versions/:version/unregister` and
 * `POST /v1/agents/:agentId/versions/:version/unregister` answer the ones
 * the caller may read as `lockedBy`, as the lists leave out the rest. A
 * separate surface, so a registry fake needn't answer it; a
 * deployment answers it from its stored versions.
 */
export interface VersionLocksBinding {
  /**
   * The registered agent and flow versions that lock the version, and the
   * unregistered agent versions that a registered flow version still runs
   * (`unregistered: true`). Runs in flight aren't listed. Every one is
   * listed, sorted by kind, id, then version; `[]` when nothing locks it.
   * Tenant-scoped.
   */
  lockedBy(input: VersionLocksInput): Promise<readonly VersionLock[]>;
}

export interface VersionLocksInput {
  readonly tenantId: TenantId;
  /** What the version is a version of. */
  readonly kind: 'tool' | 'agent';
  readonly id: string;
  readonly version: string;
}

/** One agent or flow version that locks a version. */
export interface VersionLock {
  readonly kind: 'agent' | 'flow';
  readonly id: string;
  readonly version: string;
  /** Present when this agent version is unregistered: a registered flow version still runs it. */
  readonly unregistered?: true;
}
