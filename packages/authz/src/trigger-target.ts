// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ref } from './check.js';
import type { Action, ResourceRef } from './types.js';

/**
 * What a trigger starts, by shape: a flow, an agent, or an improvement
 * pass on an agent. A schedule's or webhook's target fits it as is.
 */
export type TriggerTargetRef =
  | { readonly kind: 'flow'; readonly flowId: string }
  | { readonly kind: 'agent' | 'improve'; readonly agentId: string };

/**
 * What running a trigger's target takes of an item one project serves, as
 * starting it by hand does: `execute` on the flow or agent a run starts;
 * `publish` on the agent an improvement pass works on (as
 * `POST /v1/proposals/improve`). The rule a trigger's checks use is
 * `@kindgi/api`'s `runAccess`, at register, on a change and at every
 * fire, so they can't disagree: for an item more than one project serves,
 * it asks the trigger's project's right instead, and this answer otherwise.
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
