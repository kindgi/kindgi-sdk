// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a command's lines go (`kindgi build`'s, `kindgi deploy`'s): each to
 * `progress` as it comes when the CLI streams them, else kept for the
 * result's stderr (`kept`). `quiet` leaves out each `line`, never a
 * `problem`: an error or a warning is said either way.
 */
export interface ProgressLines {
  readonly line: (s: string) => void;
  /** A line that's an error or a warning: said under `quiet` too, as `kindgi dev` does. */
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

/** A line a command says, and whether it's an error or a warning: said under `--quiet` too. */
export interface SaidLine {
  readonly text: string;
  readonly problem: boolean;
}

/**
 * `lines` as a result's stderr, each ending in a newline. Under `quiet`,
 * only the errors and warnings, so a blank line that sets notes apart is
 * a note too.
 */
export function renderLines(lines: readonly SaidLine[], quiet: boolean): string {
  return lines
    .filter((l) => !quiet || l.problem)
    .map((l) => `${l.text}\n`)
    .join('');
}

/** A note: left out under `--quiet`. */
export const note = (text: string): SaidLine => ({ text, problem: false });

/** An error or a warning: said under `--quiet` too. */
export const warning = (text: string): SaidLine => ({ text, problem: true });
