// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The CLI's line in the docs, the skills and the READMEs: which files carry
 * it, the forms that name it, and what each form says for a version. Shared
 * by the check (scripts/check-cli-line.mjs), the script that moves the lines
 * (scripts/sync-cli-line.mjs) and scripts/check-skill-versions.mjs, so the
 * three read the same files and forms.
 *
 * The two install forms are the CLI's own. `npmCliSpec` is the CLI's
 * `publishedCliSpec` (packages/cli/src/package-manager.ts), what a hint tells
 * a reader to download: `@kindgi/cli@0.4`, or the exact pre-release, which
 * an npm range never matches. `uvCliRequirement` is its
 * `kindgiCliRequirement` (packages/cli/src/init/dependency-specs.ts), what
 * `kindgi init` writes into a Python pack: `kindgi-cli>=0.4,<0.5`, its floor
 * naming a pre-release so installers take one. The scripts run before the
 * build, so they can't import the CLI: this file mirrors the two, and
 * cli-line.test.mjs checks the mirror against the built CLI.
 *
 * The prose that names a line, "Kindgi 0.4's CLI" and "Kindgi 0.4's
 * client", takes the version's major and minor, at a pre-release too: it
 * names the line, not the build. The CLI's forms follow
 * packages/cli/package.json, and the client's prose follows
 * packages/sdk/package.json, the version the TypeScript, Python and JVM
 * clients share.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The package whose version names the CLI's line. */
const CLI_PACKAGE = 'packages/cli/package.json';
/** The package whose version names the client's line, as scripts/sync-docs-line.mjs reads it. */
const SDK_PACKAGE = 'packages/sdk/package.json';

/** A release or pre-release version, as a package.json holds it. */
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** A version in a form: from a digit to the last letter or digit, so a sentence's full stop stays. */
const V = String.raw`\d(?:[0-9A-Za-z.-]*[0-9A-Za-z])?`;

