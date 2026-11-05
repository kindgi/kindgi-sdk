// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  PlanLimitsBinding,
  PlanLimitsInput,
  PlanRefused,
  PlanWarning,
} from '../../src/index.js';

/** What a fake plan-limits binding answers, or `fails`: a read it needed failed. */
export type PlanAnswer =
  | PlanRefused
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly warning?: PlanWarning }
  | { readonly kind: 'fails' };

/**
 * A plan-limits binding that answers as told, and records what it was
 * asked. `order`, when given, gets `plan: admit` before the write `admit`
 * runs and `plan: admitted` after it, so a test sees which writes ran
 * inside. `check` answers `done` as ok; `busy` is only `admit`'s.
 * `answer` changes what it answers from then on.
 */
export function planLimits(
  first: PlanAnswer,
  order?: string[],
): {
  readonly binding: PlanLimitsBinding;
  readonly admitted: PlanLimitsInput[];
  readonly checked: PlanLimitsInput[];
  answer(next: PlanAnswer): void;
} {
  const admitted: PlanLimitsInput[] = [];
  const checked: PlanLimitsInput[] = [];
  let answer = first;
  return {
    admitted,
    checked,
    answer(next) {
      answer = next;
    },
    binding: {
      async admit(input, write) {
        admitted.push(input);
        if (answer.kind === 'fails') throw new Error('the count could not be read');
        if (answer.kind !== 'done') return answer;
        order?.push('plan: admit');
        try {
          const value = await write();
          return {
            kind: 'done',
            value,
            ...(answer.warning !== undefined && { warning: answer.warning }),
          };
        } finally {
          order?.push('plan: admitted');
        }
      },
      async check(input) {
        checked.push(input);
        if (answer.kind === 'fails') throw new Error('the count could not be read');
        if (answer.kind === 'busy') throw new Error('a check is never busy');
        if (answer.kind === 'refused') return answer;
        return { kind: 'ok', ...(answer.warning !== undefined && { warning: answer.warning }) };
      },
    },
  };
}
