// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Keeps a coding agent working in the project out of the files that hold
 * keys and tokens. `kindgi init` merges deny rules for them into the
 * project's `.claude/settings.json` (Claude Code), and into another
 * agent's ignore file when the project already has one. It never
 * overwrites: missing rules are appended, nothing is removed or reordered.
 *
 * Claude Code loads `.claude/settings.json` from the folder a session starts
 * in. In a monorepo an agent usually starts at the repository's root, where
 * the pack folder's file isn't loaded, so when the pack sits below its git
 * root the same rules, under the pack's path, go into the root's settings
 * too (measured with Claude Code 2.1.288).
 *
 * The rules stop the agent's file tools (Claude Code also refuses a plain
 * `cat` of a denied file). A program its shell runs can still read them;
 * Claude Code's sandbox (`sandbox.filesystem.denyRead`, the same paths)
 * closes that, and the docs show the tested settings. Code the agent writes still runs in the app and `kindgi dev`
 * with the person's access.
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { KINDGI_SECRETS_FILE } from '@kindgi/secrets-dotenv';

import { type PatchResult, patchIgnoreFile } from './gitignore-patcher.js';

/**
 * The files that hold keys and tokens, relative to the project root: the
 * app's env files (model keys added by hand, the app's own secrets), Kindgi's
 * own secrets file, the dev runtime's settings (its token, the database
 * URL), and a self-hosted deployment's env files.
 *
 * Not `.kindgirc.json`: it holds the dev token the agent's own `kindgi`
 * commands read to reach `kindgi dev`, and with Claude Code's sandbox on, a
 * `Read` deny rule binds the shell's commands too (measured with Claude Code
 * 2.1.288), so denying it would break every `kindgi` command the agent runs.
 * The same list serves a sandbox's `denyRead`.
 */
export const KEY_FILES: readonly string[] = [
  '.env*',
  KINDGI_SECRETS_FILE,
  '.kindgi/dev/runtime.env',
  'kindgi.env',
  'pack.env',
];

/**
 * Claude Code's permission rules for `KEY_FILES` (they cover Read, Grep and
 * Glob, and the sandbox when it's on), under `prefix`: the pack's folder
 * from the repository's root, for the root's settings. A bare `./.env*`
 * matches at any depth below where the session starts; a path with a folder
 * in it is anchored there.
 */
export function claudeReadDenyRules(prefix = ''): readonly string[] {
  return keyFilePaths(prefix).map((p) => `Read(./${p})`);
}

/** `KEY_FILES` under `prefix` (gitignore syntax: anchored once it has a folder). */
function keyFilePaths(prefix: string): readonly string[] {
  return KEY_FILES.map((p) => (prefix === '' ? p : `${prefix}/${p}`));
}

/**
 * A folder path as a literal in a gitignore-style pattern, for Claude Code's
 * rules and other agents' ignore files alike: `\`, `*`, `?`, `[` and `]`
 * escaped, and a leading `#` or `!` (a comment, a negation in an ignore
 * file). Unescaped, `apps/[legacy]/agent` is a character class and the rule
 * misses the folder (measured with Claude Code 2.1.288; escaped, it matches).
 */
export function globLiteral(path: string): string {
  return path.replace(/[\\*?[\]]/g, '\\$&').replace(/^[#!]/, '\\$&');
}

/**
 * The git repository's root at or above `dir`: the nearest folder holding a
 * `.git` (a directory, or a worktree's or submodule's file). No git binary.
 */
export async function gitRootOf(dir: string): Promise<string | undefined> {
  let current = resolve(dir);
  for (;;) {
    try {
      await stat(join(current, '.git'));
      return current;
    } catch {
      // Not here: one folder up.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Other coding agents' ignore files (gitignore syntax) that keep files from
 * the agent. Only patched when the project already has one: `kindgi init`
 * doesn't add another agent's configuration.
 */
const OTHER_AGENT_IGNORE_FILES = ['.cursorignore', '.geminiignore', '.aiderignore'] as const;

export interface ClaudeSettingsResult {
  readonly kind: 'created' | 'patched' | 'already-present' | 'error';
  /** The rules appended to `permissions.deny`. */
  readonly appended: readonly string[];
  readonly message?: string;
}

/**
 * Merge `rules` (by default `claudeReadDenyRules()`) into `permissions.deny`
 * of the settings file at `path`, creating the file when it doesn't exist. A
 * file that isn't valid JSON, or whose `permissions.deny` isn't a list, is
 * left as it is, and the message says what to add. A leading byte-order mark
 * is kept.
 */
export async function patchClaudeSettings(
  path: string,
  rules: readonly string[] = claudeReadDenyRules(),
): Promise<ClaudeSettingsResult> {
  const byHand = `add to "permissions.deny" yourself: ${rules.map((r) => JSON.stringify(r)).join(', ')}`;
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        kind: 'error',
        appended: [],
        message: `Couldn't read ${path} (${(err as Error).message}): ${byHand}.`,
      };
    }
  }
  if (raw === undefined) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({ permissions: { deny: rules } }, null, 2)}\n`,
        'utf8',
      );
    } catch (err) {
      return {
        kind: 'error',
        appended: [],
        message: `Couldn't write ${path} (${(err as Error).message}): ${byHand}.`,
      };
    }
    return { kind: 'created', appended: rules };
  }

  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  let settings: unknown;
  try {
    settings = JSON.parse(raw.slice(bom.length));
  } catch {
    return {
      kind: 'error',
      appended: [],
      message: `${path} isn't valid JSON, so it's left as it is: ${byHand}.`,
    };
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return {
      kind: 'error',
      appended: [],
      message: `${path} isn't a JSON object, so it's left as it is: ${byHand}.`,
    };
  }
  const root = settings as Record<string, unknown>;
  const permissions = root.permissions ?? {};
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return {
      kind: 'error',
      appended: [],
      message: `"permissions" in ${path} isn't an object, so it's left as it is: ${byHand}.`,
    };
  }
  const perms = permissions as Record<string, unknown>;
  const deny = perms.deny ?? [];
  if (!Array.isArray(deny)) {
    return {
      kind: 'error',
      appended: [],
      message: `"permissions.deny" in ${path} isn't a list, so it's left as it is: ${byHand}.`,
    };
  }
  const missing = rules.filter((r) => !deny.includes(r));
  if (missing.length === 0) return { kind: 'already-present', appended: [] };
  perms.deny = [...deny, ...missing];
  root.permissions = perms;
  try {
    await writeFile(path, `${bom}${JSON.stringify(root, null, indentOf(raw))}\n`, 'utf8');
  } catch (err) {
    return {
      kind: 'error',
      appended: [],
      message: `Couldn't write ${path} (${(err as Error).message}): ${byHand}.`,
    };
  }
  return { kind: 'patched', appended: missing };
}

