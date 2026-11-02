// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Computed imports in a pack's own code: `require(name)`, `import(name)`,
 * or `require` passed around (`const r = require; r(name)`). In an image
 * that carries only what the pack loads (`image.dependencies: 'loaded'`),
 * the package such a call loads is invisible to the closure, so the build
 * names each one (file:line) and asks for `image.keep`.
 *
 * esbuild knows them: it leaves each such call as it is, with a note at
 * debug level. A `'loaded'` pack build raises those notes to warnings
 * (`COMPUTED_IMPORT_LOG_OVERRIDE`), and they're read from the build's
 * warnings here. Two residual forms esbuild can't see either, a
 * `createRequire` alias and `module.require`, are left to the run-time
 * hint.
 */

import { resolve } from 'node:path';

export interface ComputedImport {
  /** Absolute path. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** The line, trimmed. */
  readonly text: string;
}

/** esbuild's notes for a call it can't bundle because its argument is computed. */
const COMPUTED_IMPORT_NOTES = [
  'unsupported-require-call',
  'unsupported-dynamic-import',
  'indirect-require',
] as const;

/** The pack build's `logOverride` with `'loaded'`: those notes, as warnings. */
export const COMPUTED_IMPORT_LOG_OVERRIDE: Readonly<Record<string, 'warning'>> = Object.fromEntries(
  COMPUTED_IMPORT_NOTES.map((id) => [id, 'warning']),
);

/** The subset of an esbuild message this reads. */
export interface BuildMessage {
  readonly id?: string;
  readonly location?: {
    readonly file: string;
    readonly line: number;
    readonly lineText: string;
  } | null;
}

/**
 * The computed imports among a build's warnings: file (resolved against
 * the build's working folder), line, and the line's text, in file and
 * line order, each site once. Calls inside `node_modules` aren't the
 * pack's (they're externals, not bundled).
 */
export function computedImportsFrom(
  warnings: readonly BuildMessage[],
  workingDir: string,
): ComputedImport[] {
  const sites = new Map<string, ComputedImport>();
  for (const warning of warnings) {
    const at = warning.location;
    if (
      at == null ||
      !(COMPUTED_IMPORT_NOTES as readonly (string | undefined)[]).includes(warning.id)
    )
      continue;
    const file = resolve(workingDir, at.file);
    if (/[\\/]node_modules[\\/]/.test(file)) continue;
    sites.set(`${file}:${at.line}`, { file, line: at.line, text: at.lineText.trim() });
  }
  return [...sites.values()].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
}
