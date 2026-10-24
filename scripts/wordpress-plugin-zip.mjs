#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The WordPress plugin as the zip WordPress installs (Plugins → Add Plugin →
 * Upload Plugin): `kindgi-<version>.zip`, holding one folder, `kindgi/`,
 * with the plugin's tracked files less its tests, and the repository's
 * LICENSE and NOTICE (Apache-2.0 asks for both with every copy).
 * `<version>` is the plugin's own (its header's `Version:`, which
 * `KINDGI_PLUGIN_VERSION` must equal), not the SDK's.
 *
 * Next to it, `kindgi-<version>.zip.sha256`, as `sha256sum` writes it:
 * `sha256sum -c kindgi-<version>.zip.sha256` checks a download.
 *
 * One commit gives one zip: the files in name order, each dated the
 * commit's time, with fixed permissions and no extra attributes (`zip -X`),
 * so a rebuild with the same `zip` has the release's checksum.
 *
 * Usage: `node scripts/wordpress-plugin-zip.mjs <out dir>` writes both and
 * prints the zip's path; `--list` prints what goes in, one path a line.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'wordpress-plugin-zip';

/** The plugin's folder in the repository. */
export const PLUGIN_DIR = 'integrations/wordpress/kindgi';
/** The folder WordPress unpacks it to, and so the zip's one folder. */
export const PLUGIN_SLUG = 'kindgi';
/** The repository's files every copy carries. */
const LICENSE_FILES = ['LICENSE', 'NOTICE'];

/** A field of the plugin's header (`Requires PHP:`), or undefined. */
export function pluginHeader(source, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t/*]*${escaped}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(source)?.[1];
}

/**
 * The plugin's version, from its main file: the header's `Version:`, which
 * `KINDGI_PLUGIN_VERSION` must equal. Throws when either is missing, they
 * differ, or it isn't `X.Y.Z` (with an optional pre-release).
 */
export function pluginVersion(source) {
  const header = pluginHeader(source, 'Version');
  if (header === undefined) throw new Error('kindgi.php has no `Version:` header');
  const constant = /define\(\s*'KINDGI_PLUGIN_VERSION'\s*,\s*'([^']*)'\s*\)/.exec(source)?.[1];
  if (constant === undefined) throw new Error('kindgi.php defines no KINDGI_PLUGIN_VERSION');
  if (constant !== header) {
    throw new Error(
      `kindgi.php's \`Version:\` header is ${header} but KINDGI_PLUGIN_VERSION is ${constant}: they must be the same`,
    );
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(header)) {
    throw new Error(`kindgi.php's version ${header} isn't X.Y.Z`);
  }
  return header;
}

/**
 * What goes in the zip, as its paths: the plugin's tracked files (paths
 * under its folder) less `tests/` and dot files, the license files, and
 * each folder they're in, so a folder comes before what's in it.
 */
export function zipEntries(tracked) {
  const files = tracked.filter(
    (path) => !path.startsWith('tests/') && !path.split('/').some((part) => part.startsWith('.')),
  );
  const clash = files.find((path) => LICENSE_FILES.includes(path));
  if (clash !== undefined) {
    throw new Error(`the plugin has its own ${clash}: the zip takes the repository's`);
  }
  const entries = new Set([`${PLUGIN_SLUG}/`]);
  for (const path of [...files, ...LICENSE_FILES]) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      entries.add(`${PLUGIN_SLUG}/${parts.slice(0, i).join('/')}/`);
    }
    entries.add(`${PLUGIN_SLUG}/${path}`);
  }
  return [...entries].sort();
}

/** The checksum file's line, as `sha256sum` writes it. */
export function checksumLine(name, bytes) {
  return `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** The plugin's tracked files, as paths under its folder. */
function trackedPluginFiles(root) {
  return git(root, ['ls-files', '-z', '--', PLUGIN_DIR])
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => path.slice(PLUGIN_DIR.length + 1));
}

/** Build the zip and its checksum in `outDir`; their paths, and the plugin's version. */
export function buildZip(root, outDir) {
  const tracked = trackedPluginFiles(root);
  const version = pluginVersion(readFileSync(join(root, PLUGIN_DIR, 'kindgi.php'), 'utf8'));
  const entries = zipEntries(tracked);
  const time = Number(git(root, ['log', '-1', '--format=%ct', 'HEAD']).trim());
  const name = `${PLUGIN_SLUG}-${version}.zip`;
  mkdirSync(outDir, { recursive: true });
  const zip = resolve(outDir, name);
  // zip adds to an archive that's there: start from none.
  rmSync(zip, { force: true });
  const stage = mkdtempSync(join(tmpdir(), 'kindgi-plugin-'));
  try {
    for (const entry of entries) {
      const at = join(stage, entry);
      if (entry.endsWith('/')) {
        mkdirSync(at, { recursive: true });
        continue;
      }
      const path = entry.slice(PLUGIN_SLUG.length + 1);
      const from = LICENSE_FILES.includes(path) ? join(root, path) : join(root, PLUGIN_DIR, path);
      writeFileSync(at, readFileSync(from));
      chmodSync(at, 0o644);
    }
    // Folders last: writing a file dates its folder.
    for (const entry of [...entries].reverse()) {
      const at = join(stage, entry);
      if (entry.endsWith('/')) chmodSync(at, 0o755);
      utimesSync(at, time, time);
    }
    // A zip keeps local times: UTC, so every machine writes the same bytes.
    execFileSync('zip', ['-X', '-q', zip, ...entries], {
      cwd: stage,
      env: { ...process.env, TZ: 'UTC' },
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const sha256 = `${zip}.sha256`;
  writeFileSync(sha256, checksumLine(name, readFileSync(zip)));
  return { version, zip, sha256, entries };
}

function main(args) {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  if (args.length === 1 && args[0] === '--list') {
    for (const entry of zipEntries(trackedPluginFiles(root))) console.log(entry);
    return;
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new Error('usage: node scripts/wordpress-plugin-zip.mjs <out dir> | --list');
  }
  console.log(buildZip(root, resolve(args[0])).zip);
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
