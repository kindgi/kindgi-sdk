#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The JVM SDKs ship in lockstep with the npm packages, as the Python SDK
 * does (scripts/sync-python-version.mjs).
 *
 * Every Maven module under `sdks/java` takes `@kindgi/sdk`'s version (its
 * Changesets fixed group's), spelled as npm spells it. Maven orders
 * `X.Y.Z-alpha.N` < `-beta.N` < `-rc.N` < `X.Y.Z` as npm does, numerically
 * in N (sdks/java/codegen's `VersionOrderTest` holds Maven to that), so
 * the spelling needs no translation. Any other npm version is refused.
 *
 * What moves, edited in place (no Maven, no network):
 *   - the root pom's own `<project><version>` (`sdks/java/pom.xml`);
 *   - each module's `<parent><version>`, for every module a pom lists
 *     (in `<modules>` or a profile's). No other `<version>` changes:
 *     dependencies, plugins and properties keep theirs, whatever they hold.
 *     A module declares no `<version>` of its own; it takes its parent's.
 *   - `sdks/scala/version.sbt`, when it exists: its one `ThisBuild /
 *     version := "<v>"` line (any other line stays).
 *
 * `--release` also stamps `sdks/java/CHANGELOG.md`: its `## Unreleased`
 * section becomes `## <v>` (scripts/lib/stamp-unreleased.mjs).
 * `pnpm run version-packages` runs it that way after `changeset version`,
 * so the "Version Packages" pull request moves and stamps the JVM SDKs
 * too. A plain run only moves the versions: a branch catching up with
 * main's version releases nothing. `--check` only reads: CI runs it.
 *
 * Usage:
 *   node scripts/sync-jvm-version.mjs            move the versions
 *   node scripts/sync-jvm-version.mjs --release  move them and stamp the changelog
 *   node scripts/sync-jvm-version.mjs --check    fail if anything differs (CI)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StampError, stampUnreleased, unreleasedProblems } from './lib/stamp-unreleased.mjs';
import { SyncError, fixedGroupVersion } from './sync-python-version.mjs';

export { SyncError };

/** The Maven build whose modules version with the npm packages. */
export const ROOT_POM = 'sdks/java/pom.xml';
/** The sbt build's version file, when the Scala module is there. */
export const VERSION_SBT = 'sdks/scala/version.sbt';
/** The JVM SDKs' changelog, stamped by `--release`. */
export const CHANGELOG = 'sdks/java/CHANGELOG.md';
/** A stamped section with no entries says so. */
export const NO_CHANGES = 'No JVM changes; the version moves with the npm packages.';

const NAME = 'sync-jvm-version';
const USAGE = 'usage: node scripts/sync-jvm-version.mjs [--release | --check]';
const FIX =
  'Run `node scripts/sync-jvm-version.mjs`; `pnpm run version-packages` runs it (with --release) after `changeset version`.';

// ---- versions --------------------------------------------------------------

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

/** An npm version as Maven spells it (the same); refused when Maven wouldn't order it as npm does. */
export function toMaven(version) {
  if (!SEMVER.test(version)) {
    throw new SyncError(
      `npm version ${JSON.stringify(version)} has no Maven spelling that orders the same way: the JVM SDKs take X.Y.Z, or a prerelease X.Y.Z-alpha.N, -beta.N or -rc.N`,
    );
  }
  return version;
}

/** `version.sbt`'s one line for a version. */
export const sbtLine = (version) => `ThisBuild / version := "${version}"`;

// ---- poms, read as text ----------------------------------------------------

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>/g;

/**
 * The text-only elements of a pom, by path (`project/parent/version`), with
 * where their text is: enough to read coordinates and edit one element in
 * place. Comments, CDATA and processing instructions are skipped, so a
 * `<version>` inside a comment is never one.
 *
 * @param {string} text the pom
 * @param {string} file its path, for the messages
 * @returns {{ path: string, value: string, start: number, end: number }[]}
 */
export function pomLeaves(text, file) {
  const leaves = [];
  const stack = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (text.slice(last, match.index).includes('<')) {
      throw new SyncError(`${file}: not well-formed XML near offset ${last}`);
    }
    last = match.index + match[0].length;
    const [, closing, name, selfClosing] = match;
    if (name === undefined) continue;
    if (closing === '/') {
      const open = stack.pop();
      if (open?.name !== name) {
        throw new SyncError(
          `${file}: </${name}> closes ${open === undefined ? 'nothing' : `<${open.name}>`}`,
        );
      }
      if (!open.hasChildren) {
        const path = [...stack.map((frame) => frame.name), name].join('/');
        leaves.push({
          path,
          value: text.slice(open.start, match.index),
          start: open.start,
          end: match.index,
        });
      }
    } else if (selfClosing !== '/') {
      if (stack.length > 0) stack[stack.length - 1].hasChildren = true;
      stack.push({ name, start: last, hasChildren: false });
    } else if (stack.length > 0) {
      stack[stack.length - 1].hasChildren = true;
    }
  }
  if (text.slice(last).includes('<') || stack.length > 0) {
    throw new SyncError(
      `${file}: not well-formed XML (${stack.length > 0 ? `<${stack.at(-1).name}> is never closed` : 'trailing markup'})`,
    );
  }
  return leaves;
}

