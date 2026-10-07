// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { GatePolicy } from '../gate-policy-binding.js';
import { liveScopeToWire } from './live-scope-wire.js';

export function serializeGatePolicy(p: GatePolicy): Record<string, unknown> {
  return {
    id: p.id,
    version: p.version,
    agentId: p.agentId,
    scope: liveScopeToWire(p.scope),
    spec: p.spec,
    ...(p.description !== undefined && { description: p.description }),
    createdAt: p.createdAt as unknown as string,
    ...(p.unregisteredAt !== undefined && {
      unregisteredAt: p.unregisteredAt as unknown as string,
    }),
  };
}
