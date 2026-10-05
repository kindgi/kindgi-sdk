// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, Result } from '@kindgi/types';

import type { PersistenceError } from './errors.js';
import type { Provenance } from './types.js';

/**
 * Caller-plugged emit surface for signed provenance DAGs. Callers (the
 * agent runtime, run-lifecycle hooks) never touch a database client
 * directly — they call `binding.emit(provenance)` and the binding
 * implementation performs the write.
 *
 * The Kindgi runtime supplies a Postgres-backed implementation; pass a
 * bespoke one to back an alternative store.
 */
/**
 * What the emitter knows about a record that the record itself doesn't
 * carry. The provenance document is signed, so this travels beside it,
 * not inside it.
 */
export interface ProvenanceEmitContext {
  /** The project of the record's run: provenance lists filter by it. */
  readonly projectId?: ProjectId;
}

export interface ProvenanceEmitBinding {
  /**
   * Persist a signed provenance DAG. Idempotent on `(tenantId, id)` — a
   * repeated call with the same id is a no-op after commit.
   *
   * Fire-and-forget from the caller's perspective: the caller usually
   * ignores the result (the run has already succeeded/failed regardless),
   * but the Result surface preserves the failure path for tests +
   * diagnostic tooling.
   */
  emit(
    provenance: Provenance,
    context?: ProvenanceEmitContext,
  ): Promise<Result<void, PersistenceError>>;
}
