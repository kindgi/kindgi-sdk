// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/downloads/` on the docs site: what a reader installs or deploys, with
 * no other place to fetch it from. Each file has a `.sha256` beside it, as
 * `sha256sum` writes it, so `sha256sum -c <file>.sha256` checks a download.
 *
 *   kindgi-<plugin version>.zip    the WordPress plugin, as the newest release
 *                                  has it (`scripts/wordpress-plugin-zip.mjs`,
 *                                  run in a checkout of the release's tag)
 *   kindgi-latest.zip              the same bytes, at an address that stays
 *                                  the same; its checksum line names it
 *   kindgi-<module>-<version>.zip  a release's Terraform module (`deploy/<module>/`)
 *                                  for every release built and the pre-release:
 *                                  one directory, `kindgi-<module>-<version>/`
 *
 * A module's zip is read straight from the tag (`git archive` of its
 * `deploy/<module>` tree: nothing checked out), each entry dated the tag's
 * commit, in UTC: a release always gives the same bytes, so its checksum
 * holds from one deploy of the site to the next. A release whose tag has no
 * such module has no zip for it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The Terraform modules, as their directories under `deploy/`. */
export const MODULES = ['gcp-cloud-run', 'azure-container-apps'];
/** The newest release's WordPress plugin, under a name that doesn't change. */
export const LATEST_PLUGIN = 'kindgi-latest.zip';
const PLUGIN_SCRIPT = 'scripts/wordpress-plugin-zip.mjs';

/** A module's zip, for a release: `kindgi-gcp-cloud-run-0.8.1.zip`. */
export function moduleZipName(module, version) {
  return `kindgi-${module}-${version}.zip`;
}

/** The checksum file's line, as `sha256sum` writes it. */
export function checksumLine(name, bytes) {
  return `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`;
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

const has = (repo, object) =>
  spawnSync('git', ['cat-file', '-e', object], { cwd: repo }).status === 0;

/**
 * Writes `<tag>:deploy/<module>` as `kindgi-<module>-<version>.zip`, and its
 * checksum, into `dir`. Returns the zip's name, or undefined when the tag
 * has no such module.
 */
export function writeModuleZip(repo, { tag, version }, module, dir) {
  const tree = `${tag}:deploy/${module}`;
  if (!has(repo, tree)) return undefined;
  const name = moduleZipName(module, version);
  const time = git(repo, ['log', '-1', '--format=%ct', `${tag}^{commit}`]).trim();
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, name);
  // A zip keeps local times: UTC, so every machine writes the same bytes.
  execFileSync(
    'git',
    [
      'archive',
      '--format=zip',
      `--prefix=${name.slice(0, -'.zip'.length)}/`,
      `--mtime=@${time}`,
      '-o',
      zip,
      tree,
    ],
    { cwd: repo, env: { ...process.env, TZ: 'UTC' } },
  );
  writeFileSync(`${zip}.sha256`, checksumLine(name, readFileSync(zip)));
  return name;
}

/**
 * Writes the WordPress plugin's zip as `tag` has it, and its checksum, into
 * `dir`, with `kindgi-latest.zip` (and its checksum) the same bytes. The
 * tag's own script builds it, in a temporary checkout of the tag, so the
 * zip is the one the release ships. Returns the names written.
 */
export function writePluginZips(repo, tag, dir) {
  if (!has(repo, `${tag}:${PLUGIN_SCRIPT}`)) {
    throw new Error(`downloads: ${tag} has no ${PLUGIN_SCRIPT}, so no WordPress plugin to offer`);
  }
  const checkout = mkdtempSync(join(tmpdir(), 'kindgi-downloads-'));
  const built = mkdtempSync(join(tmpdir(), 'kindgi-plugin-'));
  execFileSync('git', ['worktree', 'add', '--quiet', '--detach', checkout, tag], { cwd: repo });
  try {
    execFileSync('node', [PLUGIN_SCRIPT, built], { cwd: checkout, stdio: 'ignore' });
    mkdirSync(dir, { recursive: true });
    const names = readdirSync(built).sort();
    for (const name of names) writeFileSync(join(dir, name), readFileSync(join(built, name)));
    const zip = names.find((name) => name.endsWith('.zip'));
    if (zip === undefined) throw new Error(`downloads: ${PLUGIN_SCRIPT} at ${tag} wrote no zip`);
    const bytes = readFileSync(join(dir, zip));
    writeFileSync(join(dir, LATEST_PLUGIN), bytes);
    writeFileSync(join(dir, `${LATEST_PLUGIN}.sha256`), checksumLine(LATEST_PLUGIN, bytes));
    return [...names, LATEST_PLUGIN, `${LATEST_PLUGIN}.sha256`];
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', checkout], { cwd: repo });
    rmSync(built, { recursive: true, force: true });
  }
}

/**
 * Writes `/downloads/` into `dir` (see the module comment). Returns the
 * names written, sorted.
 *
 * @param {string} repo the repository, with the tags
 * @param {{ tag: string, version: string }[]} builds the releases, newest
 *   first, then the pre-release if there is one
 * @param {string} dir where to write them (`<out>/downloads`)
 */
export function writeDownloads(repo, builds, dir) {
  const [newest] = builds;
  if (newest === undefined) throw new Error('downloads: no release to take them from');
  const names = writePluginZips(repo, newest.tag, dir);
  for (const build of builds) {
    for (const module of MODULES) {
      const name = writeModuleZip(repo, build, module, dir);
      if (name !== undefined) names.push(name, `${name}.sha256`);
    }
  }
  return names.sort();
}
