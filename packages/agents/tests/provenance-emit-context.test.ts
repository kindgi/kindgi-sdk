// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn's provenance record is emitted with the turn's project beside it
 * (`ProvenanceEmitContext`), not inside the signed document.
 */

import { describe, expect, test } from 'vitest';

import type { Provenance, ProvenanceBuilder, ProvenanceEmitContext } from '@kindgi/provenance';
import type { ProjectId } from '@kindgi/types';

import { persistProvenance } from '../src/provenance-emit.js';

const document = { id: 'prov-1', runId: 'run-1', nodes: [], edges: [] } as unknown as Provenance;
const builder = { snapshot: () => document } as unknown as ProvenanceBuilder;

function emitter() {
  const emitted: { provenance: Provenance; context?: ProvenanceEmitContext }[] = [];
  return {
    emitted,
    bindings: {
      emit: true,
      emitBinding: {
        emit: async (provenance: Provenance, context?: ProvenanceEmitContext) => {
          emitted.push({ provenance, ...(context !== undefined && { context }) });
          return { kind: 'ok' as const, value: undefined };
        },
      },
    },
  };
}

describe('persistProvenance', () => {
  test("emits the record with the turn's project beside it", async () => {
    const { emitted, bindings } = emitter();
    const projectId = 'p-1' as ProjectId;
    const persisted = await persistProvenance(builder, bindings, { projectId });
    expect(persisted.kind).toBe('ok');
    expect(emitted).toEqual([{ provenance: document, context: { projectId } }]);
    // The document itself is unchanged: the project isn't signed into it.
    expect(emitted[0]?.provenance).not.toHaveProperty('projectId');
  });

  test('without a context, the record is emitted alone', async () => {
    const { emitted, bindings } = emitter();
    await persistProvenance(builder, bindings);
    expect(emitted).toEqual([{ provenance: document }]);
  });
});
