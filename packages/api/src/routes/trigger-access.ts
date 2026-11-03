// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { type Action, ref } from '@kindgi/authz';
import type { TenantId, TriggerId } from '@kindgi/types';

import { type ItemRights, filterOwned, runIn } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { TriggerRegistryBinding } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';

/**
 * Who may manage an event trigger (T243 A): the flow it fires. (Schedules
 * and webhook triggers have a project, and their routers check it.)
 * A trigger has no parent tuple of its own, so every check names its
 * flow: `read` to see it; `write` to pause, resume or unregister it; and
 * `write` plus `execute` to register it or change what it runs, since it
 * starts runs of the flow as its registrant would. With no authorizer,
 * nothing is checked.
 *
 * A flow more than one project serves runs from an event trigger in its
 * first project, where a run that names none is filed. So that project
 * decides what the trigger's flow did alone: `read` on it to see the
 * trigger, and its `execute` (`runIn`) to register it or change what it
 * runs. `write` stays the flow's.
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
  kind: 'event',
  authorizer: Authorizer | undefined,
  /** Rights on a flow more than one project serves. Absent: one project each. */
  itemRights?: ItemRights,
): TriggerAccess {
  const onFlow = async (
    c: Context<AppEnv>,
    flowId: string,
    actions: readonly Action[],
  ): Promise<Response | undefined> => {
    const served =
      authorizer === undefined ? undefined : await itemRights?.multi(c, 'flow', flowId);
    const first = served?.[0] as unknown as string | undefined;
    for (const action of actions) {
      const refused =
        itemRights === undefined || first === undefined || action === 'write'
          ? await deniedBy(authorizer, c, action, ref('flow', flowId))
          : action === 'execute'
            ? await runIn(c, itemRights, { kind: 'flow', id: flowId }, first)
            : await deniedBy(authorizer, c, action, ref('project', first));
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
      // A schedule's and a webhook trigger's access is their router's own (their project).
      if (rec === null || rec.kind !== kind) return undefined;
      return onFlow(c, rec.flowId, actions);
    },
    async visible(c, rows) {
      if (authorizer === undefined) return rows;
      return filterOwned(c, authorizer, itemRights, 'flow', rows, {
        idOf: (row) => row.flowId,
        projectOf: (_row, projects) => projects[0] as unknown as string | undefined,
        todayRef: (row) => ref('flow', row.flowId),
      });
    },
  };
}
