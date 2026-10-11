// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Computed imports in a pack's own code: `require(name)` or
 * `import(name)` whose argument isn't a literal. In an image that carries
 * only what the pack loads (`image.dependencies: 'loaded'`), the package
 * such a call loads is invisible to the closure, so the build names each
 * one (file:line) and asks for `image.keep`.
 *
 * esbuild leaves these calls as they are without a warning (0.24, for a
 * Node bundle), so the pack's sources are scanned: the files esbuild read
 * outside `node_modules`. It reads source text, line by line, skipping
 * comment lines; a call it can't tell is a literal counts as computed.
 */

import { readFile } from 'node:fs/promises';

export interface ComputedImport {
  /** Absolute path. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** The line, trimmed. */
  readonly text: string;
}

/** A `require(` or `import(` call that isn't a member (`x.require(`) or part of a name. */
const CALL = /(?<![\w$.])(require|import)\s*\(\s*/g;

/** Computed `require(…)` / `import(…)` calls in `files`, in file and line order. */
export async function findComputedImports(files: readonly string[]): Promise<ComputedImport[]> {
  const found: ComputedImport[] = [];
  for (const file of [...files].sort()) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (hasComputedCall(line)) found.push({ file, line: i + 1, text: trimmed });
    }
  }
  return found;
}

/** Whether a line calls `require` or `import` with an argument that isn't a string literal. */
export function hasComputedCall(line: string): boolean {
  for (const match of line.matchAll(CALL)) {
    const rest = line.slice((match.index ?? 0) + match[0].length);
    if (!startsWithLiteral(rest)) return true;
  }
  return false;
}

/** Whether the call's argument is one string literal: closed, then `)` or `,` (import attributes). */
function startsWithLiteral(rest: string): boolean {
  const quote = rest[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return false;
  const close = closingQuote(rest, quote);
  if (close === -1) return false;
  // A template literal with `${…}` is computed.
  if (quote === '`' && rest.slice(1, close).includes('${')) return false;
  const next = rest.slice(close + 1).trimStart()[0];
  return next === ')' || next === ',';
}

/** Where the string that opens `rest` closes, past escaped quotes; -1 if not on this line. */
function closingQuote(rest: string, quote: string): number {
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '\\') i++;
    else if (rest[i] === quote) return i;
  }
  return -1;
}
