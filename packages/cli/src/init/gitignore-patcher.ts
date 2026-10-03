// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `.gitignore` patcher for augment mode. Appends Kindgi's local-state
 * ignore patterns if absent (the fresh templates' `.gitignore` carries
 * the same three):
 *
 *   - `.env.local` — where `kindgi secrets set` writes plaintext
 *     secret values in dev mode
 *   - `.kindgi/` — build artifacts, the dev index, dev-server state
 *   - `.kindgirc.json` — the dev server's API URL + bearer token,
 *     written by `kindgi dev` for second-terminal commands
 *
 * Idempotency: line-scan for exact matches only. Broader user
 * patterns (`.env*`, `*.local`) that already cover our lines get
 * appended-alongside — Git handles duplicate patterns fine, and this
 * keeps our detection dumb + predictable.
 *
 * Marker comment groups the additions so they're visible in a diff:
 *
 *   # Kindgi
 *   .env.local
 *   .kindgi/
 *   .kindgirc.json
 */

import { readFile, writeFile } from 'node:fs/promises';

const KINDGI_MARKER = '# Kindgi';
const KINDGI_PATTERNS = ['.env.local', '.kindgi/', '.kindgirc.json'] as const;

/**
 * Kindgi-managed files a host formatter must leave alone: `kindgi skills
 * sync` owns their bytes, and a reformatted skill reads as a local edit
 * that blocks every later update. Everything else Kindgi writes
 * (`kindgi.config.*`, `kindgi/**`) is the author's code and is formatted
 * like the rest of the app; `.kindgi/` is already out via `.gitignore`,
 * which Prettier 3 honours.
 */
const FORMATTER_IGNORE_PATTERNS = ['.claude/skills/kindgi-*/'] as const;

export interface PatchResult {
  /** `absent` — the file doesn't exist and was not created (formatter ignores). */
  readonly kind: 'patched' | 'already-present' | 'absent' | 'error';
  readonly appended: readonly string[];
  readonly message?: string;
}

/**
 * Read the file (or treat as empty if missing), append any of our
 * patterns that aren't already an exact-match line, write back.
 * Returns which lines were appended (empty when already complete).
 */
export function patchGitignore(gitignorePath: string): Promise<PatchResult> {
  return patchIgnoreFile(gitignorePath, KINDGI_PATTERNS, { createIfMissing: true });
}

/**
 * Add the Kindgi-managed skills to an existing `.prettierignore`. A
 * project without one is left alone — Kindgi doesn't introduce a
 * formatter config the app never had.
 */
export function patchPrettierignore(path: string): Promise<PatchResult> {
  return patchIgnoreFile(path, FORMATTER_IGNORE_PATTERNS, { createIfMissing: false });
}

/** Append whichever of `patterns` are missing (exact-line match) under the Kindgi marker. */
export async function patchIgnoreFile(
  gitignorePath: string,
  patterns: readonly string[],
  options: { readonly createIfMissing: boolean },
): Promise<PatchResult> {
  const read = await readIgnoreFile(gitignorePath);
  if (read.kind === 'error') return { kind: 'error', appended: [], message: read.message };
  if (read.kind === 'absent' && !options.createIfMissing) return { kind: 'absent', appended: [] };
  const raw = read.kind === 'ok' ? read.raw : '';
  const existed = read.kind === 'ok';

  const existingLines = new Set(
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  );

  const toAppend: string[] = [];
  for (const pattern of patterns) {
    if (!existingLines.has(pattern)) toAppend.push(pattern);
  }
  if (toAppend.length === 0) {
    return { kind: 'already-present', appended: [] };
  }

  // Preserve prior content verbatim; append our block with a marker.
  // Ensure the prior content ends with a newline so our block starts
  // on its own line.
  const prefix = existed ? (raw.endsWith('\n') || raw === '' ? raw : `${raw}\n`) : '';
  const separator = prefix === '' || prefix.endsWith('\n\n') ? '' : '\n';
  const block = `${separator}${KINDGI_MARKER}\n${toAppend.join('\n')}\n`;

  try {
    await writeFile(gitignorePath, `${prefix}${block}`, 'utf8');
  } catch (err) {
    return {
      kind: 'error',
      appended: [],
      message: `Failed to write ${gitignorePath}: ${(err as Error).message}`,
    };
  }

  return { kind: 'patched', appended: toAppend };
}

async function readIgnoreFile(
  path: string,
): Promise<
  | { readonly kind: 'ok'; readonly raw: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly message: string }
> {
  try {
    return { kind: 'ok', raw: await readFile(path, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', message: `Failed to read ${path}: ${(err as Error).message}` };
  }
}
