// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  KeyProvider,
  Provenance,
  ProvenanceBuilder,
  ProvenanceEmitBinding,
  ProvenanceEmitContext,
} from '@kindgi/provenance';
import { signProvenance } from '@kindgi/provenance';
import type { Result } from '@kindgi/types';

import type { PersistenceError } from './errors.js';

/**
 * Bindings the provenance emission flow consumes. All optional — if
 * `newBuilder` isn't set, provenance is skipped entirely.
 */
export interface ProvenanceBindings {
  /**
   * Factory the runtime calls at turn start to construct a fresh
   * builder. Callers supply this so they control id + flowRef +
   * schema version.
   */
  readonly newBuilder?: (opts: {
    readonly runId: string;
    readonly tenantId: string;
  }) => ProvenanceBuilder;
  /**
   * When true, the DAG persists via `emitBinding.emit(...)` after a
   * successful turn. Failed turns still build the DAG but don't emit —
   * the caller sees them via the streaming event stream.
   */
  readonly emit?: boolean;
  /**
   * Caller-plugged emit surface. Required whenever `emit` is true.
   * The Kindgi runtime supplies a Postgres-backed implementation;
   * any conforming object works.
   */
  readonly emitBinding?: ProvenanceEmitBinding;
  /**
   * When set, `signProvenance` is called with this key provider before
   * emit. Unsigned DAGs still emit but forensic verification can't
   * chain back to a keyId.
   */
  readonly keyProvider?: KeyProvider;
}

/**
 * Persist a completed provenance DAG. Signs first if a key provider is
 * bound. Failures surface as `persistence-error`; upstream turn logic
 * decides how much to bail out — usually the turn already succeeded so
 * this is best-effort.
 */
export async function persistProvenance(
  builder: ProvenanceBuilder,
  bindings: ProvenanceBindings,
  /** Stored beside the record (the turn's project); see `ProvenanceEmitContext`. */
  context?: ProvenanceEmitContext,
): Promise<Result<Provenance, PersistenceError>> {
  let provenance: Provenance = builder.snapshot();
  if (bindings.keyProvider !== undefined) {
    const signed = signProvenance(provenance, bindings.keyProvider);
    if (signed.kind === 'err') {
      return {
        kind: 'err',
        error: {
          code: 'persistence-error',
          message: `Failed to sign provenance: ${signed.error.message}`,
          cause: signed.error,
        },
      };
    }
    provenance = signed.value;
  }

  if (bindings.emit === true) {
    if (bindings.emitBinding === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'persistence-error',
          message:
            'Provenance emit=true but no emitBinding wired — pass a ProvenanceEmitBinding as bindings.provenance.emitBinding.',
          cause: null,
        },
      };
    }
    const emitted = await bindings.emitBinding.emit(provenance, context);
    if (emitted.kind === 'err') {
      return {
        kind: 'err',
        error: {
          code: 'persistence-error',
          message: `Failed to emit provenance: ${emitted.error.message}`,
          cause: emitted.error,
        },
      };
    }
  }
  return { kind: 'ok', value: provenance };
}
