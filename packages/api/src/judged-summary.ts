// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Judgments summed into what a judged item counts: per item key, the yes
 * and total weight (by judge class; an unclassified judgment counts 1),
 * the same sums for judgments recorded while their class was restricted,
 * and the reasons. A test set's cases are built this way, and so is a
 * comparison's evidence from judging a replay's own answers.
 */

import type { TenantId } from '@kindgi/types';

import type { JudgedItemSummary } from './eval-case-binding.js';
import type { Judgment, JudgmentRegistryBinding } from './judgment-binding.js';

export type ClassWeightOf = (judgeClassId: string | undefined) => Promise<number>;

/** Each class's weight, read once (an unclassified judgment counts 1; a missing class too). */
export function classWeightReader(
  judgments: Pick<JudgmentRegistryBinding, 'getClass'>,
  tenantId: TenantId,
): ClassWeightOf {
  const weights = new Map<string, number>();
  return async (judgeClassId) => {
    if (judgeClassId === undefined) return 1;
    const known = weights.get(judgeClassId);
    if (known !== undefined) return known;
    const k = await judgments.getClass({ tenantId, judgeClassId, includeUnregistered: true });
    const w = k?.weight ?? 1;
    weights.set(judgeClassId, w);
    return w;
  };
}

export async function summarizeJudgments(
  key: string,
  judgments: readonly Judgment[],
  weightOf: ClassWeightOf,
): Promise<JudgedItemSummary> {
  let yes = 0;
  let no = 0;
  let yesWeight = 0;
  let totalWeight = 0;
  // What judges a class was restricted to asserted, as it was when each judgment was recorded.
  const restricted = { yesWeight: 0, totalWeight: 0 };
  for (const j of judgments) {
    const w = await weightOf(j.judgeClassId);
    totalWeight += w;
    if (j.restricted === true) restricted.totalWeight += w;
    if (j.verdict === 'yes') {
      yes += 1;
      yesWeight += w;
      if (j.restricted === true) restricted.yesWeight += w;
    } else {
      no += 1;
    }
  }
  const first = judgments[0];
  return {
    key,
    ...(first?.item.pointer !== undefined && { pointer: first.item.pointer }),
    ...(first?.item.rank !== undefined && { rank: first.item.rank }),
    yes,
    no,
    yesWeight,
    totalWeight,
    restricted,
    reasons: judgments.flatMap((j) =>
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

/** Judgments of one run's output, summed per item key, by rank. */
export async function summarizeByItem(
  judgments: readonly Judgment[],
  weightOf: ClassWeightOf,
): Promise<JudgedItemSummary[]> {
  const byKey = new Map<string, Judgment[]>();
  for (const j of judgments) byKey.set(j.item.key, [...(byKey.get(j.item.key) ?? []), j]);
  const items: JudgedItemSummary[] = [];
  for (const [key, list] of byKey) items.push(await summarizeJudgments(key, list, weightOf));
  return items.sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
}
