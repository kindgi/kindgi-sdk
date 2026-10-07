#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Python projects ship in lockstep with the npm packages.
 *
 * Every `@kindgi/*` package has one version (the Changesets fixed group in
 * `.changeset/config.json`). Each Python project in `PYTHON_PROJECTS` takes
 * that same version, spelled for PEP 440, as its `[project] version` in
 * `pyproject.toml` and in its own entry in its `uv.lock`:
 *
 *   npm             PEP 440
 *   1.2.3           1.2.3
 *   1.2.3-alpha.4   1.2.3a4
 *   1.2.3-beta.4    1.2.3b4
 *   1.2.3-rc.4      1.2.3rc4
 *
 * Any other npm version is refused: it has no PEP 440 spelling that orders
 * the same way. The version is `@kindgi/sdk`'s, and every other package in
 * its fixed group must agree.
 *
 * A published CLI writes `kindgi` within its own major.minor for a Python
 * pack; one version per release means each CLI has exactly one Python SDK
 * that goes with it.
 *
 * Writing runs `uv version <version> --no-sync` in each project that
 * differs: uv sets `[project] version` in place (nothing else in the file
 * changes) and re-locks, so writing needs uv. `pnpm run version-packages`
 * runs it after `changeset version`, so the "Version Packages" pull request
 * moves the Python projects too. `--check` only reads (no uv): CI runs it,
 * and so does the PyPI publish job before it builds, so PyPI never gets a
 * version that differs from npm's.
 *
 * Usage:
 *   node scripts/sync-python-version.mjs          write the version
 *   node scripts/sync-python-version.mjs --check  fail if a project differs (CI)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Python projects (repository-relative directories) that version with the npm packages. */
export const PYTHON_PROJECTS = ['sdks/python', 'sdks/python-cli'];

/** The package whose fixed group sets the version. */
const CANONICAL = '@kindgi/sdk';
const NAME = 'sync-python-version';
const USAGE = 'usage: node scripts/sync-python-version.mjs [--check]';

/** A refusal: its message says what's wrong and what to do; no stack trace. */
export class SyncError extends Error {}

// ---- versions --------------------------------------------------------------

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const PRERELEASE = { alpha: 'a', beta: 'b', rc: 'rc' };

/** An npm version in PEP 440's normalized spelling; refused when it has none here. */
export function toPep440(version) {
  const match = SEMVER.exec(version);
  if (match === null) {
    throw new SyncError(
      `npm version ${JSON.stringify(version)} has no PEP 440 spelling: the Python projects take X.Y.Z, or a prerelease X.Y.Z-alpha.N, -beta.N or -rc.N`,
    );
  }
  const [, major, minor, patch, tag, n] = match;
  return `${major}.${minor}.${patch}${tag === undefined ? '' : `${PRERELEASE[tag]}${n}`}`;
}

/** A Changesets fixed-group pattern as a RegExp; only `*` wildcards (one name segment). */
function patternRegExp(pattern) {
  if (!/^[\w@./~*-]+$/.test(pattern)) {
    throw new SyncError(
      `fixed-group pattern ${JSON.stringify(pattern)} in .changeset/config.json: only package names and \`*\` wildcards are supported here`,
    );
  }
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.\\^$+?()[\]{}|/]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`);
}

/**
 * The version of `@kindgi/sdk`'s fixed group, given `.changeset/config.json`
 * and the workspace's packages (`pnpm ls -r --json`). Every package in the
 * group must have it.
 */
export function fixedGroupVersion(config, packages) {
  const group = (config.fixed ?? []).find((patterns) =>
    patterns.some((pattern) => patternRegExp(pattern).test(CANONICAL)),
  );
  if (group === undefined) {
    throw new SyncError(
      `${CANONICAL} is in no fixed group in .changeset/config.json: the Python projects take that group's version`,
    );
  }
  const matchers = group.map(patternRegExp);
  const members = packages.filter(
    (pkg) => typeof pkg.name === 'string' && matchers.some((matcher) => matcher.test(pkg.name)),
  );
  const canonical = members.find((pkg) => pkg.name === CANONICAL);
  if (canonical === undefined || typeof canonical.version !== 'string') {
    throw new SyncError(`${CANONICAL} is not a workspace package with a version`);
  }
  const others = members.filter((pkg) => pkg.version !== canonical.version);
  if (others.length > 0) {
    throw new SyncError(
      [
        `the fixed group (${group.join(', ')}) doesn't share one version: ${CANONICAL} is ${canonical.version}, but`,
        ...others.map((pkg) => `  - ${pkg.name} is ${pkg.version ?? '(no version)'}`),
      ].join('\n'),
    );
  }
  return { version: canonical.version, group, members: members.length };
}

