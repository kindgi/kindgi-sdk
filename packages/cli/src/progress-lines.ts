// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a command's lines go (`kindgi build`'s, `kindgi deploy`'s): each to
 * `progress` as it comes when the CLI streams them, else kept for the
 * result's stderr (`kept`). `quiet` leaves out each `line`, never a
 * `problem`; an error is said either way.
 */
export interface ProgressLines {
  readonly line: (s: string) => void;
  /** A line that's an error: said under `quiet` too, as `kindgi dev` does. */
  readonly problem: (s: string) => void;
  readonly kept: () => string;
}

export function progressLines(
  progress: ((text: string) => void) | undefined,
  quiet: boolean,
): ProgressLines {
  const kept: string[] = [];
  const say = (s: string): void => {
    if (progress === undefined) kept.push(s);
    else progress(`${s}\n`);
  };
  return {
    line: (s) => {
      if (!quiet) say(s);
    },
    problem: say,
    kept: () => (kept.length === 0 ? '' : `${kept.join('\n')}\n`),
  };
}
