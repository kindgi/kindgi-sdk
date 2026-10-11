// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Schedules — cron-triggered flow runs.
 *
 * @wire /v1/schedules/*  (packages/api/src/routes/schedules.ts)
 * @generated Wire shapes imported from `../generated/api.js`, which is
 *   regenerated from `@kindgi/api/openapi.json` via `typed-openapi`. Never
 *   hand-edit those types — edit `packages/api/src/openapi/{operations,
 *   schemas}.ts` and re-run `pnpm --filter @kindgi/api gen:openapi`.
 *
 * A registered schedule starts a run of an agent or a flow each time its
 * cron expression comes due, as its owner (whoever registered it); a run
 * it started names it (`Run.trigger`). After a gap it runs once for the
 * latest missed occurrence (`catchUp: 'latest'`, the default) or skips
 * them, and it skips an occurrence while its previous run is still going
 * (`overlap: 'skip'`, the default). `fires` is its history.
 *
 * Soft-delete: `unregister()` tombstones the schedule. Tombstoned
 * schedules are excluded from `list` and return 404 from `get`.
 */

import type {
  PatchScheduleBody,
  RegisterScheduleBody,
  ScheduleCollectionPage,
  ScheduleFirePage as ScheduleFirePageWire,
  ScheduleFire as ScheduleFireWire,
  ScheduleRecord,
  ScheduleUnregisterResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

// Wire-shape types (inferred from Zod schemas — same object).
export type Schedule = ScheduleRecord;
export type SchedulePage = ScheduleCollectionPage;
export type RegisterScheduleInput = RegisterScheduleBody;
export type UpdateScheduleInput = PatchScheduleBody;
export type UnregisterScheduleResult = ScheduleUnregisterResult;
export type ScheduleFire = ScheduleFireWire;
export type ScheduleFirePage = ScheduleFirePageWire;

export interface ListScheduleFiresFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListSchedulesFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: 'active' | 'paused';
  /**
   * Only this project's schedules. A runtime before 0.1.6 ignores it and
   * lists every project's.
   */
  readonly projectId?: string;
}

export interface SchedulesClient {
  /**
   * Register a cron schedule. Route validates the cron expression;
   * malformed → `trigger-invalid-config` (400).
   *
   * @wire POST /v1/schedules
   */
  register(input: RegisterScheduleInput, options?: MutationOptions): Promise<Schedule>;

  /**
   * Cursor-paginated list. Optional `status` filter; tombstoned rows
   * are excluded automatically.
   *
   * @wire GET /v1/schedules
   */
  list(filter?: ListSchedulesFilter): Promise<SchedulePage>;

  /**
   * Fetch a single schedule by trigger id. Returns 404
   * `trigger-not-found` for unknown or tombstoned rows.
   *
   * @wire GET /v1/schedules/:triggerId
   */
  get(triggerId: string, options?: { readonly upcoming?: number }): Promise<Schedule>;

  /**
   * Partial update. Passing `label: null` clears; omit to leave
   * unchanged. Cron expression change recomputes `nextFireAt`.
   *
   * @wire PATCH /v1/schedules/:triggerId
   */
  update(
    triggerId: string,
    input: UpdateScheduleInput,
    options?: MutationOptions,
  ): Promise<Schedule>;

  /**
   * Pause. Idempotent-per-state: already-paused → 409
   * `trigger-already-in-state`.
   *
   * @wire POST /v1/schedules/:triggerId/pause
   */
  pause(triggerId: string, options?: MutationOptions): Promise<Schedule>;

  /**
   * Resume. Recomputes `nextFireAt` so the scheduler picks up the
   * resumed row on its next tick.
   *
   * @wire POST /v1/schedules/:triggerId/resume
   */
  resume(triggerId: string, options?: MutationOptions): Promise<Schedule>;

  /**
   * Soft-delete (tombstone). Idempotent: repeat call returns
   * `unregistered: false`.
   *
   * @wire POST /v1/schedules/:triggerId/unregister
   */
  unregister(triggerId: string, options?: MutationOptions): Promise<UnregisterScheduleResult>;

  /**
   * The schedule's fire history, newest first: each occurrence (and
   * run-now), the run it started, or why it was skipped, refused or failed.
   *
   * @wire GET /v1/schedules/:triggerId/fires
   */
  fires(triggerId: string, filter?: ListScheduleFiresFilter): Promise<ScheduleFirePage>;

  /**
   * Fire it now, outside the schedule: one run as the schedule's owner,
   * recorded with `manual: true`. The next occurrence is unchanged.
   *
   * @wire POST /v1/schedules/:triggerId/run-now
   */
  runNow(triggerId: string, options?: MutationOptions): Promise<ScheduleFire>;

  /**
   * Become the schedule's owner, so its runs act as you from the next fire
   * (for a schedule whose owner left). Needs `admin` on its project.
   *
   * @wire POST /v1/schedules/:triggerId/owner
   */
  takeOwnership(triggerId: string, options?: MutationOptions): Promise<Schedule>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeSchedulesClient(transport: Transport): SchedulesClient {
  return {
    async register(input, options) {
      return transport.request<Schedule>({
        method: 'POST',
        path: '/v1/schedules',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<SchedulePage>({
        method: 'GET',
        path: '/v1/schedules',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.status !== undefined && { status: filter.status }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
        },
      });
    },
    async get(triggerId, options) {
      return transport.request<Schedule>({
        method: 'GET',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}`,
        ...(options?.upcoming !== undefined && { query: { upcoming: options.upcoming } }),
      });
    },
    async update(triggerId, input, options) {
      return transport.request<Schedule>({
        method: 'PATCH',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async pause(triggerId, options) {
      return transport.request<Schedule>({
        method: 'POST',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}/pause`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async resume(triggerId, options) {
      return transport.request<Schedule>({
        method: 'POST',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}/resume`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async unregister(triggerId, options) {
      return transport.request<UnregisterScheduleResult>({
        method: 'POST',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}/unregister`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async fires(triggerId, filter) {
      return transport.request<ScheduleFirePage>({
        method: 'GET',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}/fires`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async runNow(triggerId, options) {
      return transport.request<ScheduleFire>({
        method: 'POST',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}/run-now`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async takeOwnership(triggerId, options) {
      return transport.request<Schedule>({
        method: 'POST',
        path: `/v1/schedules/${encodeURIComponent(triggerId)}/owner`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
