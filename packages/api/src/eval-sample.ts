// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { EvalSample } from './eval-run-binding.js';

/** Where a case falls in `[0, 1)` for a seed: the same for the same seed and case, always. */
function position(seed: string, caseId: string): number {
  const hex = createHash('sha256').update(`${seed}:${caseId}`, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) / 0x1_0000_0000;
}

/** Whether a case is in the sample's part: hold-out below `holdOutShare`, search above. */
export function inSample(caseId: string, sample: EvalSample): boolean {
  const holdOut = position(sample.seed, caseId) < sample.holdOutShare;
  return sample.part === 'hold-out' ? holdOut : !holdOut;
}
