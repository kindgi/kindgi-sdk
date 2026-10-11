// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `image.dependencies: 'loaded'` in `kindgi build`: computed imports in
 * the pack's own code, the closure's lines in the build log, and Python
 * packs, which can't ask for it yet.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { findComputedImports, hasComputedCall } from '../src/build/computed-imports.js';
import {
  closureSummary,
  computedImportsCheck,
  pythonTrimmingRefusal,
} from '../src/commands/build.js';

describe('hasComputedCall', () => {
  test.each([
    ["import x from 'pg';", false],
    ["const pg = require('pg');", false],
    ['const pg = require("pg");', false],
    ["const m = await import('sharp');", false],
    ['const m = await import(`./plugins/a.js`);', false],
    ['const m = require(name);', true],
    ['const m = await import(name);', true],
    ['const m = await import(`@acme/${name}`);', true],
    ["const m = require('a' + name);", true],
    ["const m = await import('./data.json', { with: { type: 'json' } });", false],
    ["const m = require('it\\'s');", false],
    ['const r = require.resolve(name);', false],
    ['loader.import(name);', false],
    ['myrequire(name);', false],
    ["const a = require('a'), b = require(name);", true],
  ])('%s → %s', (line, computed) => {
    expect(hasComputedCall(line)).toBe(computed);
  });
});

describe('findComputedImports', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kindgi-computed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("each call by file and line; comment lines aren't code", async () => {
    await writeFile(
      join(dir, 'b.ts'),
      '// require(name) in a comment\n/* import(name) */\n * import(name)\nexport const load = (n: string) => import(n);\n',
    );
    await writeFile(join(dir, 'a.ts'), "import pg from 'pg';\nexport default pg;\n");
    expect(await findComputedImports([join(dir, 'b.ts'), join(dir, 'a.ts')])).toEqual([
      { file: join(dir, 'b.ts'), line: 4, text: 'export const load = (n: string) => import(n);' },
    ]);
  });
});

describe('computedImportsCheck', () => {
  const computed = [
    { file: '/app/tools/log.ts', line: 3, text: 'pino.transport({ target: require(t) })' },
  ];

  test('none: nothing to say', () => {
    expect(computedImportsCheck([], [], '/app')).toEqual({ kind: 'ok', lines: [] });
  });

  test('with no image.keep, the build refuses, naming each call and the two ways out', () => {
    const outcome = computedImportsCheck(computed, [], '/app');
    expect(outcome.kind).toBe('refuse');
    expect(outcome.kind === 'refuse' && outcome.message).toBe(
      "The pack's code loads a module by a computed name, and the image keeps only the packages the pack imports by name (image.dependencies: 'loaded'):\n  tools/log.ts:3  pino.transport({ target: require(t) })\nName the packages these load in image.keep, or set image.dependencies: 'all'.\n",
    );
  });

  test('with image.keep, they are named as a reminder', () => {
    expect(computedImportsCheck(computed, ['pino-pretty'], '/app')).toEqual({
      kind: 'ok',
      lines: [
        '    ⚠ Loaded by a computed name; image.keep (pino-pretty) must cover what these load:',
        '      tools/log.ts:3  pino.transport({ target: require(t) })',
      ],
    });
  });
});

describe('closureSummary', () => {
  test("the closure's lines, from a plain-progress build log", () => {
    expect(
      closureSummary([
        '#14 [closure 2/2] RUN node /home/node/closure-in/kindgi-closure.mjs trim',
        '#14 1.204 kindgi-closure: kept 41 of 2,927 packages (61.2 MB of 2.31 GB)',
        "#14 1.204 kindgi-closure: dropped 3 of the pack's own dependencies its tools don't import: next, react, react-dom",
        '#14 DONE 1.3s',
      ]),
    ).toEqual([
      '    ✓ Dependencies: kept 41 of 2,927 packages (61.2 MB of 2.31 GB)',
      "    ✓ Dependencies: dropped 3 of the pack's own dependencies its tools don't import: next, react, react-dom",
    ]);
    expect(closureSummary(['#9 DONE 0.1s'])).toEqual([]);
  });
});

describe('pythonTrimmingRefusal', () => {
  test("'loaded' and keep are refused for a Python pack, never ignored; 'all' and nothing are fine", () => {
    expect(pythonTrimmingRefusal({ dependencies: 'loaded' })).toBe(
      `[tool.kindgi.image] dependencies = "loaded" isn't available for Python packs yet: a Python pack's image keeps every dependency in its lockfile. Remove it, or set dependencies = "all".`,
    );
    expect(pythonTrimmingRefusal({ keep: ['x'] })).toContain('[tool.kindgi.image] keep isn');
    expect(pythonTrimmingRefusal({ dependencies: 'some' })).toBe(
      '[tool.kindgi.image] dependencies is "loaded" or "all". Got "some".',
    );
    expect(
      pythonTrimmingRefusal({ dependencies: 'all', 'system-packages': ['curl'] }),
    ).toBeUndefined();
    expect(pythonTrimmingRefusal(undefined)).toBeUndefined();
  });
});