// ---- pyproject.toml and uv.lock (read only; uv writes them) -----------------

const ARRAY_TABLE = /^\s*\[\[/;
const TABLE = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;
const MULTILINE_STRING = /"""|'''/;

const occurrences = (line, delimiter) => line.split(delimiter).length - 1;

/** The table a header line opens (`[[` for an array of tables), or undefined. */
const tableHeader = (line) => (ARRAY_TABLE.test(line) ? '[[' : TABLE.exec(line)?.[1].trim());

/** The delimiter of the multi-line string a line leaves open, or undefined. */
function openedString(line) {
  const delimiter = MULTILINE_STRING.exec(line)?.[0];
  return delimiter !== undefined && occurrences(line, delimiter) % 2 === 1 ? delimiter : undefined;
}

/**
 * The lines of a pyproject.toml's `[project]` table, without comment lines
 * and the lines of multi-line strings; undefined when there's no `[project]`.
 */
function projectLines(text) {
  const lines = [];
  let table;
  let hasProject = false;
  let openString;
  for (const line of text.split('\n').map((raw) => raw.replace(/\r$/, ''))) {
    if (openString !== undefined) {
      if (occurrences(line, openString) % 2 === 1) openString = undefined;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    const header = tableHeader(line);
    if (header !== undefined) {
      table = header;
      hasProject ||= table === 'project';
      continue;
    }
    openString = openedString(line);
    if (openString === undefined && table === 'project') lines.push(line);
  }
  return hasProject ? lines : undefined;
}

/**
 * `[project] <key>` in a pyproject.toml, when it is a one-line string
 * (basic or literal). Read line by line; no `[project]` table, no such
 * line, or two of them, is refused rather than guessed.
 */
export function projectString(text, key, file) {
  const lines = projectLines(text);
  if (lines === undefined) throw new SyncError(`${file} has no [project] table`);
  const keyLine = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"\\\\]*)"|'([^']*)')\\s*(?:#.*)?$`);
  const values = lines.flatMap((line) => {
    const match = keyLine.exec(line);
    return match === null ? [] : [match[1] ?? match[2]];
  });
  if (values.length === 0) {
    const why = key === 'version' ? ': the version must be static to follow the npm packages' : '';
    throw new SyncError(`${file}: [project] has no one-line \`${key} = "…"\`${why}`);
  }
  if (values.length > 1) {
    throw new SyncError(`${file}: [project] has ${values.length} \`${key}\` lines`);
  }
  return values[0];
}

/** A project name as uv.lock spells it (PEP 503 normalized). */
const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

/** The version a uv.lock records for the project itself (`source = { editable | virtual = "." }`). */
export function lockedVersion(text, projectName, file) {
  const entries = [];
  let entry;
  for (const line of text.split('\n').map((raw) => raw.replace(/\r$/, ''))) {
    if (line === '[[package]]') {
      entry = {};
      entries.push(entry);
    } else if (/^\s*\[/.test(line)) {
      // `[package.dev-dependencies]`, `[package.metadata]`, …: past the entry's own keys.
      entry = undefined;
    } else if (entry !== undefined) {
      const match = /^(name|version|source) = (.*)$/.exec(line);
      if (match !== null) entry[match[1]] = match[2];
    }
  }
  const own = entries.filter(
    (candidate) =>
      candidate.name === JSON.stringify(normalizeName(projectName)) &&
      /^\{ (?:editable|virtual) = "\." \}$/.test(candidate.source ?? ''),
  );
  const version = own.length === 1 ? /^"([^"]*)"$/.exec(own[0].version ?? '')?.[1] : undefined;
  if (version === undefined) {
    throw new SyncError(`${file} has no version for ${projectName} itself; run \`uv lock\` there`);
  }
  return version;
}

// ---- the command -------------------------------------------------------------

function requireUv() {
  const probe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new SyncError(
      'uv is not on PATH. Writing the version runs `uv version` in each Python project, which also updates its uv.lock: install uv (https://docs.astral.sh/uv/) and run again. (`--check` needs no uv.)',
    );
  }
}

/** Where a Python project stands: its name, and its version in pyproject.toml and uv.lock. */
function readProject(root, dir) {
  const pyprojectFile = join(dir, 'pyproject.toml');
  const lockFile = join(dir, 'uv.lock');
  const pyproject = readFileSync(join(root, pyprojectFile), 'utf8');
  const name = projectString(pyproject, 'name', pyprojectFile);
  return {
    name,
    pyprojectFile,
    lockFile,
    version: projectString(pyproject, 'version', pyprojectFile),
    locked: lockedVersion(readFileSync(join(root, lockFile), 'utf8'), name, lockFile),
  };
}

/** What differs from `version` in a project, one line each. */
function differences(project, version) {
  const found = [];
  if (project.version !== version) {
    found.push(`${project.pyprojectFile}: version ${project.version}, expected ${version}`);
  }
  if (project.locked !== version) {
    found.push(`${project.lockFile}: ${project.name} ${project.locked}, expected ${version}`);
  }
  return found;
}

function writeProject(root, dir, version) {
  const before = readProject(root, dir);
  if (differences(before, version).length === 0) {
    console.log(`${NAME}: ${dir} (${before.name}) is already ${version}`);
    return;
  }
  const uv = spawnSync('uv', ['version', version, '--no-sync'], {
    cwd: join(root, dir),
    stdio: 'inherit',
  });
  if (uv.error !== undefined || uv.status !== 0) {
    throw new SyncError(`\`uv version ${version} --no-sync\` failed in ${dir}`);
  }
  const after = differences(readProject(root, dir), version);
  if (after.length > 0) {
    throw new SyncError(
      [`\`uv version ${version}\` ran in ${dir}, but:`, ...after.map((d) => `  - ${d}`)].join('\n'),
    );
  }
  console.log(`${NAME}: ${dir} (${before.name}) ${before.version} → ${version}`);
}

function main(args) {
  const check = args.includes('--check');
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) throw new SyncError(`unknown argument ${unknown[0]}; ${USAGE}`);
  if (!check) requireUv();

  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
  const workspace = JSON.parse(
    execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
  );
  const npm = fixedGroupVersion(config, workspace);
  const version = toPep440(npm.version);

  if (!check) {
    for (const dir of PYTHON_PROJECTS) writeProject(root, dir, version);
    return;
  }
  const problems = PYTHON_PROJECTS.flatMap((dir) => differences(readProject(root, dir), version));
  if (problems.length > 0) {
    throw new SyncError(
      [
        `the Python projects must have the npm packages' version, ${npm.version} (${version} for Python):`,
        ...problems.map((problem) => `  - ${problem}`),
        'Run `node scripts/sync-python-version.mjs` (needs uv); `pnpm run version-packages` runs it after `changeset version`.',
      ].join('\n'),
    );
  }
  console.log(
    `${NAME}: ${PYTHON_PROJECTS.length} Python project(s) at ${version}, in step with the ${npm.members} packages of the fixed group (${npm.group.join(', ')}) at ${npm.version}`,
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
