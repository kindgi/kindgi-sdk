// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeHandler } from '@kindgi/handler';

import { persistProvenance } from '../provenance-emit.js';

import type { TurnContext } from './context.js';

/**
 * Persist the completed provenance DAG. Best-effort: a persistence
 * failure here does NOT fail the run (the turn already succeeded and
 * the DAG was built in memory); the result then carries no
 * `provenance`.
 *
 * Skipped entirely when no provenance builder was wired.
 */
export function buildPersistProvenanceHandler(ctx: TurnContext): NodeHandler {
  return async (_input, kctx) => {
    if (ctx.provenance === undefined || ctx.provenanceBindings === undefined) {
      return { persisted: false };
    }
    if (kctx.dryRun) {
      // Dry-run: DAG was built in-memory; skip the write. The
      // returned `AgentTurnResult.provenance` is left undefined
      // (unpersisted provenance is not surfaced on the result —
      // callers can inspect the in-memory builder via bindings if they
      // want).
      return { persisted: false };
    }
    const persisted = await persistProvenance(ctx.provenance, ctx.provenanceBindings, {
      projectId: ctx.input.projectId,
    });
    if (persisted.kind === 'ok') {
      ctx.persistedProvenance = persisted.value;
      return { persisted: true };
    }
    // Silently swallow — persistence is best-effort (see above).
    return { persisted: false };
  };
}
