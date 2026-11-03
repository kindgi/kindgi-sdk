// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ref } from './check.js';
import type { Action, ResourceRef } from './types.js';

/**
 * What a trigger starts, by shape: a flow, an agent, or an Improve
 * run on an agent. A schedule's or webhook's target fits it as is.
 */
export type TriggerTargetRef =
  | { readonly kind: 'flow'; readonly flowId: string }
  | { readonly kind: 'agent' | 'improve'; readonly agentId: string };

/**
 * What running a trigger's target takes, as starting it by hand does:
 * `execute` on the flow or agent a run starts; `publish` on the agent an
 * Improve run works on (as `POST /v1/improve-runs`). The one
 * mapping a trigger's checks use, when its owner is set and at every
 * fire, so the two can't disagree.
 */
export function targetAccess(target: TriggerTargetRef): [Action, ResourceRef] {
  switch (target.kind) {
    case 'flow':
      return ['execute', ref('flow', target.flowId)];
    case 'agent':
      return ['execute', ref('agent', target.agentId)];
    case 'improve':
      return ['publish', ref('agent', target.agentId)];
  }
}
