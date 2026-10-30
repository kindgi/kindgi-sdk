// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Corrections summed into what a corrected item counts: per item key, the yes
 * and total weight (by judge class; an unclassified correction counts 1),
 * the same sums for corrections recorded while their class was restricted,
 * the corrections' ids, and the reasons. A test set's cases are built this way, and so is a
 * comparison's evidence from correcting a replay's own answers.
 */

import type { TenantId } from '@kindgi/types';

import type { Correction, CorrectionRegistryBinding } from './correction-binding.js';
import type { CorrectedItemSummary } from './eval-case-binding.js';

export type ClassWeightOf = (judgeClassId: string | undefined) => Promise<number>;

/** Each class's weight, read once (an unclassified correction counts 1; a missing class too). */
export function classWeightReader(
  corrections: Pick<CorrectionRegistryBinding, 'getClass'>,
  tenantId: TenantId,
): ClassWeightOf {
  const weights = new Map<string, number>();
  return async (judgeClassId) => {
    if (judgeClassId === undefined) return 1;
    const known = weights.get(judgeClassId);
    if (known !== undefined) return known;
    const k = await corrections.getClass({ tenantId, judgeClassId, includeUnregistered: true });
    const w = k?.weight ?? 1;
    weights.set(judgeClassId, w);
    return w;
  };
}

export async function summarizeCorrections(
  key: string,
  corrections: readonly Correction[],
  weightOf: ClassWeightOf,
): Promise<CorrectedItemSummary> {
  let yes = 0;
  let no = 0;
  let yesWeight = 0;
  let totalWeight = 0;
  // What the people a class was restricted to asserted, as it was when each correction was recorded.
  const restricted = { yesWeight: 0, totalWeight: 0, correctionIds: [] as string[] };
  for (const j of corrections) {
    const w = await weightOf(j.judgeClassId);
    totalWeight += w;
    if (j.restricted === true) {
      restricted.totalWeight += w;
      restricted.correctionIds.push(j.id);
    }
    if (j.verdict === 'yes') {
      yes += 1;
      yesWeight += w;
      if (j.restricted === true) restricted.yesWeight += w;
    } else {
      no += 1;
    }
  }
  const first = corrections[0];
  return {
    key,
    ...(first?.item.pointer !== undefined && { pointer: first.item.pointer }),
    ...(first?.item.rank !== undefined && { rank: first.item.rank }),
    yes,
    no,
    yesWeight,
    totalWeight,
    restricted,
    correctionIds: corrections.map((j) => j.id),
    reasons: corrections.flatMap((j) =>
      j.reason !== undefined
        ? [
            {
              verdict: j.verdict,
              reason: j.reason,
              ...(j.judgeClassId !== undefined && { judgeClassId: j.judgeClassId }),
              ...(j.restricted === true && { restricted: true as const }),
            },
          ]
        : [],
    ),
  };
}

/** Corrections of one run's output, summed per item key, by rank. */
export async function summarizeByItem(
  corrections: readonly Correction[],
  weightOf: ClassWeightOf,
): Promise<CorrectedItemSummary[]> {
  const byKey = new Map<string, Correction[]>();
  for (const j of corrections) byKey.set(j.item.key, [...(byKey.get(j.item.key) ?? []), j]);
  const items: CorrectedItemSummary[] = [];
  for (const [key, list] of byKey) items.push(await summarizeCorrections(key, list, weightOf));
  return items.sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
}
