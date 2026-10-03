// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId } from '@kindgi/types';

/**
 * `EventBusBinding` — caller-plugged pub/sub surface for push-based event
 * delivery. When wired, `runsRouter`'s `GET /:runId/stream` uses it
 * instead of polling the journal every 200 ms.
 *
 * The API package doesn't own event-bus persistence. Deployments plug in
 * a binding via `CreateAppInput.eventBus` (the Kindgi runtime provides a
 * Postgres-backed one). When absent, SSE endpoints fall back to journal
 * polling — no regression for callers who don't wire the binding.
 *
 * ## Semantics
 *
 * - **Per-tenant, per-channel FIFO.** `seq` monotonically increases per
 *   `(tenantId, channel)` tuple. Subscribers may catch up from a specific
 *   `sinceSeq` after reconnect.
 * - **Durable log.** Every publish is persisted before notification;
 *   subscribers can backfill from the log after connection loss. The
 *   notification is a fast-path signal; the log is the source of truth.
 * - **Tenant isolation.** The binding keeps channels per tenant and
 *   filters log reads by tenant. A correctly-implemented binding never
 *   delivers another tenant's events.
 *
 * ## Wire shape
 *
 * `EventPayload` is what subscribers receive. `publish` accepts only
 * `doc` — the binding assigns `v`, `seq`, `timestamp` and fills in
 * `channel` + `tenantId` from its arguments. Callers never build the
 * envelope directly.
 */
export interface EventBusBinding {
  /**
   * Publish `doc` to `(tenantId, channel)`. The binding assigns a
   * monotonic `seq` per `(tenantId, channel)`, persists the event to its
   * log, and notifies subscribers. Returns `{ kind: 'ok' }` after the
   * event is durable. The notification only needs to identify the new
   * entry — subscribers read large `doc` payloads from the log (a
   * Postgres NOTIFY payload, for example, is limited to 8000 bytes).
   */
  publish(tenantId: TenantId, channel: string, doc: unknown): Promise<Result<void, EventBusError>>;

  /**
   * Publish `docs` to `(tenantId, channel)` in order, as one write: the
   * same as `publish` for each, with consecutive `seq`s and one
   * notification. Optional — a publisher with a batch calls it when the
   * binding has it.
   */
  publishMany?(
    tenantId: TenantId,
    channel: string,
    docs: readonly unknown[],
  ): Promise<Result<void, EventBusError>>;

  /**
   * Subscribe to `(tenantId, channel)`. `onEvent` is invoked for each
   * published payload in `seq` order, starting from `options.sinceSeq`
   * (default: current tail — new events only). Returns a `Subscription`
   * whose `unsubscribe()` tears down the underlying listener.
   *
   * `signal.abort()` unsubscribes atomically. Callers usually pass an
   * AbortController tied to the SSE stream's lifetime.
   *
   * On connection loss the binding reconnects transparently and
   * backfills from `lastSeen + 1` — subscribers observe no gaps.
   * A binding whose push channel is unavailable may fall back to
   * polling its log without breaking the subscriber contract.
   */
  subscribe(
    tenantId: TenantId,
    channel: string,
    onEvent: (payload: EventPayload) => void,
    signal: AbortSignal,
    options?: SubscribeOptions,
  ): Promise<Result<Subscription, EventBusError>>;
}

/** Options for `subscribe`. */
export interface SubscribeOptions {
  /**
   * Deliver rows with `seq > sinceSeq` before entering push mode.
   * When omitted, the subscriber joins at the current tail (new
   * events only) — appropriate for a fresh SSE connect with no
   * `Last-Event-Id`. When present, must be a non-negative integer.
   */
  readonly sinceSeq?: number;
}

/** Envelope subscribers receive on every push. */
export interface EventPayload {
  readonly v: 1;
  readonly channel: string;
  readonly tenantId: TenantId;
  /** Monotonic sequence per `(tenantId, channel)`. Starts at 1. */
  readonly seq: number;
  /** ISO-8601 timestamp assigned at persist time. */
  readonly timestamp: string;
  /** Caller-supplied doc — the runtime shape flowing through the bus. */
  readonly doc: unknown;
}

/**
 * Handle returned from `subscribe`. Callers must `unsubscribe()` to
 * release the underlying listener. Equivalent to aborting
 * the `signal` passed at subscribe time — either releases the same
 * resources.
 */
export interface Subscription {
  /**
   * Tear down the subscription. Safe to call multiple times; idempotent
   * after the first call.
   */
  unsubscribe(): Promise<void>;
}

/** Non-transient errors from `publish` / `subscribe`. */
export interface EventBusError {
  readonly code: 'publish-failed' | 'subscribe-failed' | 'bad-input' | 'not-supported';
  readonly message: string;
  readonly cause?: unknown;
}

/** Envelope version — bumped only when the payload shape changes. */
export const CURRENT_EVENT_BUS_ENVELOPE_VERSION = 1 as const;