/** The one leaf at `path`, trimmed; undefined when there's none, refused when there are two. */
function one(leaves, path, file) {
  const found = leaves.filter((leaf) => leaf.path === path);
  if (found.length > 1)
    throw new SyncError(`${file} has ${found.length} <${path.split('/').join('><')}> elements`);
  return found[0];
}

const text = (leaf) => leaf?.value.trim();

/**
 * The version elements this script owns, in the root pom and every module
 * under it: the root's `<project><version>`, each module's
 * `<parent><version>`. Each module's parent must be the pom that lists it.
 * A `<module>` names a directory (its `pom.xml`) or a pom file (`….xml`).
 * A pom is read once, though its parent may list it twice (in `<modules>`
 * and a profile's); a pom two parents list is refused.
 *
 * @param {(file: string) => string | undefined} read a repository file's text, or undefined
 * @returns {{ file: string, element: string, leaf: { value: string, start: number, end: number } }[]}
 */
export function versionElements(read) {
  const elements = [];
  const queue = [{ file: ROOT_POM, parent: undefined }];
  // Each pom queued so far, and the pom that listed it (none for the root).
  const listedBy = new Map([[ROOT_POM, undefined]]);
  while (queue.length > 0) {
    const { file, parent } = queue.shift();
    const pom = read(file);
    if (pom === undefined) {
      throw new SyncError(
        `${file} is missing${parent === undefined ? '' : `, but ${parent.file} lists it as a module`}`,
      );
    }
    const leaves = pomLeaves(pom, file);
    const own = one(leaves, 'project/version', file);
    const parentVersion = one(leaves, 'project/parent/version', file);
    if (parent === undefined) {
      if (own === undefined) throw new SyncError(`${file} has no <project><version>`);
      elements.push({ file, element: '<project><version>', leaf: own });
    } else {
      const coordinates = `${text(one(leaves, 'project/parent/groupId', file))}:${text(one(leaves, 'project/parent/artifactId', file))}`;
      if (parentVersion === undefined || coordinates !== parent.coordinates) {
        throw new SyncError(
          `${file}: its <parent> must be ${parent.coordinates} (${parent.file}), the pom that lists it; it is ${parentVersion === undefined ? 'missing or has no version' : coordinates}`,
        );
      }
      if (own !== undefined) {
        throw new SyncError(
          `${file} declares its own <project><version>: drop it, a module takes its parent's`,
        );
      }
      elements.push({ file, element: '<parent><version>', leaf: parentVersion });
    }
    const groupId =
      text(one(leaves, 'project/groupId', file)) ??
      text(one(leaves, 'project/parent/groupId', file));
    const coordinates = `${groupId}:${text(one(leaves, 'project/artifactId', file))}`;
    const modules = leaves.filter(
      (leaf) =>
        leaf.path === 'project/modules/module' ||
        leaf.path === 'project/profiles/profile/modules/module',
    );
    for (const module of modules) {
      const name = text(module);
      const target = posix.normalize(
        posix.join(posix.dirname(file), name.endsWith('.xml') ? name : posix.join(name, 'pom.xml')),
      );
      if (listedBy.has(target)) {
        const by = listedBy.get(target);
        if (by === file) continue;
        throw new SyncError(
          by === undefined
            ? `${file} lists ${target}, the root pom, as a module`
            : `${target} is listed as a module by both ${by} and ${file}; a module has one parent`,
        );
      }
      listedBy.set(target, file);
      queue.push({ file: target, parent: { file, coordinates } });
    }
  }
  return elements;
}

// ---- version.sbt ---------------------------------------------------------------

const SBT_VERSION = /^ThisBuild\s*\/\s*version\s*:=\s*"([^"]*)"\s*$/;

/**
 * The one `ThisBuild / version := "…"` line of a version.sbt: its index and
 * version. Other lines (a comment) are the file's own and stay.
 */
