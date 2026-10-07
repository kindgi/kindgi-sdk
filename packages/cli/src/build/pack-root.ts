// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Resolve the pack + repo roots for `kindgi build` and adjacent
 * commands. Distinguishes two layouts:
 *
 *   - **standalone** — `kindgi.config.ts` and `package.json` live in
 *     the SAME directory. This is the classical shape produced by
 *     `kindgi init <pack-name>` (fresh scaffold). `packDir` and
 *     `repoRoot` are the same absolute path.
 *
 *   - **augment** — `kindgi.config.ts` sits inside a subdirectory of
 *     a larger repo (e.g. `<repo>/kindgi/`) whose `package.json` lives
 *     UP the tree. `packDir` is where the pack config is; `repoRoot`
 *     is where the surrounding repo's `package.json` lives. This is
 *     the trigger.dev-shaped "add Kindgi to my existing app" layout.
 *
 * Auto-detection algorithm:
 *
 *   1. Resolve `packDir` from `--path` flag (absolute or cwd-relative)
 *      or default to `cwd`.
 *   2. Verify at least one of `kindgi.config.{ts,mjs,js,cjs}` exists
 *      at `packDir`. If not, error.
 *   3. Walk up from `packDir` looking for a `package.json`. First
 *      ancestor (including `packDir` itself) that has one is `repoRoot`.
 *   4. If `packDir === repoRoot` → `standalone`, else `augment`.
 *   5. If no `package.json` found up to filesystem root, error.
 *
 * Never prompts. Never guesses beyond the algorithm. Explicit
 * override for the corner case where auto-detect gets it wrong is
 * deferred until a real user reports one.
 */

import { KINDGI_CONFIG_FILENAMES, type PackLanguage, findKindgiConfig } from '@kindgi/handler-runtime';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

export type PackMode = 'standalone' | 'augment';

/**
 * The resolved layout roots. `packDir === repoRoot` iff `mode ===
 * 'standalone'`. Callers that need to bundle from the pack should use
 * `packDir`; callers that need the repo's `package.json` /
 * `pnpm-lock.yaml` / etc. should use `repoRoot`.
 */
export interface PackRoots {
  readonly packDir: string;
  readonly repoRoot: string;
  readonly mode: PackMode;
  /** The pack's code language — a Python or Java pack has no Node project around it. */
  readonly language: PackLanguage;
}

export type ResolveResult =
  | { readonly kind: 'ok'; readonly roots: PackRoots }
  | { readonly kind: 'err'; readonly code: ResolveErrorCode; readonly message: string };

export type ResolveErrorCode = 'no-config' | 'no-package-json';

/**
 * Recognized config filenames, in preference order — the indexer's own
 * list, so every command finds the same config.
 */
export const CONFIG_FILENAMES: readonly string[] = KINDGI_CONFIG_FILENAMES;

export interface ResolveInputs {
  /** Current working directory when the CLI invoked. */
  readonly cwd: string;
  /** `--path=<dir>` flag value if the caller passed one. */
  readonly pathFlag?: string;
  /** Injectable existence check for tests. Default uses `fs/promises`. */
  readonly fileExists?: (path: string) => Promise<boolean>;
}

const defaultFileExists = async (path: string): Promise<boolean> => {
  const { stat } = await import('node:fs/promises');
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
};

export async function resolvePackRoots(inputs: ResolveInputs): Promise<ResolveResult> {
  const fileExists = inputs.fileExists ?? defaultFileExists;

  const rawPath = inputs.pathFlag !== undefined && inputs.pathFlag !== ''
    ? inputs.pathFlag
    : inputs.cwd;
  const packDir = isAbsolute(rawPath) ? rawPath : resolve(inputs.cwd, rawPath);

  // 1. Verify a kindgi.config.* exists at packDir — or a Python pack's
  //    [tool.kindgi] in pyproject.toml, or a Java pack's kindgi.config.json,
  //    whose root is the pack itself.
  if ((await findKindgiConfig(packDir))?.format === 'json') {
    return {
      kind: 'ok',
      roots: { packDir, repoRoot: packDir, mode: 'standalone', language: 'java' },
    };
  }
  const hasConfig = await hasAnyConfig(packDir, fileExists);
  if (!hasConfig && (await findKindgiConfig(packDir))?.format === 'pyproject') {
    return {
      kind: 'ok',
      roots: { packDir, repoRoot: packDir, mode: 'standalone', language: 'python' },
    };
  }
  if (!hasConfig) {
    return {
      kind: 'err',
      code: 'no-config',
      message: `No kindgi.config.{ts,mts,mjs,js,cjs} (or pyproject.toml with a [tool.kindgi] table, or kindgi.config.json) at ${packDir}. Run \`kindgi init\` to scaffold one, or pass \`--path=<pack-dir>\` if you meant a different directory.`,
    };
  }

  // 2. Walk up from packDir looking for package.json.
  const repoRoot = await findAncestorWithPackageJson(packDir, fileExists);
  if (repoRoot === null) {
    return {
      kind: 'err',
      code: 'no-package-json',
      message: `No package.json found at or above ${packDir}. A pack (standalone or embedded) must live inside a Node.js project.`,
    };
  }

  const mode: PackMode = packDir === repoRoot ? 'standalone' : 'augment';
  return { kind: 'ok', roots: { packDir, repoRoot, mode, language: 'node' } };
}

async function hasAnyConfig(
  dir: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<boolean> {
  for (const name of CONFIG_FILENAMES) {
    if (await fileExists(join(dir, name))) return true;
  }
  return false;
}

async function findAncestorWithPackageJson(
  start: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  let current = start;
  const rootMarker = parse(current).root;
  while (true) {
    if (await fileExists(join(current, 'package.json'))) return current;
    if (current === rootMarker) return null;
    current = dirname(current);
  }
}
