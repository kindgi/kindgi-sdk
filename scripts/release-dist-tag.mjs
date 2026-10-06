#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The npm dist-tag the release publishes under: `next` for a pre-release
 * (`X.Y.Z-rc.N`, `-beta.N`, `-alpha.N`), `latest` for a release.
 *
 * `latest` is what every install without a version resolves to, so a
 * release candidate never moves it; and npm refuses to publish a
 * pre-release without a tag. The release job passes this to
 * `pnpm -r publish --tag`, then checks the registry's `latest` is still a
 * release.
 *
 * Usage: `node scripts/release-dist-tag.mjs` prints the tag for the
 * `@kindgi/*` fixed group's version.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixedGroupVersion, toPep440 } from './sync-python-version.mjs';

const NAME = 'release-dist-tag';

/** `next` for a pre-release, `latest` for a release; throws on a version the Python projects can't take either. */
export function distTagFor(version) {
  // The same spellings the lockstep Python release accepts (it throws otherwise).
  toPep440(version);
  return version.includes('-') ? 'next' : 'latest';
}

function main(args) {
  if (args.length > 0) throw new Error('usage: node scripts/release-dist-tag.mjs');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
  const workspace = JSON.parse(
    execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
  );
  const { version } = fixedGroupVersion(config, workspace);
  console.log(distTagFor(version));
}

// Run as a program, not imported (by its tests).
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  }
}
