// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Tuple-intent shape + enqueue hook contract — the interface between
// binding write methods and a tuple outbox.
//
// Bindings emit `TupleIntent[]` inside their write transactions; the
// binding implementation persists them atomically alongside the entity
// mutation, and a worker applies them to the FGA store. The intent
// shape is an FGA subject/relation/object triple + an optional
// idempotency key.
//

export interface TupleIntent {
  readonly operation: 'write' | 'delete';
  /** FGA subject, e.g. `user:alice` or `team:eng#member`. */
  readonly user: string;
  /** FGA relation, e.g. `admin` | `parent` | `editor`. */
  readonly relation: string;
  /** FGA object, e.g. `project:foo`. */
  readonly object: string;
  /**
   * Optional per-tenant idempotency key. If set, the outbox rejects a
   * duplicate enqueue (same tenantId + dedupKey) — safe to retry the
   * caller without producing double-tuples.
   */
  readonly dedupKey?: string;
}

/**
 * Callback that produces the tuples for an entity mutation. Bindings
 * call this INSIDE their write transaction with the freshly-inserted
 * (or freshly-resolved, for deletes) entity row's primary key. The
 * binding then enqueues the returned intents in the same transaction.
 *
 * REQUIRED on every content + config binding's write methods. An
 * optional hook would silently split the contract into "writes tuples"
 * vs. "doesn't write tuples" impls — exactly the split-brain that makes
 * PEP unreliable.
 */
export type TupleEnqueueHook = (entityRowId: string) => readonly TupleIntent[];
