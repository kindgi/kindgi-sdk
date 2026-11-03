// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `image.dependencies: 'loaded'` in `kindgi build`: computed imports in
 * the pack's own code, the closure's lines in the build log, and Python
 * packs, which can't ask for it yet.
 */

import { describe, expect, test } from 'vitest';

import { computedImportsFrom } from '../src/build/computed-imports.js';
import {
  closureSummary,
  computedImportsCheck,
  pythonTrimmingRefusal,
} from '../src/commands/build.js';

describe('computedImportsFrom', () => {
  const at = (file: string, line: number, lineText: string) => ({
    file,
    line,
    lineText,
    column: 0,
  });

  test("esbuild's computed-import notes, by file and line, once each; nothing else", () => {
    expect(
      computedImportsFrom(
        [
          {
            id: 'unsupported-dynamic-import',
            location: at('tools/load.ts', 4, '  return import(name);'),
          },
          { id: 'indirect-require', location: at('tools/a.ts', 2, 'const r = require; r(n);') },
          {
            id: 'unsupported-require-call',
            location: at('tools/load.ts', 4, '  return import(name);'),
          },
          {
            id: 'unsupported-require-call',
            location: at('node_modules/x/index.js', 1, 'require(n)'),
          },
          { id: 'empty-import-meta', location: at('tools/b.ts', 1, 'import.meta') },
          { id: 'unsupported-dynamic-import', location: null },
        ],
        '/app',
      ),
    ).toEqual([
      { file: '/app/tools/a.ts', line: 2, text: 'const r = require; r(n);' },
      { file: '/app/tools/load.ts', line: 4, text: 'return import(name);' },
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
