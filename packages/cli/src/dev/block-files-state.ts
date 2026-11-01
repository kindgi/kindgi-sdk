// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi dev`'s pack service front answers a pin check with
 * (`POST /v1/blocks/uncommitted`): which files of some blocks git hasn't
 * committed, each block's file and its template files, or that the pack
 * isn't in git. A block the pack doesn't hold has no files, and with no
 * files git isn't asked: nothing is said, even outside git.
 */

import { type PackFilesState, packBlockFiles } from '@kindgi/handler-runtime';

import { type GitCall, callGit, uncommittedFiles } from '../uncommitted-files.js';

/** The front's `blockFilesState` for the pack in `packDir`, its blocks matching `pattern`. */
export function blockFilesState(
  packDir: string,
  pattern: string,
  git: GitCall = callGit,
): (ids: readonly string[]) => Promise<PackFilesState> {
  return async (ids) => {
    const files = await packBlockFiles(packDir, pattern, ids);
    if (files.length === 0) return { kind: 'git', uncommitted: [] };
    return uncommittedFiles(packDir, files, git);
  };
}
