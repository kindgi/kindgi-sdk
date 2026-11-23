// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/downloads/` on the docs site: what a reader installs or deploys, with
 * no other place to fetch it from. Each file has a `.sha256` beside it, as
 * `sha256sum` writes it, so `sha256sum -c <file>.sha256` checks a download.
 *
 *   kindgi-wordpress-<version>.zip  a release's WordPress plugin, for every
 *                                  release built and the pre-release whose
 *                                  tag has `scripts/wordpress-plugin-zip.mjs`
 *                                  (run in a checkout of the tag)
 *   kindgi-latest.zip              the newest release's plugin, the same bytes,
 *                                  at an address that stays the same; its
 *                                  checksum line names it
 *   kindgi-<module>-<version>.zip  a release's Terraform module (`deploy/<module>/`)
 *                                  for every release built and the pre-release:
 *                                  one directory, `kindgi-<module>-<version>/`,
 *                                  with the tag's LICENSE and NOTICE in it
 *
 * A module's zip is read straight from the tag (`git archive` of its
 * `deploy/<module>` tree: nothing checked out), each entry dated the tag's
 * commit, in UTC: the same git gives a release the same bytes, so its
 * checksum holds from one deploy of the site to the next. A release whose
 * tag has no such module has no zip for it.
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

/** A release's WordPress plugin: `kindgi-wordpress-0.8.1.zip`. */
export function pluginZipName(version) {
  return `kindgi-wordpress-${version}.zip`;
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
 * checksum, into `dir`, with the tag's LICENSE and NOTICE beside the
 * module's files (unless the module has its own). Returns the zip's name,
 * or undefined when the tag has no such module.
 */
export function writeModuleZip(repo, { tag, version }, module, dir) {
  const tree = `${tag}:deploy/${module}`;
  if (!has(repo, tree)) return undefined;
  const name = moduleZipName(module, version);
  const time = git(repo, ['log', '-1', '--format=%ct', `${tag}^{commit}`]).trim();
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, name);
  const prefix = `${name.slice(0, -'.zip'.length)}/`;
  // The license files at the tag's root, read from the tag and dated like the
  // rest. A virtual file's path is its whole path: --prefix doesn't apply.
  const legal = ['LICENSE', 'NOTICE']
    .filter((file) => has(repo, `${tag}:${file}`) && !has(repo, `${tree}/${file}`))
    .map((file) => `--add-virtual-file=${prefix}${file}:${git(repo, ['show', `${tag}:${file}`])}`);
  // A zip keeps local times: UTC, so every machine writes the same bytes.
  execFileSync(
    'git',
    [
      'archive',
      '--format=zip',
      `--prefix=${prefix}`,
      `--mtime=@${time}`,
      ...legal,
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
 * Writes the WordPress plugin's zip as `tag` has it, as
 * `kindgi-wordpress-<version>.zip`, and its checksum, into `dir`. The tag's
 * own script builds it, in a temporary checkout of the tag, so the zip is
 * the one the release ships. Returns the zip's name, or undefined when the
 * tag has no such script.
 */
export function writePluginZip(repo, { tag, version }, dir) {
  if (!has(repo, `${tag}:${PLUGIN_SCRIPT}`)) return undefined;
  const name = pluginZipName(version);
  const work = mkdtempSync(join(tmpdir(), 'kindgi-plugin-'));
  const checkout = join(work, 'checkout');
  const built = join(work, 'built');
  try {
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', checkout, tag], { cwd: repo });
    try {
      execFileSync('node', [PLUGIN_SCRIPT, built], { cwd: checkout, stdio: 'ignore' });
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', checkout], { cwd: repo });
    }
    const zip = readdirSync(built).find((file) => file.endsWith('.zip'));
    if (zip === undefined) throw new Error(`downloads: ${PLUGIN_SCRIPT} at ${tag} wrote no zip`);
    const bytes = readFileSync(join(built, zip));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, `${name}.sha256`), checksumLine(name, bytes));
    return name;
  } finally {
    rmSync(work, { recursive: true, force: true });
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
  if (!has(repo, `${newest.tag}:${PLUGIN_SCRIPT}`)) {
    throw new Error(
      `downloads: ${newest.tag} has no ${PLUGIN_SCRIPT}, so no WordPress plugin to offer`,
    );
  }
  const names = [];
  for (const build of builds) {
    const plugin = writePluginZip(repo, build, dir);
    if (plugin !== undefined) names.push(plugin, `${plugin}.sha256`);
    for (const module of MODULES) {
      const name = writeModuleZip(repo, build, module, dir);
      if (name !== undefined) names.push(name, `${name}.sha256`);
    }
  }
  const bytes = readFileSync(join(dir, pluginZipName(newest.version)));
  writeFileSync(join(dir, LATEST_PLUGIN), bytes);
  writeFileSync(join(dir, `${LATEST_PLUGIN}.sha256`), checksumLine(LATEST_PLUGIN, bytes));
  names.push(LATEST_PLUGIN, `${LATEST_PLUGIN}.sha256`);
  return names.sort();
}
