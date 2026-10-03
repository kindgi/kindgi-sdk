// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId } from '@kindgi/types';

/**
 * Minimal structural interface the kernel calls into after each
 * successful journal write. Deliberately narrower than
 * `@kindgi/api`'s `EventBusBinding` so the kernel can accept
 * either the API-side binding OR a plain publish-only shim without
 * a hard dependency on `@kindgi/api`.
 *
 * The full binding (with `subscribe`) is defined in
 * `packages/api/src/event-bus-binding.ts`. That type is structurally
 * assignable to this one — a caller wiring the same instance into
 * both sides just works.
 *
 * `publish` MUST NOT throw. Errors are returned in the `Result` so
 * the kernel can log-and-continue: a publish failure MUST NOT roll
 * back the journal append (that would be a correctness bug — the
 * journal is the source of truth).
 */
export interface KernelEventBusBinding {
  publish(
    tenantId: TenantId,
    channel: string,
    doc: unknown,
  ): Promise<Result<void, { readonly message: string }>>;
  /**
   * Publish `docs` to the channel, in order, as one write. The kernel
   * writes a run's journal entries in batches and publishes each batch
   * with this when the binding has it, and entry by entry with
   * `publish` otherwise. Same contract as `publish`: never throws.
   */
  publishMany?(
    tenantId: TenantId,
    channel: string,
    docs: readonly unknown[],
  ): Promise<Result<void, { readonly message: string }>>;
}

/**
 * Derived per-run channel name. Every kernel journal write publishes
 * to this channel; SSE consumers subscribe with the same shape.
 *
 * Deliberately colon-namespaced so other channels (e.g.
 * `kernel:trigger:<id>`) cannot collide with it.
 */
export function kernelRunChannel(runId: string): string {
  return `kernel:run:${runId}`;
}
