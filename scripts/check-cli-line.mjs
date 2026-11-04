#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The check for scripts/sync-cli-line.mjs: every form that names the CLI's
 * line, or the client's, in the docs, the skills and the READMEs
 * (scripts/lib/cli-line.mjs) is on the line of this checkout's own
 * versions. A docs branch cut for a release holds that release's version,
 * so it keeps its own line, a pre-release its exact build. It names each
 * form that isn't, with what it should say, and the script that moves
 * them.
 *
 * Usage: `pnpm run check:cli-line`
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliLineFiles, cliLineVersions, offLine } from './lib/cli-line.mjs';

const NAME = 'check-cli-line';
const USAGE = 'usage: pnpm run check:cli-line';

class CheckError extends Error {}

function main(args) {
  if (args.length > 0) throw new CheckError(`unknown argument ${args[0]}; ${USAGE}`);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const versions = cliLineVersions(root, CheckError);
  const files = cliLineFiles(root);
  const of = `@kindgi/cli ${versions.cli}, @kindgi/sdk ${versions.sdk}`;

  let off = 0;
  for (const file of files) {
    for (const { line, found, want } of offLine(readFileSync(join(root, file), 'utf8'), versions)) {
      off += 1;
      console.error(`${file}:${line}: ${found}, where its line is ${want}`);
    }
  }
  if (off > 0) {
    console.error(
      `${NAME}: ${off} form(s) off the line (${of}); \`node scripts/sync-cli-line.mjs\` moves them`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`${NAME}: ${files.length} file(s) read; every form is on its line (${of})`);
}

// Run as a program, not imported. Node loads the program by its real path,
// so compare real paths: a symlinked checkout still runs.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  }
}
