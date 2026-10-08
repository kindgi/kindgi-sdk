// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { type Action, ref } from '@kindgi/authz';
import type { TenantId, TriggerId } from '@kindgi/types';

import type { Authorizer } from '../middleware/authorize.js';
import type { TriggerRecord, TriggerRegistryBinding } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';

/**
 * Who may manage an event or webhook trigger (T243 A): the flow it fires.
 * A trigger has no parent tuple of its own, so every check names its
 * flow: `read` to see it; `write` to pause, resume or unregister it; and
 * `write` plus `execute` to register it or change what it runs, since it
 * starts runs of the flow as its registrant would. With no authorizer,
 * nothing is checked.
 */
export interface TriggerAccess {
  /** Registering a trigger for `flowId`: the refusal, if any. */
  onRegister(c: Context<AppEnv>, flowId: string): Promise<Response | undefined>;
  /**
   * A route on one trigger: the refusal, if any. A trigger that isn't
   * there, or is of another kind, passes on to the handler's 404.
   */
  onTrigger(
    c: Context<AppEnv>,
    triggerId: TriggerId,
    actions: readonly Action[],
  ): Promise<Response | undefined>;
  /** The rows of a list whose flow the caller may read. */
  visible<T extends { readonly flowId: string }>(
    c: Context<AppEnv>,
    rows: readonly T[],
  ): Promise<readonly T[]>;
}

export function triggerAccess(
  binding: TriggerRegistryBinding,
  kind: TriggerRecord['kind'],
  authorizer: Authorizer | undefined,
): TriggerAccess {
  const onFlow = async (
    c: Context<AppEnv>,
    flowId: string,
    actions: readonly Action[],
  ): Promise<Response | undefined> => {
    for (const action of actions) {
      const refused = await deniedBy(authorizer, c, action, ref('flow', flowId));
      if (refused !== undefined) return refused;
    }
    return undefined;
  };
  return {
    onRegister: (c, flowId) => onFlow(c, flowId, ['write', 'execute']),
    async onTrigger(c, triggerId, actions) {
      if (authorizer === undefined) return undefined;
      const tenantId = c.get('tenantId') as TenantId;
      const rec = await binding.get({ tenantId, triggerId });
      if (rec === null || rec.kind !== kind) return undefined;
      return onFlow(c, rec.flowId, actions);
    },
    async visible(c, rows) {
      if (authorizer === undefined) return rows;
      return authorizer.filterByCan(c, 'read', rows, (row) => ref('flow', row.flowId));
    },
  };
}
