// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a command's lines go (`kindgi build`'s, `kindgi deploy`'s): each to
 * `progress` as it comes when the CLI streams them, else kept for the
 * result's stderr (`kept`). `quiet` leaves them out; an error is said
 * either way.
 */
export interface ProgressLines {
  readonly line: (s: string) => void;
  readonly kept: () => string;
}

export function progressLines(
  progress: ((text: string) => void) | undefined,
  quiet: boolean,
): ProgressLines {
  const kept: string[] = [];
  return {
    line: (s) => {
      if (quiet) return;
      if (progress === undefined) kept.push(s);
      else progress(`${s}\n`);
    },
    kept: () => (kept.length === 0 ? '' : `${kept.join('\n')}\n`),
  };
}
