// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReleaseGate } from '../release-gate-binding.js';
import { agentPinScopeToWire } from './agent-pin-scope-wire.js';

export function serializeReleaseGate(p: ReleaseGate): Record<string, unknown> {
  return {
    id: p.id,
    version: p.version,
    agentId: p.agentId,
    scope: agentPinScopeToWire(p.scope),
    spec: p.spec,
    ...(p.description !== undefined && { description: p.description }),
    createdAt: p.createdAt as unknown as string,
    ...(p.unregisteredAt !== undefined && {
      unregisteredAt: p.unregisteredAt as unknown as string,
    }),
  };
}
