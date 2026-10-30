// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Corrections summed into what a corrected item counts: per item key, the yes
 * and total weight (by corrector group; an unclassified correction counts 1),
 * the same sums for corrections recorded while their group was restricted,
 * the corrections' ids, and the reasons. A test set's cases are built this way, and so is a
 * comparison's evidence from correcting a replay's own answers.
 *
 * A correction says right or wrong about a run's decisions, its answer and
 * its ranked items at once; each of those is one item here, kept as cases
 * keep them (`yes` for right, `no` for wrong).
 */

import { CORRECTION_ITEM, type TenantId } from '@kindgi/types';

import type { Correction, CorrectionRegistryBinding, Verdict } from './correction-binding.js';
import type { CorrectedItemSummary } from './eval-case-binding.js';

/** What one correction says about one item. */
export interface ItemVerdict {
  readonly key: string;
  readonly pointer?: string;
  readonly rank?: number;
  readonly verdict: 'yes' | 'no';
  /** The correction's `why`, on its answer (or, without one, its decisions). */
  readonly reason?: string;
  readonly correction: Correction;
}

/** The output item a correction's `answer` is about: an agent turn's last message, or a flow run's whole output. */
export function answerKey(j: Pick<Correction, 'subject'>): 'answer' | 'output' {
  return j.subject.kind === 'agent' ? 'answer' : 'output';
}

const asCaseVerdict = (v: Verdict): 'yes' | 'no' => (v === 'right' ? 'yes' : 'no');

/**
 * A correction as items: its decisions on the reserved item, its answer on
 * the output's answer item (at `answerAt`, the answer's pointer in the run's
 * output, when the caller knows it; a flow's is `''`), and each ranked item.
 */
export function itemVerdicts(j: Correction, answerAt?: string): ItemVerdict[] {
  const out: ItemVerdict[] = [];
  const why = j.why !== undefined && { reason: j.why };
  if (j.decisions !== undefined) {
    out.push({
      key: CORRECTION_ITEM.key,
      pointer: CORRECTION_ITEM.pointer,
      verdict: asCaseVerdict(j.decisions),
      ...(j.answer === undefined && why),
      correction: j,
    });
  }
  if (j.answer !== undefined) {
    const key = answerKey(j);
    const pointer = key === 'output' ? '' : answerAt;
    out.push({
      key,
      ...(pointer !== undefined && { pointer }),
      verdict: asCaseVerdict(j.answer),
      ...why,
      correction: j,
    });
  }
  for (const i of j.items ?? []) {
    out.push({
      key: i.key,
      ...(i.pointer !== undefined && { pointer: i.pointer }),
      ...(i.rank !== undefined && { rank: i.rank }),
      verdict: asCaseVerdict(i.verdict),
      correction: j,
    });
  }
  return out;
}

export type GroupWeightOf = (correctorGroupId: string | undefined) => Promise<number>;

/** Each group's weight, read once (an unclassified correction counts 1; a missing group too). */
export function groupWeightReader(
  corrections: Pick<CorrectionRegistryBinding, 'getGroup'>,
  tenantId: TenantId,
): GroupWeightOf {
  const weights = new Map<string, number>();
  return async (correctorGroupId) => {
    if (correctorGroupId === undefined) return 1;
    const known = weights.get(correctorGroupId);
    if (known !== undefined) return known;
    const k = await corrections.getGroup({ tenantId, correctorGroupId, includeUnregistered: true });
    const w = k?.weight ?? 1;
    weights.set(correctorGroupId, w);
    return w;
  };
}

/** One item's verdicts (all with this `key`), summed. */
export async function summarizeCorrections(
  key: string,
  verdicts: readonly ItemVerdict[],
  weightOf: GroupWeightOf,
): Promise<CorrectedItemSummary> {
  let yes = 0;
  let no = 0;
  let yesWeight = 0;
  let totalWeight = 0;
  // What the people a group was restricted to asserted, as it was when each correction was recorded.
  const expert = { yesWeight: 0, totalWeight: 0, correctionIds: [] as string[] };
  for (const v of verdicts) {
    const j = v.correction;
    const w = await weightOf(j.correctorGroupId);
    totalWeight += w;
    if (j.expert === true) {
      expert.totalWeight += w;
      expert.correctionIds.push(j.id);
    }
    if (v.verdict === 'yes') {
      yes += 1;
      yesWeight += w;
      if (j.expert === true) expert.yesWeight += w;
    } else {
      no += 1;
    }
  }
  const first = verdicts[0];
  return {
    key,
    ...(first?.pointer !== undefined && { pointer: first.pointer }),
    ...(first?.rank !== undefined && { rank: first.rank }),
    yes,
    no,
    yesWeight,
    totalWeight,
    expert,
    correctionIds: verdicts.map((v) => v.correction.id),
    reasons: verdicts.flatMap((v) =>
      v.reason !== undefined
        ? [
            {
              verdict: v.verdict,
              reason: v.reason,
              ...(v.correction.correctorGroupId !== undefined && {
                correctorGroupId: v.correction.correctorGroupId,
              }),
              ...(v.correction.expert === true && { expert: true as const }),
            },
          ]
        : [],
    ),
  };
}

/** Corrections of one run's output, summed per item key, by rank (`answerAt` as for {@link itemVerdicts}). */
export async function summarizeByItem(
  corrections: readonly Correction[],
  weightOf: GroupWeightOf,
  answerAt?: string,
): Promise<CorrectedItemSummary[]> {
  const byKey = new Map<string, ItemVerdict[]>();
  for (const v of corrections.flatMap((j) => itemVerdicts(j, answerAt))) {
    byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
  }
  const items: CorrectedItemSummary[] = [];
  for (const [key, list] of byKey) items.push(await summarizeCorrections(key, list, weightOf));
  return items.sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
}