type OtherAgentFiles = readonly { readonly file: string; readonly result: PatchResult }[];

export interface AgentAccessResult {
  /** `.claude/settings.json`. */
  readonly claude: ClaudeSettingsResult;
  /** Other agents' ignore files that exist, by file name. */
  readonly others: OtherAgentFiles;
  /**
   * Only when the pack's folder is below its git repository's root: the same
   * rules under `prefix` (the pack's folder from the root, `/`-separated) in
   * the root's `.claude/settings.json`, and in other agents' ignore files
   * that exist there.
   */
  readonly repoRoot?:
    | {
        readonly dir: string;
        readonly prefix: string;
        readonly claude: ClaudeSettingsResult;
        readonly others: OtherAgentFiles;
      }
    /**
     * The repository's root is the home folder (a dotfiles repository):
     * its `.claude/settings.json` is Claude Code's user-wide settings, so
     * nothing is written there, and init says so.
     */
    | { readonly dir: string; readonly prefix: string; readonly skipped: 'home' };
}

export interface PatchAgentAccessOptions {
  /** The home folder (the CLI's own); by default the process's. */
  readonly home?: string;
}

/** Keep the project's coding agents out of the key files (see the module comment). */
export async function patchAgentAccess(
  projectDir: string,
  options: PatchAgentAccessOptions = {},
): Promise<AgentAccessResult> {
  const claude = await patchClaudeSettings(join(projectDir, '.claude', 'settings.json'));
  const others = await patchOtherAgents(projectDir, KEY_FILES);
  const packDir = resolve(projectDir);
  const root = await gitRootOf(packDir);
  if (root === undefined || root === packDir) return { claude, others };
  const prefix = relative(root, packDir).split(sep).join('/');
  if (await samePlace(root, options.home ?? homedir())) {
    return { claude, others, repoRoot: { dir: root, prefix, skipped: 'home' } };
  }
  const literal = globLiteral(prefix);
  return {
    claude,
    others,
    repoRoot: {
      dir: root,
      prefix,
      claude: await patchClaudeSettings(
        join(root, '.claude', 'settings.json'),
        claudeReadDenyRules(literal),
      ),
      others: await patchOtherAgents(root, keyFilePaths(literal)),
    },
  };
}

