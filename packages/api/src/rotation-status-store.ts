// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type { Scope } from '@kindgi/platform';
import type { EnvName } from '@kindgi/types';

/**
 * Rotation-status store — durable substrate for the
 * async-rotation wire. When a
 * `SecretProviderBinding.rotateSecret` call returns the
 * `rotation-pending` variant, the HTTP route mints a `rotationId` via
 * this store, records the pending status, and returns 202 with a
 * `statusUrl` + `eventsUrl` a caller can poll or subscribe to.
 *
 * A background reaper (not owned by this store) drives the pending
 * rotation to terminal by polling the provider with the recorded
 * `resumeToken`, then calling `update({ status: 'succeeded' | 'failed',
 *  … })`. Subscribed SSE streams receive the update via `subscribe`.
 *
 * The bundled implementation (`createInMemoryRotationStatusStore`) is
 * in-memory only (dev + tests). Production deployments plug in a durable
 * adapter that survives process restarts — an async rotation can take
 * minutes to hours, so process-local state is not sufficient.
 */
export interface RotationStatusStore {
  /**
   * Mint a new rotation-status row. Returns the freshly-minted
   * `rotationId` (UUID) that the wire response echoes back to the
   * caller. `resumeToken` + `provider` are the opaque provider-side
   * handles the reaper uses to poll the async workflow; the wire
   * response NEVER exposes them.
   */
  create(input: RotationStatusCreateInput): Promise<{ readonly rotationId: string }>;

  /** Read the current status, or `null` when unknown / cross-scope. */
  get(input: RotationStatusGetInput): Promise<RotationStatus | null>;

  /**
   * Terminal-transition write. Called by the reaper (or an explicit
   * admin op) when the async workflow completes. Publishes to every
   * live SSE subscription for the `rotationId`.
   */
  update(input: RotationStatusUpdateInput): Promise<void>;

  /**
   * Subscribe to lifecycle updates for a single `rotationId`. Returns
   * an unsubscribe function that the caller MUST call on stream close
   * / client disconnect to avoid memory leaks.
   */
  subscribe(input: RotationStatusSubscribeInput): () => void;
}

export interface RotationStatusCreateInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly provider: string;
  readonly resumeToken: string;
}

export interface RotationStatusGetInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly rotationId: string;
}

export interface RotationStatusUpdateInput {
  readonly rotationId: string;
  readonly status: 'succeeded' | 'failed';
  readonly newVersionId?: number;
  readonly oldVersionId?: number;
  readonly error?: string;
}

export interface RotationStatusSubscribeInput {
  readonly rotationId: string;
  readonly onUpdate: (status: RotationStatus) => void;
}

/**
 * Wire-safe rotation-status shape. `startedAt` + `updatedAt` are ISO
 * 8601 strings. Terminal states populate `newVersionId` /
 * `oldVersionId` (on `succeeded`) or `error` (on `failed`); pending
 * states leave them absent.
 */
export interface RotationStatus {
  readonly rotationId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly newVersionId?: number;
  readonly oldVersionId?: number;
  readonly error?: string;
}

/**
 * In-memory reference `RotationStatusStore` — dev + tests only.
 * Retains a `Map<rotationId, InternalRow>` for the lifetime of the
 * process; multi-pod deployments MUST plug in a durable adapter (the
 * rotation-status row must survive between the pod that minted the
 * `rotationId` and any pod handling a poll or SSE subscribe).
 */
export function createInMemoryRotationStatusStore(options?: {
  readonly now?: () => number;
}): RotationStatusStore {
  interface Row {
    readonly rotationId: string;
    readonly scopeKey: string;
    readonly envName: EnvName;
    readonly name: string;
    readonly provider: string;
    readonly resumeToken: string;
    status: 'pending' | 'succeeded' | 'failed';
    readonly startedAt: string;
    updatedAt: string;
    newVersionId?: number;
    oldVersionId?: number;
    error?: string;
  }

  const rows = new Map<string, Row>();
  const subscribers = new Map<string, Set<(s: RotationStatus) => void>>();
  const now = options?.now ?? (() => Date.now());

  const toStatus = (row: Row): RotationStatus => ({
    rotationId: row.rotationId,
    status: row.status,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    ...(row.newVersionId !== undefined && { newVersionId: row.newVersionId }),
    ...(row.oldVersionId !== undefined && { oldVersionId: row.oldVersionId }),
    ...(row.error !== undefined && { error: row.error }),
  });

  return {
    async create(input) {
      const rotationId = randomUUID();
      const ts = new Date(now()).toISOString();
      rows.set(rotationId, {
        rotationId,
        scopeKey: scopeKey(input.scope),
        envName: input.envName,
        name: input.name,
        provider: input.provider,
        resumeToken: input.resumeToken,
        status: 'pending',
        startedAt: ts,
        updatedAt: ts,
      });
      return { rotationId };
    },
    async get(input) {
      const row = rows.get(input.rotationId);
      if (row === undefined) return null;
      // Cross-scope + cross-name reads return null — a caller looking
      // for the rotation of secret X in project A cannot inadvertently
      // observe the rotation of secret Y in project B.
      if (row.scopeKey !== scopeKey(input.scope)) return null;
      if (row.envName !== input.envName) return null;
      if (row.name !== input.name) return null;
      return toStatus(row);
    },
    async update(input) {
      const row = rows.get(input.rotationId);
      if (row === undefined) return;
      row.status = input.status;
      row.updatedAt = new Date(now()).toISOString();
      if (input.newVersionId !== undefined) row.newVersionId = input.newVersionId;
      if (input.oldVersionId !== undefined) row.oldVersionId = input.oldVersionId;
      if (input.error !== undefined) row.error = input.error;
      const status = toStatus(row);
      const subs = subscribers.get(input.rotationId);
      if (subs !== undefined) {
        for (const cb of subs) {
          try {
            cb(status);
          } catch {
            // Subscriber-side crashes MUST NOT poison the store.
          }
        }
      }
    },
    subscribe(input) {
      const set = subscribers.get(input.rotationId) ?? new Set<(s: RotationStatus) => void>();
      set.add(input.onUpdate);
      subscribers.set(input.rotationId, set);
      return () => {
        const cur = subscribers.get(input.rotationId);
        if (cur === undefined) return;
        cur.delete(input.onUpdate);
        if (cur.size === 0) subscribers.delete(input.rotationId);
      };
    },
  };
}

function scopeKey(s: Scope): string {
  switch (s.kind) {
    case 'tenant':
      return `tenant:${s.tenantId as unknown as string}`;
    case 'org':
      return `org:${s.tenantId as unknown as string}:${s.orgId as unknown as string}`;
    case 'project':
      return `project:${s.tenantId as unknown as string}:${s.projectId as unknown as string}`;
  }
}