export function sbtVersion(text, file) {
  const lines = text.split('\n');
  const found = lines.flatMap((line, index) => {
    const match = SBT_VERSION.exec(line.replace(/\r$/, ''));
    return match === null ? [] : [{ index, version: match[1] }];
  });
  if (found.length !== 1) {
    throw new SyncError(
      `${file} needs one line \`ThisBuild / version := "…"\`; it has ${found.length}`,
    );
  }
  return { lines, ...found[0] };
}

// ---- the command -------------------------------------------------------------

/** What differs from `version`, one line each. */
function differences(read, version) {
  const found = versionElements(read)
    .filter(({ leaf }) => text(leaf) !== version)
    .map(({ file, element, leaf }) => `${file}: ${element} ${text(leaf)}, expected ${version}`);
  const sbt = read(VERSION_SBT);
  if (sbt !== undefined) {
    const own = sbtVersion(sbt, VERSION_SBT);
    if (own.version !== version) {
      found.push(`${VERSION_SBT}: ThisBuild / version ${own.version}, expected ${version}`);
    }
  }
  return found;
}

/** Moves every version element, and version.sbt's version line, to `version`. */
function writeVersions(root, read, version) {
  const byFile = new Map();
  for (const element of versionElements(read)) {
    if (text(element.leaf) === version) continue;
    byFile.set(element.file, [...(byFile.get(element.file) ?? []), element]);
  }
  for (const [file, elements] of byFile) {
    let pom = read(file);
    // From the end, so the earlier offsets still hold.
    for (const { element, leaf } of elements.sort((a, b) => b.leaf.start - a.leaf.start)) {
      const value = leaf.value;
      const replaced = value.replace(value.trim(), version);
      pom = pom.slice(0, leaf.start) + replaced + pom.slice(leaf.end);
      console.log(`${NAME}: ${file} ${element} ${value.trim()} → ${version}`);
    }
    writeFileSync(join(root, file), pom);
  }
  const sbt = read(VERSION_SBT);
  if (sbt !== undefined) {
    const own = sbtVersion(sbt, VERSION_SBT);
    if (own.version !== version) {
      const lines = [...own.lines];
      lines[own.index] = sbtLine(version) + (lines[own.index].endsWith('\r') ? '\r' : '');
      writeFileSync(join(root, VERSION_SBT), lines.join('\n'));
      console.log(`${NAME}: ${VERSION_SBT} ThisBuild / version ${own.version} → ${version}`);
    }
  }
}

function main(args) {
  const check = args.includes('--check');
  const release = args.includes('--release');
  const unknown = args.filter((arg) => arg !== '--check' && arg !== '--release');
  if (unknown.length > 0) throw new SyncError(`unknown argument ${unknown[0]}; ${USAGE}`);
  if (check && release) throw new SyncError(`--check only reads; --release writes. ${USAGE}`);

  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const read = (file) =>
    existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined;
  const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
  const workspace = JSON.parse(
    execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
  );
  const npm = fixedGroupVersion(config, workspace);
  const version = toMaven(npm.version);
  const changelog = read(CHANGELOG);
  if (changelog === undefined) throw new SyncError(`${CHANGELOG} is missing`);

  if (check) {
    const problems = [...differences(read, version), ...unreleasedProblems(changelog, CHANGELOG)];
    if (problems.length > 0) {
      throw new SyncError(
        [
          `the JVM SDKs must have the npm packages' version, ${npm.version}:`,
          ...problems.map((p) => `  - ${p}`),
          FIX,
        ].join('\n'),
      );
    }
    const modules = versionElements(read).length;
    console.log(
      `${NAME}: ${modules} Maven module(s)${read(VERSION_SBT) === undefined ? '' : ' and version.sbt'} at ${version}, in step with the ${npm.members} packages of the fixed group (${npm.group.join(', ')})`,
    );
    return;
  }

  // Stamp before writing anything: a changelog that can't be stamped stops the run whole.
  const stamped = release ? stampUnreleased(changelog, version, NO_CHANGES, CHANGELOG) : changelog;
  writeVersions(root, read, version);
  if (stamped !== changelog) {
    writeFileSync(join(root, CHANGELOG), stamped);
    console.log(`${NAME}: ${CHANGELOG}: "## Unreleased" → "## ${version}"`);
  }
  const after = differences(read, version);
  if (after.length > 0) {
    throw new SyncError([`wrote ${version}, but:`, ...after.map((d) => `  - ${d}`)].join('\n'));
  }
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
    if (!(err instanceof SyncError) && !(err instanceof StampError)) throw err;
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  }
}