/** `@kindgi/cli@<version>`, as `npx --yes`, `pnpm dlx` and `pnpm add -D` take it. */
const NPM_FORM = new RegExp(String.raw`@kindgi\/cli@${V}`, 'g');
/** `kindgi-cli>=<version>,<<version>`, as `uv add --dev` and `uvx --from` take it; a floor alone too. */
const UV_FORM = new RegExp(String.raw`kindgi-cli>=${V}(?:,<${V})?`, 'g');
/** "Kindgi 0.4's CLI", or "the Kindgi 0.4 CLI". */
const CLI_PROSE = /\bKindgi \d+(?:\.\d+)*((?:['’]s)? CLI)\b/g;
/** "Kindgi 0.4's client". */
const CLIENT_PROSE = /\bKindgi \d+(?:\.\d+)*((?:['’]s)? client)\b/g;

const PEP440_PRE = { alpha: 'a', beta: 'b', rc: 'rc' };

/** The line a version is on: its major and minor, `0.4` for `0.4.0` and `0.6.0-rc.1`. */
export const lineOf = (version) => version.split('.').slice(0, 2).join('.');

/** The CLI's `publishedCliSpec`: `@kindgi/cli@<major>.<minor>`, or a pre-release exactly. */
export function npmCliSpec(version) {
  const match = /^(\d+)\.(\d+)\.\d+(-\S+)?/.exec(version);
  if (match === null) return '@kindgi/cli';
  return match[3] === undefined ? `@kindgi/cli@${match[1]}.${match[2]}` : `@kindgi/cli@${version}`;
}

/** The CLI's `kindgiCliRequirement`: the line from its floor, up to the next minor (0.x) or major. */
export function uvCliRequirement(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?/.exec(version);
  if (match === null) return 'kindgi-cli';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const ceiling = major === 0 ? `0.${minor + 1}` : `${major + 1}`;
  const pre = match[4] === undefined ? undefined : PEP440_PRE[match[4]];
  const floor =
    pre === undefined
      ? major === 0
        ? `0.${minor}`
        : `${major}.${minor}`
      : `${major}.${minor}.${match[3]}${pre}${match[5]}`;
  return `kindgi-cli>=${floor},<${ceiling}`;
}

/**
 * Each form, with what it should say for `cli` (packages/cli's version) and
 * `sdk` (packages/sdk's).
 *
 * @type {readonly { pattern: RegExp, want: (cli: string, sdk: string, tail: string) => string }[]}
 */
const FORMS = [
  { pattern: NPM_FORM, want: (cli) => npmCliSpec(cli) },
  { pattern: UV_FORM, want: (cli) => uvCliRequirement(cli) },
  { pattern: CLI_PROSE, want: (cli, _sdk, tail) => `Kindgi ${lineOf(cli)}${tail}` },
  { pattern: CLIENT_PROSE, want: (_cli, sdk, tail) => `Kindgi ${lineOf(sdk)}${tail}` },
];

/**
 * The forms in `text` that aren't on the line, in order: where each is (1-based line), what it
 * says and what it should say.
 *
 * @param {string} text
 * @param {{ cli: string, sdk: string }} versions
 * @returns {{ line: number, found: string, want: string }[]}
 */
export function offLine(text, { cli, sdk }) {
  const found = [];
  for (const { pattern, want } of FORMS) {
    for (const match of text.matchAll(pattern)) {
      const wanted = want(cli, sdk, match[1] ?? '');
      if (match[0] === wanted) continue;
      found.push({ index: match.index, found: match[0], want: wanted });
    }
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, found: was, want }) => ({
      line: text.slice(0, index).split('\n').length,
      found: was,
      want,
    }));
}

/**
 * `text` with every form on the line, and how many moved.
 *
 * @param {string} text
 * @param {{ cli: string, sdk: string }} versions
 * @returns {{ text: string, moved: number }}
 */
export function moveToLine(text, { cli, sdk }) {
  let moved = 0;
  let next = text;
  for (const { pattern, want } of FORMS) {
    next = next.replace(pattern, (form, tail) => {
      const wanted = want(cli, sdk, typeof tail === 'string' ? tail : '');
      if (form === wanted) return form;
      moved += 1;
      return wanted;
    });
  }
  return { text: next, moved };
}

/**
 * `text` with each install form's versions taken out, so a move to another line, or to a
 * pre-release, is no change: `@kindgi/cli@X.Y` and `kindgi-cli>=X.Y,<X.Y`. The prose forms are
 * taken out too.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutCliLine(text) {
  return text
    .replace(NPM_FORM, '@kindgi/cli@X.Y')
    .replace(UV_FORM, (form) => (form.includes(',<') ? 'kindgi-cli>=X.Y,<X.Y' : 'kindgi-cli>=X.Y'))
    .replace(CLI_PROSE, (_form, tail) => `Kindgi X.Y${tail}`)
    .replace(CLIENT_PROSE, (_form, tail) => `Kindgi X.Y${tail}`);
}

/** The docs pages, without the release notes, which are history. */
const DOCS_PAGE = /^site\/src\/content\/docs\/(?!releases\/).+\.mdx?$/;
/** A shipped skill's files. */
const SKILL_FILE = /^packages\/sdk\/skills\/.+\.md$/;
/** A README under packages/ or sdks/, a deploy target's, or the repository's own. */
const README = /^(?:(?:packages|sdks)\/(?:[^/]+\/)+|deploy\/[^/]+\/)?README\.md$/;

/** Whether the file carries the CLI's line (a tracked, repository-relative path). */
export const followsCliLine = (file) =>
  DOCS_PAGE.test(file) || SKILL_FILE.test(file) || README.test(file);

/**
 * packages/cli's and packages/sdk's versions, which the forms follow.
 *
 * @param {string} root the repository's root
 * @param {new (message: string) => Error} Failure what a package.json without a version throws
 * @returns {{ cli: string, sdk: string }}
 */
export function cliLineVersions(root, Failure = Error) {
  const versionOf = (file) => {
    const { version } = JSON.parse(readFileSync(join(root, file), 'utf8'));
    if (typeof version !== 'string' || !VERSION.test(version)) {
      throw new Failure(`${file} has no version a line can come from`);
    }
    return version;
  };
  return { cli: versionOf(CLI_PACKAGE), sdk: versionOf(SDK_PACKAGE) };
}

/**
 * The tracked files that carry the line and are in the checkout.
 *
 * @param {string} root the repository's root
 * @returns {string[]}
 */
export function cliLineFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && followsCliLine(file) && existsSync(join(root, file)));
}
