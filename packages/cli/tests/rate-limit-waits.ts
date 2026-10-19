// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A rate-limit wait seam that never waits: its sleep moves a fake clock
 * on (by `lateMs` more than asked, for a timer that fires late), and
 * the lines it would print are kept.
 */

import type { RateLimitWaitSeam } from '../src/rate-limit-wait.js';

export interface FakeRateLimitWaits {
  readonly seam: RateLimitWaitSeam;
  /** Each wait's line, in order. */
  readonly lines: string[];
  /** Each sleep asked for, in milliseconds. */
  readonly sleeps: number[];
}

export function fakeRateLimitWaits(
  options: { readonly lateMs?: number; readonly onSleep?: () => void } = {},
): FakeRateLimitWaits {
  let clock = 1_000;
  const lines: string[] = [];
  const sleeps: number[] = [];
  return {
    lines,
    sleeps,
    seam: {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms + (options.lateMs ?? 0);
        options.onSleep?.();
      },
      write: (line) => {
        lines.push(line);
      },
    },
  };
}
