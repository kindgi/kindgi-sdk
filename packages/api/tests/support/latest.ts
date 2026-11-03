// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/types';

import type { AgentRegistryBinding, LatestBinding } from '../../src/index.js';

/**
 * Latest as the highest active version: a test's stand-in for a
 * runtime's Latest, where a test isn't about which version is Latest. No
 * project has one of its own (`byProject`).
 */
export function highestAsLatest(agents: Pick<AgentRegistryBinding, 'get'>): LatestBinding {
  return {
    async latest({ tenantId, agentId }) {
      const agent = await agents.get({ tenantId, agentId: agentId as AgentId });
      return agent === null ? null : { version: agent.version, since: '2026-01-01T00:00:00.000Z' };
    },
    byProject: async () => [],
  };
}

/** No Latest anywhere: for a test that never asks what an unpinned scope runs. */
export const noLatest: LatestBinding = {
  latest: async () => null,
  byProject: async () => [],
};
