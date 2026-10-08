// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import {
  type CronTriggerRecord,
  type ListTriggerFiresInput,
  type RegisterTriggerInput,
  SCHEDULE_DEFAULTS,
  type TriggerFire,
  type TriggerFirePage,
  type TriggerLifecycleInput,
  type TriggerOwner,
  type TriggerRecord,
  type TriggerRegistryBinding,
  type UpdateTriggerInput,
} from '@kindgi/runtime';
import type { Cursor, ProjectId, TenantId, TriggerId } from '@kindgi/types';

/**
 * An in-memory `TriggerRegistryBinding` for app and route tests: the
 * admin surface over stored triggers, with fire history and `run-now`.
 * It computes no occurrences (`nextFireAt` stays `null`) and starts no
 * runs; `fireNow` records a `pending` fire, and `recordFire` lets a test
 * add fires as a scheduler would.
 */
export interface InMemoryTriggerRegistry extends TriggerRegistryBinding {
  /** Add a fire to a trigger's history, as a scheduler would. */
  recordFire(fire: Omit<TriggerFire, 'fireId'> & { readonly fireId?: string }): TriggerFire;
}

export function createInMemoryTriggerRegistry(
  options: {
    /** The project a schedule registered without one goes to. */
    readonly defaultProjectId?: ProjectId;
    readonly now?: () => Date;
  } = {},
): InMemoryTriggerRegistry {
  const rows = new Map<string, TriggerRecord & { unregistered?: boolean }>();
  const fires: TriggerFire[] = [];
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const defaultProject =
    options.defaultProjectId ?? ('00000000-0000-4000-8000-000000000000' as ProjectId);

  const live = (tenantId: TenantId, triggerId: TriggerId) => {
    const row = rows.get(triggerId as unknown as string);
    return row !== undefined && row.tenantId === tenantId && row.unregistered !== true
      ? row
      : undefined;
  };
  const notFound = (triggerId: TriggerId) => ({
    kind: 'err' as const,
    error: {
      code: 'trigger-not-found' as const,
      message: `No trigger "${triggerId as unknown as string}"`,
      triggerId,
    },
  });
  const save = (row: TriggerRecord): TriggerRecord => {
    rows.set(row.triggerId as unknown as string, row);
    return row;
  };
  const strip = (row: TriggerRecord & { unregistered?: boolean }): TriggerRecord => {
    const { unregistered: _, ...rest } = row;
    return rest as TriggerRecord;
  };

  const registry: InMemoryTriggerRegistry = {
    async register(input: RegisterTriggerInput) {
      const base = {
        triggerId: randomUUID() as TriggerId,
        tenantId: input.tenantId,
        status: 'active' as const,
        label: input.label ?? null,
        lastFiredAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      if (input.kind === 'cron') {
        return {
          kind: 'ok',
          value: save({
            ...base,
            kind: 'cron',
            target: input.target,
            projectId: input.projectId ?? defaultProject,
            owner: input.owner,
            config: input.config,
            catchUp: input.catchUp ?? SCHEDULE_DEFAULTS.catchUp,
            overlap: input.overlap ?? SCHEDULE_DEFAULTS.overlap,
            startingDeadlineSeconds:
              input.startingDeadlineSeconds ?? SCHEDULE_DEFAULTS.startingDeadlineSeconds,
            nextFireAt: null,
          }),
        };
      }
      const flow = { flowId: input.flowId, flowVersion: input.flowVersion };
      return {
        kind: 'ok',
        value: save(
          input.kind === 'event'
            ? { ...base, ...flow, kind: 'event', config: input.config }
            : {
                ...base,
                ...flow,
                kind: 'webhook',
                config: input.config,
                webhookId: input.webhookId,
                hmacSecretName: input.hmacSecretName,
              },
        ),
      };
    },

    async update(input: UpdateTriggerInput) {
      const row = live(input.tenantId, input.triggerId);
      if (row === undefined || row.kind !== input.kind) return notFound(input.triggerId);
      const common = {
        updatedAt: now(),
        ...(input.label !== undefined && { label: input.label }),
      };
      if (row.kind === 'cron' && input.kind === 'cron') {
        return {
          kind: 'ok',
          value: save({
            ...row,
            ...common,
            config: { ...row.config, ...input.config },
            ...(input.target !== undefined && { target: input.target }),
            ...(input.catchUp !== undefined && { catchUp: input.catchUp }),
            ...(input.overlap !== undefined && { overlap: input.overlap }),
            ...(input.startingDeadlineSeconds !== undefined && {
              startingDeadlineSeconds: input.startingDeadlineSeconds,
            }),
          } as CronTriggerRecord),
        };
      }
      return {
        kind: 'ok',
        value: save({
          ...row,
          ...common,
          config: { ...row.config, ...input.config },
          ...(input.kind !== 'cron' &&
            input.flowVersion !== undefined && { flowVersion: input.flowVersion }),
        } as TriggerRecord),
      };
    },

    async list(input) {
      const all = [...rows.values()]
        .filter(
          (r) =>
            r.tenantId === input.tenantId &&
            r.unregistered !== true &&
            (input.kind === undefined || r.kind === input.kind) &&
            (input.status === undefined || r.status === input.status),
        )
        .map(strip);
      const start = input.cursor === undefined ? 0 : Number(input.cursor);
      const limit = input.limit ?? 50;
      const data = all.slice(start, start + limit);
      return {
        data,
        ...(start + limit < all.length && { nextCursor: String(start + limit) as Cursor }),
      };
    },

    async get(input) {
      const row = live(input.tenantId, input.triggerId);
      return row === undefined ? null : strip(row);
    },

    async pause(input: TriggerLifecycleInput) {
      return setStatus(input, 'paused');
    },

    async resume(input: TriggerLifecycleInput) {
      return setStatus(input, 'active');
    },

    async unregister(input) {
      const row = live(input.tenantId, input.triggerId);
      if (row === undefined) return { triggerId: input.triggerId, unregistered: false };
      rows.set(input.triggerId as unknown as string, { ...row, unregistered: true });
      return { triggerId: input.triggerId, unregistered: true };
    },

    async fetchActiveByWebhookId(input) {
      const row = [...rows.values()].find(
        (r) =>
          r.kind === 'webhook' &&
          r.tenantId === input.tenantId &&
          r.webhookId === input.webhookId &&
          r.status === 'active' &&
          r.unregistered !== true,
      );
      return row?.kind === 'webhook' ? row : null;
    },

    async listFires(input: ListTriggerFiresInput): Promise<TriggerFirePage> {
      const mine = fires
        .filter((f) => f.triggerId === input.triggerId && live(input.tenantId, f.triggerId))
        .reverse();
      const start = input.cursor === undefined ? 0 : Number(input.cursor);
      const limit = input.limit ?? 50;
      return {
        data: mine.slice(start, start + limit),
        ...(start + limit < mine.length && { nextCursor: String(start + limit) as Cursor }),
      };
    },

    async fireNow(input: TriggerLifecycleInput) {
      const row = live(input.tenantId, input.triggerId);
      if (row === undefined || row.kind !== 'cron') return notFound(input.triggerId);
      return {
        kind: 'ok',
        value: registry.recordFire({
          triggerId: input.triggerId,
          kind: 'schedule',
          firedAt: now(),
          outcome: 'pending',
          manual: true,
        }),
      };
    },

    async setOwner(input: TriggerLifecycleInput & { readonly owner: TriggerOwner }) {
      const row = live(input.tenantId, input.triggerId);
      if (row === undefined || row.kind !== 'cron') return notFound(input.triggerId);
      return { kind: 'ok', value: save({ ...row, owner: input.owner, updatedAt: now() }) };
    },

    recordFire(fire) {
      const recorded: TriggerFire = { ...fire, fireId: fire.fireId ?? randomUUID() };
      fires.push(recorded);
      return recorded;
    },
  };

  async function setStatus(input: TriggerLifecycleInput, status: 'active' | 'paused') {
    const row = live(input.tenantId, input.triggerId);
    if (row === undefined) return notFound(input.triggerId);
    if (row.status === status) {
      return {
        kind: 'err' as const,
        error: {
          code: 'trigger-already-in-state' as const,
          message: `The trigger is already ${status}`,
          triggerId: input.triggerId,
        },
      };
    }
    return { kind: 'ok' as const, value: save({ ...row, status, updatedAt: now() }) };
  }

  return registry;
}
