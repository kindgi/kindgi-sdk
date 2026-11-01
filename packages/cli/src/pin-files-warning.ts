// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi agents pin` and `kindgi suggested-changes pin` say on
 * stderr under `kindgi dev`, where a pin writes the version into the
 * pack's files: the files it writes over that git hasn't committed, or
 * that the pack isn't in git. The pin check
 * (`POST /v1/agents/{agentId}/pinned/check`) answers that there, as
 * `uncommittedFiles` or `notInGit`, and nowhere else.
 *
 * A pin asks the check first, as best it can. Anything but an answer with
 * one of those fields says nothing, and the pin goes as before: a refusal,
 * a missing right, a runtime without the fields, a network error. Its
 * stdout, `--json` too, is the pin's answer as before.
 */

import type { PinCheck } from '@kindgi/client';

import type { OutputFormat } from './output.js';
import { renderLines, warning } from './progress-lines.js';

/** What a pin check's answer warns about. */
export type PinFiles = Pick<PinCheck, 'uncommittedFiles' | 'notInGit'>;

/** How a pin that wrote over them goes back. */
const GOING_BACK =
  'The pin keeps them as they were right before it: pin the version before to go back.';

/** The lines for `check`: none when it doesn't warn. */
export function pinFilesLines(check: PinFiles): readonly string[] {
  if (check.notInGit === true) {
    return [
      `The pack isn't in git, so git can't bring back the files the pin writes over. ${GOING_BACK}`,
    ];
  }
  const files = check.uncommittedFiles ?? [];
  if (files.length === 0) return [];
  return [
    `git hasn't committed these files, so the pin writes over changes git can't bring back: ${files.join(', ')}. ${GOING_BACK}`,
  ];
}

/** The lines for what `ask` answers, or none when it fails. */
export async function askPinFiles(ask: () => Promise<PinFiles>): Promise<readonly string[]> {
  try {
    return pinFilesLines(await ask());
  } catch {
    return [];
  }
}

/** `lines` as stderr: warnings, said under `--quiet` too. */
export function pinFilesStderr(lines: readonly string[], format: OutputFormat): string {
  return renderLines(lines.map(warning), format === 'quiet');
}
