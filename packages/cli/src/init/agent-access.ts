// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Keeps a coding agent working in the project out of the files that hold
 * keys and tokens. `kindgi init` merges deny rules for them into the
 * project's `.claude/settings.json` (Claude Code), and into another
 * agent's ignore file when the project already has one. It never
 * overwrites: missing rules are appended, nothing is removed or reordered.
 *
 * The rules stop the agent's file tools (Claude Code also refuses a plain
 * `cat` of a denied file). A program its shell runs can still read them;
 * Claude Code's sandbox (`sandbox.filesystem.denyRead`, the same paths)
 * closes that, and the docs show the tested settings. Code the agent writes still runs in the app and `kindgi dev`
 * with the person's access.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  '.kindgi/secrets.env',
  '.kindgi/dev/runtime.env',
  'kindgi.env',
  'pack.env',
];

/** Claude Code's permission rules for `KEY_FILES` (they cover Read, Grep and Glob, and the sandbox when it's on). */
export function claudeReadDenyRules(): readonly string[] {
  return KEY_FILES.map((p) => `Read(./${p})`);
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
 * Merge `claudeReadDenyRules()` into `permissions.deny` of the settings file
 * at `path`, creating the file when it doesn't exist. A file that isn't valid
 * JSON, or whose `permissions.deny` isn't a list, is left as it is, and the
 * message says what to add.
 */
export async function patchClaudeSettings(path: string): Promise<ClaudeSettingsResult> {
  const rules = claudeReadDenyRules();
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

  let settings: unknown;
  try {
    settings = JSON.parse(raw);
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
    await writeFile(path, `${JSON.stringify(root, null, indentOf(raw))}\n`, 'utf8');
  } catch (err) {
    return {
      kind: 'error',
      appended: [],
      message: `Couldn't write ${path} (${(err as Error).message}): ${byHand}.`,
    };
  }
  return { kind: 'patched', appended: missing };
}

export interface AgentAccessResult {
  /** `.claude/settings.json`. */
  readonly claude: ClaudeSettingsResult;
  /** Other agents' ignore files that exist, by file name. */
  readonly others: readonly { readonly file: string; readonly result: PatchResult }[];
}

/** Keep the project's coding agents out of the key files (see the module comment). */
export async function patchAgentAccess(projectDir: string): Promise<AgentAccessResult> {
  const claude = await patchClaudeSettings(join(projectDir, '.claude', 'settings.json'));
  const others: { file: string; result: PatchResult }[] = [];
  for (const file of OTHER_AGENT_IGNORE_FILES) {
    const result = await patchIgnoreFile(join(projectDir, file), KEY_FILES, {
      createIfMissing: false,
    });
    if (result.kind !== 'absent') others.push({ file, result });
  }
  return { claude, others };
}

/**
 * `kindgi init`'s summary rows for `patchAgentAccess`: what was created or
 * patched, what already had the rules, and warnings (a file left as it was,
 * with what to add by hand). Never a failure: init goes on either way.
 */
export function agentAccessRows(
  projectDir: string,
  result: AgentAccessResult,
): {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
} {
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
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
  return { created, skipped, warnings };
}

/**
 * For a new pack (`kindgi init`, not augment): the files written, for
 * init's list. A failure is thrown: it's the pack's own new folder.
 */
export async function writeAgentAccess(projectDir: string): Promise<readonly string[]> {
  const result = await patchAgentAccess(projectDir);
  if (result.claude.kind === 'error') throw new Error(result.claude.message);
  const written: string[] = [];
  if (result.claude.kind === 'created' || result.claude.kind === 'patched') {
    written.push(join(projectDir, '.claude', 'settings.json'));
  }
  for (const { file, result: r } of result.others) {
    if (r.kind === 'patched') written.push(join(projectDir, file));
  }
  return written;
}

/** The file's indentation, as `JSON.stringify` takes it: a tab, or a number of spaces (2 by default). */
function indentOf(raw: string): string | number {
  const m = /\n([ \t]+)"/.exec(raw);
  if (m === null) return 2;
  const ws = m[1] as string;
  return ws.startsWith('\t') ? '\t' : ws.length;
}
