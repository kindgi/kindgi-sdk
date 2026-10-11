// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, TenantId, Timestamp } from '@kindgi/types';

/**
 * One canonical event in the audit log. Every framework subsystem
 * emits events of this shape — authz PDP decisions, secret set /
 * rotation, run outcomes, guardrail violations, HITL decisions.
 * Compliance is a classification lens over this stream.
 *
 * Design goals:
 * - **One substrate**. No mirror wrappers, no dual writes. One table,
 *   one binding, one retention cleanup.
 * - **Kind-agnostic core columns**. Common denormalized fields
 *   (`tenantId`, `projectId`, `timestamp`, `actor`, `correlationId`,
 *   `runId`) index-covered for the standard query patterns. Kind-
 *   specific data lives in `payload` — the source of truth for the
 *   on-wire event shape.
 * - **Content-scope aware**. `projectId` is optional at emission time
 *   (some events legitimately transcend a single project — cross-
 *   tenant admin actions, for example — but most anchor to a project
 *   for query scoping).
 */
export interface AuditEvent {
  /** Caller-supplied semantic id — must be unique per tenant. */
  readonly id: string;
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. Optional so tenant-level events (e.g. admin
   * actions taken before any project exists) can land without one.
   * Events emitted inside a project carry it; queries use it for scope
   * narrowing.
   */
  readonly projectId?: ProjectId;
  /**
   * Event kind — the framework emits a known set (`authz-decision`,
   * `secret-set`, `secret-rotated`, `run-outcome`, `guardrail-
   * violation`, `hitl-decision`, …); open at the type level so pack
   * authors can extend without touching the framework schema.
   * The compliance classifier maps kinds → retention + signing +
   * export classifications.
   */
  readonly kind: string;
  readonly timestamp: Timestamp;
  /**
   * Human/agent/service subject that caused this event.
   * Convention: `<type>:<id>` — `user:u-1042`, `agent:demo.echo`,
   * `service_account:migrator`, `user:system` for framework-internal
   * actions. Present on every event.
   */
  readonly actor: string;
  /**
   * Optional secondary subject — the party the actor acted on behalf
   * of. Populated when a delegate chain matters (e.g. an agent
   * running on-behalf-of a user).
   */
  readonly onBehalfOf?: string;
  /**
   * The principal the event is about, when that isn't the actor
   * (`<type>:<id>`, as `actor`): the person whose sessions an admin
   * ended, or the person an anonymous request named (a refused sign-in).
   * Absent: the event is about its actor.
   */
  readonly subject?: string;
  readonly correlationId?: string;
  /**
   * Kernel run id when this event was emitted inside a run. Absent
   * for standalone events (secret rotations, background jobs).
   */
  readonly runId?: string;
  /** Agent id when this event was emitted from an agent turn. */
  readonly agentId?: string;
  /** Flow id when this event was emitted from a flow run. */
  readonly flowId?: string;
  /**
   * Outcome of the event when it has one; omitted for purely
   * informational events. Free-form: `'allowed' | 'denied'` for authz
   * decisions; `'succeeded' | 'failed'` for run outcomes and env /
   * secret operations; etc.
   */
  readonly outcome?: string;
  /**
   * The full event body — versioned envelope `{ v: 1, doc: ... }`
   * so future schema drift migrates on read. Every kind has its own
   * `doc` shape; the compliance classifier uses `kind` to know what
   * to expect.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Filter shape for reads. Every field is AND-combined; absent fields
 * are wildcards. Cursor pagination uses `(timestamp asc, id asc)` as
 * the keyset — same shape the storage adapter encodes as base64url.
 */
export interface AuditEventFilter {
  /**
   * Caller-supplied event id (matches `AuditEvent.id`). Combined with
   * the query's `tenantId`, it matches at most one event (ids are
   * unique per tenant) — the single-record lookup path.
   */
  readonly id?: string;
  readonly kind?: string;
  /** Match any of these kinds. An empty array matches nothing (never "no filter"). */
  readonly kinds?: readonly string[];
  readonly actor?: string;
  /** Matches `AuditEvent.onBehalfOf` exactly; events without one never match. */
  readonly onBehalfOf?: string;
  /**
   * Events about this principal: `subject` where an event has one, else
   * `actor`. Honoured by a binding with `filtersBySubject`; one without it
   * ignores this field.
   */
  readonly subject?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly flowId?: string;
  readonly correlationId?: string;
  readonly outcome?: string;
  /**
   * Match on fields of the versioned payload document: every entry
   * must satisfy `payload.doc[key] === value` (string equality). Events
   * whose payload has no `doc` object never match a non-empty filter.
   * Lets callers filter on kind-specific fields (e.g. `action` /
   * `resource` of an `authz-decision`) inside the query, so pages stay
   * full and cursors stay exact.
   */
  readonly payloadDoc?: Readonly<Record<string, string>>;
  /** ISO date-time — inclusive lower bound on `timestamp`. */
  readonly from?: string;
  /** ISO date-time — inclusive upper bound on `timestamp`. */
  readonly to?: string;
}

export interface AuditEventPage {
  readonly data: readonly AuditEvent[];
  readonly nextCursor?: string;
}
