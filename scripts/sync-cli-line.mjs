#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The docs, the skills and the READMEs install the CLI of their own line:
 * `npx --yes @kindgi/cli@0.4`, `uvx --from "kindgi-cli>=0.4,<0.5"`, and
 * the prose "Kindgi 0.4's CLI", from `@kindgi/cli`'s version, and "Kindgi
 * 0.4's client" from `@kindgi/sdk`'s (scripts/lib/cli-line.mjs, which
 * names the files and forms). This moves every one of those forms in
 * those files to its line, and changes nothing else in them.
 *
 * `pnpm run version-packages` runs it after `sync-docs-line.mjs`, so a
 * Version Packages pull request that changes the version moves the lines
 * itself, a pre-release to its exact build. A branch whose version moves
 * when it merges another (the merge of a release branch back to main, or
 * of one release's branch into the next) runs it too, with
 * `sync-docs-line.mjs`: a page the branch added meanwhile still names the
 * old line. A second run changes nothing. `pnpm run check:cli-line` is the
 * check: CI runs it.
 *
 * Usage: node scripts/sync-cli-line.mjs
 */

import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliLineFiles, cliLineVersions, lineOf, moveToLine, npmCliSpec } from './lib/cli-line.mjs';
import { SyncError } from './sync-python-version.mjs';

export { SyncError };

const NAME = 'sync-cli-line';
const USAGE = 'usage: node scripts/sync-cli-line.mjs';

function main(args) {
  if (args.length > 0) throw new SyncError(`unknown argument ${args[0]}; ${USAGE}`);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const versions = cliLineVersions(root, SyncError);
  const files = cliLineFiles(root);

  // Read everything before writing anything: a file that can't be moved stops the run whole.
  const moves = [];
  for (const file of files) {
    const bytes = readFileSync(join(root, file));
    const { text, moved } = moveToLine(bytes.toString('utf8'), versions);
    if (moved === 0) continue;
    if (!isUtf8(bytes)) {
      throw new SyncError(
        `${file} names another line of the CLI but isn't UTF-8 text: move it by hand`,
      );
    }
    moves.push({ file, text, moved });
  }
  const to = `${npmCliSpec(versions.cli)}, Kindgi ${lineOf(versions.sdk)}'s client`;
  for (const { file, text, moved } of moves) {
    writeFileSync(join(root, file), text);
    console.log(`${NAME}: ${file}: ${moved} form(s) → ${to}`);
  }
  const total = moves.reduce((sum, { moved }) => sum + moved, 0);
  const of = `(@kindgi/cli ${versions.cli}, @kindgi/sdk ${versions.sdk})`;
  console.log(
    total === 0
      ? `${NAME}: ${files.length} file(s) read; every form is on its line ${of}`
      : `${NAME}: ${total} form(s) in ${moves.length} of ${files.length} file(s) moved to their line ${of}`,
  );
}

// Run as a program, not imported (by its tests). Node loads the program by its
// real path, so compare real paths: a symlinked checkout still runs.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof SyncError)) throw err;
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  }
}