/** Whether two paths are the same folder, links resolved; a path that doesn't exist is no match. */
async function samePlace(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

async function patchOtherAgents(dir: string, paths: readonly string[]): Promise<OtherAgentFiles> {
  const others: { file: string; result: PatchResult }[] = [];
  for (const file of OTHER_AGENT_IGNORE_FILES) {
    const result = await patchIgnoreFile(join(dir, file), paths, { createIfMissing: false });
    if (result.kind !== 'absent') others.push({ file, result });
  }
  return others;
}

/** Why init writes outside the pack's folder: said with every row about it. */
const REPO_ROOT_WHY = "so an agent started at the repo root can't read this pack's keys";

export interface AgentAccessRows {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  /**
   * What was written outside the pack's folder (the repository root's
   * files), one line each, with why: init prints these whatever else it
   * summarizes.
   */
  readonly outside: readonly string[];
}

/**
 * `kindgi init`'s summary rows for `patchAgentAccess`: what was created or
 * patched, what already had the rules, and warnings (a file left as it was,
 * with what to add by hand). Never a failure: init goes on either way.
 */
export function agentAccessRows(projectDir: string, result: AgentAccessResult): AgentAccessRows {
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const outside: string[] = [];
  const settings = join(projectDir, '.claude', 'settings.json');
  const { claude } = result;
  if (claude.kind === 'created') {
    created.push(
      `${settings} (your coding agent's file tools stay out of the files that hold keys)`,
    );
  } else if (claude.kind === 'patched') {
    created.push(`${settings} (patched: +${claude.appended.join(', +')})`);
  } else if (claude.kind === 'already-present') {
    skipped.push(`${settings} (the key-file deny rules already present)`);
  } else if (claude.message !== undefined) {
    warnings.push(claude.message);
  }
  for (const { file, result: r } of result.others) {
    const path = join(projectDir, file);
    if (r.kind === 'patched') created.push(`${path} (patched: +${r.appended.join(', +')})`);
    else if (r.kind === 'already-present') skipped.push(`${path} (the key files already listed)`);
    else if (r.message !== undefined) warnings.push(r.message);
  }
  const root = result.repoRoot;
  if (root !== undefined && 'skipped' in root) warnings.push(homeRootWarning(root));
  else if (root !== undefined) repoRootRows(root, { created, skipped, warnings, outside });
  return { created, skipped, warnings, outside };
}

/** Why nothing went into a repository root that is the home folder, and what to add there by hand. */
function homeRootWarning(root: { readonly dir: string; readonly prefix: string }): string {
  const rules = claudeReadDenyRules(globLiteral(root.prefix));
  return `${join(root.dir, '.claude', 'settings.json')} not written: the repo root is your home folder; add the rules yourself if you want them there: ${rules.map((r) => JSON.stringify(r)).join(', ')}.`;
}

/** `agentAccessRows`' rows for the repository root's files, each saying why init wrote outside the pack's folder. */
function repoRootRows(
  root: Exclude<NonNullable<AgentAccessResult['repoRoot']>, { readonly skipped: 'home' }>,
  rows: { created: string[]; skipped: string[]; warnings: string[]; outside: string[] },
): void {
  const { created, skipped, warnings, outside } = rows;
  const path = join(root.dir, '.claude', 'settings.json');
  const c = root.claude;
  if (c.kind === 'created' || c.kind === 'patched') {
    const n = c.appended.length;
    const line = `${path}: ${c.kind === 'created' ? 'created with' : 'added'} ${n} deny rule${n === 1 ? '' : 's'} for ${root.prefix}/, ${REPO_ROOT_WHY}`;
    created.push(line);
    outside.push(line);
  } else if (c.kind === 'already-present') {
    skipped.push(`${path} (the deny rules for ${root.prefix}/ already present)`);
  } else if (c.message !== undefined) {
    warnings.push(`${c.message} They go in the repo root's settings ${REPO_ROOT_WHY}.`);
  }
  for (const { file, result: r } of root.others) {
    const other = join(root.dir, file);
    if (r.kind === 'patched') {
      const line = `${other}: added ${r.appended.join(', ')}, ${REPO_ROOT_WHY}`;
      created.push(line);
      outside.push(line);
    } else if (r.kind === 'already-present') {
      skipped.push(`${other} (${root.prefix}/'s key files already listed)`);
    } else if (r.message !== undefined) {
      warnings.push(r.message);
    }
  }
}

/**
 * For a new pack (`kindgi init`, not augment): the files written in the
 * pack's folder, for init's list, and the lines init prints: what it wrote
 * outside the folder (`✓`), and warnings (`⚠`: a file left as it was, with
 * what to add by hand). Never a failure: `--force` over a folder whose
 * settings file isn't valid JSON scaffolds and says so.
 */
export async function writeAgentAccess(
  projectDir: string,
  options: PatchAgentAccessOptions = {},
): Promise<{ readonly files: readonly string[]; readonly lines: readonly string[] }> {
  const result = await patchAgentAccess(projectDir, options);
  const files: string[] = [];
  if (result.claude.kind === 'created' || result.claude.kind === 'patched') {
    files.push(join(projectDir, '.claude', 'settings.json'));
  }
  for (const { file, result: r } of result.others) {
    if (r.kind === 'patched') files.push(join(projectDir, file));
  }
  const rows = agentAccessRows(projectDir, result);
  return { files, lines: agentAccessLines(rows) };
}

/** The lines init prints for `rows`, whatever else it summarizes: what it wrote outside the pack's folder, and the warnings. */
export function agentAccessLines(rows: AgentAccessRows): readonly string[] {
  return [...rows.outside.map((l) => `✓ ${l}`), ...rows.warnings.map((w) => `⚠ ${w}`)];
}

/** The file's indentation, as `JSON.stringify` takes it: a tab, or a number of spaces (2 by default). */
function indentOf(raw: string): string | number {
  const m = /\n([ \t]+)"/.exec(raw);
  if (m === null) return 2;
  const ws = m[1] as string;
  return ws.startsWith('\t') ? '\t' : ws.length;
}
