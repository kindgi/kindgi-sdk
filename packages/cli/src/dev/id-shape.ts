// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The shape of an agent's or a flow's id: the pack's own id, a dot, and a
 * kebab-case name with no dot (`acme.order-desk` in the pack `acme`, and
 * `acme.legal.review-contract` in the pack `acme.legal`). No indexer checks
 * it, so `kindgi dev` and `kindgi build` warn about any other shape, and the
 * pack runs as it is.
 */

/** The name after the pack's id: one segment of a pack id. */
const NAME = /^[a-z][a-z0-9-]*$/;

export interface IdShapeWarning {
  readonly code: 'agent-id-shape' | 'flow-id-shape';
  readonly message: string;
  readonly filePath?: string;
}

/**
 * One warning per agent or flow id in `index` (the pack index the indexer
 * wrote) that isn't `<packId>.<name>`. An id the index lists more than once
 * (one per version) warns once.
 */
export function idShapeWarnings(packId: string, index: unknown): IdShapeWarning[] {
  if (packId === '' || !isRecord(index)) return [];
  const warnings: IdShapeWarning[] = [];
  for (const kind of ['agent', 'flow'] as const) {
    const entries = index[`${kind}s`];
    if (!Array.isArray(entries)) continue;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (hasShape(entry.id, packId)) continue;
      const filePath = typeof entry.modulePath === 'string' ? entry.modulePath : undefined;
      warnings.push({
        code: `${kind}-id-shape`,
        message: `${filePath !== undefined ? `${filePath}: ` : ''}${kind} "${entry.id}" isn't named "${packId}.<name>" (this pack's id, a dot, then a lowercase kebab-case name with no dot). An id is hard to change once something calls it, so rename it while it's new. The pack runs as it is.`,
        ...(filePath !== undefined && { filePath }),
      });
    }
  }
  return warnings;
}

function hasShape(id: string, packId: string): boolean {
  const prefix = `${packId}.`;
  return id.startsWith(prefix) && NAME.test(id.slice(prefix.length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
