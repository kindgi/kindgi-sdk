// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { JudgedEvalCase } from './eval-case-binding.js';
import type { EvalSample } from './eval-run-binding.js';

/** Where a case falls in `[0, 1)` for a seed: the same for the same seed and case, always. */
function position(seed: string, caseId: string): number {
  const hex = createHash('sha256').update(`${seed}:${caseId}`, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) / 0x1_0000_0000;
}

/** A case's stratum: whether anyone judged one of its items "no". */
function stratum(c: JudgedEvalCase): 'no' | 'yes' {
  return c.items.some((item) => item.yesWeight < item.totalWeight) ? 'no' : 'yes';
}

/**
 * The cases of a sample's part. The split is stratified by judgment: the
 * cases with a "no" and the cases without are each split on their own,
 * about `holdOutShare` of each into the hold-out part, in the order of a
 * hash of the case id and `seed` (a stratum of two or more cases puts at
 * least one in each part). The same seed and test set split the same way.
 */
export function sampleCases(
  cases: readonly JudgedEvalCase[],
  sample: EvalSample,
): JudgedEvalCase[] {
  const holdOut = new Set<string>();
  for (const s of ['no', 'yes'] as const) {
    const ordered = cases
      .filter((c) => stratum(c) === s)
      .map((c) => ({ id: c.caseId, at: position(sample.seed, c.caseId) }))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const n = ordered.length;
    const count = n < 2 ? 0 : Math.min(n - 1, Math.max(1, Math.round(n * sample.holdOutShare)));
    for (const c of ordered.slice(0, count)) holdOut.add(c.id);
  }
  return cases.filter((c) => holdOut.has(c.caseId) === (sample.part === 'hold-out'));
}
