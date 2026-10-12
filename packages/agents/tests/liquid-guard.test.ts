// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one rule for templates: only `agents/src/liquid.ts` uses liquidjs,
 * so every engine is `tenantLiquid`'s and every render goes through
 * `renderTenantTemplate`, and none can skip the bounds' limits or resolve
 * a partial. A value import of liquidjs anywhere else in the packages'
 * source (aliased, by namespace, from a path inside the package, or by
 * `require` or `import()`) fails this test until it moves onto the helper.
 * A type-only import is fine. It reads the source as text, so it can't
 * see a name it doesn't spell out: `createRequire(import.meta.url)` called
 * on `'liquidjs'`, or a module name computed at run time.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const PACKAGES = join(import.meta.dirname, '..', '..');

/** The helper itself. */
const ALLOWED: Readonly<Record<string, number>> = { 'agents/src/liquid.ts': 1 };

/** Packages that never run in a server. */
const NOT_SERVER = new Set(['cli']);

/**
 * An import or export statement naming `liquidjs`, its `type` keyword
 * captured, or a `require` or dynamic `import` of it.
 */
const LIQUIDJS =
  /\b(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\bfrom\s*)?[`'"]liquidjs(?:\/[^`'"]*)?[`'"]|\b(?:require|import)\s*\(\s*[`'"]liquidjs(?:\/[^`'"]*)?[`'"]\s*\)/g;

/** How many times a file's source takes a value from liquidjs. */
function valueImports(text: string): number {
  let count = 0;
  for (const match of text.matchAll(LIQUIDJS)) {
    if (match[1] === undefined) count += 1;
  }
  return count;
}

/** Each file's value imports of liquidjs, past what's allowed, and an allowed file that lost its import. */
function unlisted(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [file, text] of files) {
    const count = valueImports(text);
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
      if (!/\.(?:[mc]?[jt]s|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      files.set(`${pkg}/src/${entry}`, readFileSync(join(src, entry), 'utf8'));
    }
  }
  return files;
}

describe('only the helper uses liquidjs', () => {
  test("the packages' source takes a value from liquidjs only in the helper", () => {
    const files = sourceFiles();
    expect(files.size).toBeGreaterThan(100);
    expect(unlisted(files)).toEqual([]);
  });

  test('known positives: an import anywhere else fails it, however it is written', () => {
    const files = new Map([
      ['agents/src/blocks.ts', "import { Liquid as Engine } from 'liquidjs';"],
      ['agents/src/prompt.ts', "import * as liquidjs from 'liquidjs';"],
      ['agents/src/define.ts', "import {\n  type Context,\n  Liquid,\n} from 'liquidjs';"],
      ['agents/src/derive.ts', "const { Liquid } = require('liquidjs');"],
      ['agents/src/resolve.ts', "const { Liquid } = await import('liquidjs');"],
      ['agents/src/index.ts', "export { Liquid } from 'liquidjs';"],
      ['agents/src/blocks-a.ts', "import { Liquid } from 'liquidjs/dist/liquid.node.js';"],
      ['agents/src/blocks-b.ts', 'const { Liquid } = require(`liquidjs`);'],
      ['agents/src/blocks-c.ts', 'const { Liquid } = await import(`liquidjs`);'],
      [
        'agents/src/liquid.ts',
        'import { Liquid } from \'liquidjs\';\nimport { Tag } from "liquidjs";',
      ],
    ]);
    expect(unlisted(files)).toEqual([
      'agents/src/blocks.ts: 1, allowed 0',
      'agents/src/prompt.ts: 1, allowed 0',
      'agents/src/define.ts: 1, allowed 0',
      'agents/src/derive.ts: 1, allowed 0',
      'agents/src/resolve.ts: 1, allowed 0',
      'agents/src/index.ts: 1, allowed 0',
      'agents/src/blocks-a.ts: 1, allowed 0',
      'agents/src/blocks-b.ts: 1, allowed 0',
      'agents/src/blocks-c.ts: 1, allowed 0',
      'agents/src/liquid.ts: 2, allowed 1',
    ]);
    expect(unlisted(new Map())).toEqual(['agents/src/liquid.ts: allowed, but has none']);
  });

  test('a type-only import is fine, and so is the name in a string', () => {
    const files = new Map([
      ['agents/src/blocks.ts', "import type { Context } from 'liquidjs';"],
      ['agents/src/prompt.ts', "export type { Liquid } from 'liquidjs';"],
      ['agents/src/define.ts', "const engine = 'liquidjs';"],
      ['agents/src/liquid.ts', "import { Liquid } from 'liquidjs';"],
    ]);
    expect(unlisted(files)).toEqual([]);
  });
});
