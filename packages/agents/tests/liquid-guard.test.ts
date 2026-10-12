// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one rule for templates: a Liquid engine is made by `tenantLiquid`,
 * so it can't skip the bounds' limits or resolve a partial. A
 * `new Liquid(` anywhere else in the packages' source fails this test
 * until it moves onto the helper.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const PACKAGES = join(import.meta.dirname, '..', '..');

/** The helper itself. */
const ALLOWED: Readonly<Record<string, number>> = { 'agents/src/liquid.ts': 1 };

/** Packages that never run in a server. */
const NOT_SERVER = new Set(['cli']);

/** Each file's `new Liquid(` count, past what's allowed, and an allowed file that lost its site. */
function unlisted(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [file, text] of files) {
    const count = (text.match(/\bnew Liquid\(/g) ?? []).length;
    if (count === 0) continue;
    seen.add(file);
    if (ALLOWED[file] !== count) problems.push(`${file}: ${count}, allowed ${ALLOWED[file] ?? 0}`);
  }
  for (const file of Object.keys(ALLOWED)) {
    if (!seen.has(file)) problems.push(`${file}: allowed, but has none`);
  }
  return problems;
}

function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const pkg of readdirSync(PACKAGES)) {
    if (NOT_SERVER.has(pkg)) continue;
    const src = join(PACKAGES, pkg, 'src');
    let entries: string[];
    try {
      entries = readdirSync(src, { recursive: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(m?ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      files.set(`${pkg}/src/${entry}`, readFileSync(join(src, entry), 'utf8'));
    }
  }
  return files;
}

describe('no Liquid engine skips tenantLiquid', () => {
  test("the packages' source makes one only in the helper", () => {
    const files = sourceFiles();
    expect(files.size).toBeGreaterThan(100);
    expect(unlisted(files)).toEqual([]);
  });

  test('a known positive: an engine made anywhere else fails it', () => {
    const files = new Map([
      ['agents/src/prompt.ts', 'const liquid = new Liquid({ strictVariables: true });'],
      ['agents/src/liquid.ts', 'new Liquid(a); new Liquid(b);'],
    ]);
    expect(unlisted(files)).toEqual([
      'agents/src/prompt.ts: 1, allowed 0',
      'agents/src/liquid.ts: 2, allowed 1',
    ]);
    expect(unlisted(new Map())).toEqual(['agents/src/liquid.ts: allowed, but has none']);
  });
});
