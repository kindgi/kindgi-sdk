#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A skill links its release line's docs (scripts/check-refs.mjs, rule 4):
 * `https://docs.kindgi.com/v<major>.<minor>/…`, from `@kindgi/sdk`'s
 * version. So does what a package or SDK ships from its `src/`. This moves
 * every link on a line in those files (scripts/lib/docs-line.mjs, the
 * files rule 4 reads) to `@kindgi/sdk`'s line, and changes nothing else in
 * them. A link on no line, or on a patch version's (`/v0.1.10/…`), stays
 * as it is, and rule 4 still names it.
 *
 * `pnpm run version-packages` runs it after `changeset version`, so a
 * Version Packages pull request that changes the minor moves the links
 * itself. A branch whose version moves when it merges another (the merge
 * of a release branch back to main) runs it too. A second run changes
 * nothing. `pnpm run check:refs` is the check: CI runs it.
 *
 * Usage: node scripts/sync-docs-line.mjs
 */

import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LINE_LINK, docsLineOf, followsDocsLine } from './lib/docs-line.mjs';
import { SyncError } from './sync-python-version.mjs';

export { SyncError };

const NAME = 'sync-docs-line';
const USAGE = 'usage: node scripts/sync-docs-line.mjs';
/** The package whose version names the docs line, as rule 4 reads it. */
const SDK_PACKAGE = 'packages/sdk/package.json';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** `text` with each link on a line other than `line` moved to it, and how many moved. */
export function moveLinks(text, line) {
  let moved = 0;
  const next = text.replace(LINE_LINK, (link) => {
    if (link === line) return link;
    moved += 1;
    return line;
  });
  return { text: next, moved };
}

function main(args) {
  if (args.length > 0) throw new SyncError(`unknown argument ${args[0]}; ${USAGE}`);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const { version } = JSON.parse(readFileSync(join(root, SDK_PACKAGE), 'utf8'));
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new SyncError(`${SDK_PACKAGE} has no version a docs line can come from`);
  }
  const line = docsLineOf(version);
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && followsDocsLine(file) && existsSync(join(root, file)));

  // Read everything before writing anything: a file that can't be moved stops the run whole.
  const moves = [];
  for (const file of files) {
    const bytes = readFileSync(join(root, file));
    const { text, moved } = moveLinks(bytes.toString('utf8'), line);
    if (moved === 0) continue;
    if (!isUtf8(bytes)) {
      throw new SyncError(
        `${file} links docs on another line but isn't UTF-8 text: move its links by hand`,
      );
    }
    moves.push({ file, text, moved });
  }
  for (const { file, text, moved } of moves) {
    writeFileSync(join(root, file), text);
    console.log(`${NAME}: ${file}: ${moved} link(s) → ${line}`);
  }
  const total = moves.reduce((sum, { moved }) => sum + moved, 0);
  console.log(
    total === 0
      ? `${NAME}: ${files.length} file(s) read; every link on a line is on ${line} (@kindgi/sdk ${version})`
      : `${NAME}: ${total} link(s) in ${moves.length} of ${files.length} file(s) moved to ${line} (@kindgi/sdk ${version})`,
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
