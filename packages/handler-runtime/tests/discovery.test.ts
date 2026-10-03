// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_DISCOVERY,
  createGlobMatcher,
  discoveryRoots,
  globStaticPrefix,
  globToRegex,
  resolveDiscovery,
} from '../src/index.js';

describe('globToRegex', () => {
  test.each([
    ['tools/**/*.{ts,js,mjs}', 'tools/echo/index.ts', true],
    ['tools/**/*.{ts,js,mjs}', 'tools/index.mjs', true],
    ['tools/**/*.{ts,js,mjs}', 'tools/echo/index.json', false],
    ['kindgi/tools/**/*.ts', 'kindgi/tools/a/b.ts', true],
    ['kindgi/tools/**/*.ts', 'tools/a.ts', false],
    ['*.tool.ts', 'x.tool.ts', true],
    ['*.tool.ts', 'dir/x.tool.ts', false],
    ['a?c.ts', 'abc.ts', true],
  ])('%s ~ %s → %s', (pattern, path, expected) => {
    expect(globToRegex(pattern).test(path)).toBe(expected);
  });
});

describe('globStaticPrefix', () => {
  test.each([
    ['tools/**/*.{ts,js,mjs}', 'tools'],
    ['kindgi/tools/**/*.ts', 'kindgi/tools'],
    ['./kindgi/agents/*.ts', 'kindgi/agents'],
    ['**/*.tool.ts', ''],
    ['src/tools/index.ts', 'src/tools'],
    ['index.ts', ''],
  ])('%s → %j', (pattern, prefix) => {
    expect(globStaticPrefix(pattern)).toBe(prefix);
  });
});

describe('discoveryRoots', () => {
  test('defaults: the four folders', () => {
    expect(discoveryRoots(Object.values(DEFAULT_DISCOVERY))).toEqual([
      'agents',
      'flows',
      'guardrails',
      'tools',
    ]);
  });

  test('a pack embedded in an app: only kindgi/*, never the app root', () => {
    const roots = discoveryRoots([
      'kindgi/tools/**/*.ts',
      'kindgi/agents/**/*.ts',
      'kindgi/guardrails/**/*.ts',
      'kindgi/flows/**/*.ts',
    ]);
    expect(roots).toEqual(['kindgi/agents', 'kindgi/flows', 'kindgi/guardrails', 'kindgi/tools']);
  });

  test('nested prefixes collapse to the outer one; a root-level pattern wins all', () => {
    expect(discoveryRoots(['kindgi/**/*.ts', 'kindgi/tools/**/*.ts'])).toEqual(['kindgi']);
    expect(discoveryRoots(['**/*.tool.ts', 'kindgi/tools/*.ts'])).toEqual(['']);
  });
});

describe('createGlobMatcher', () => {
  test('matches any pattern, never test files', () => {
    const m = createGlobMatcher(['kindgi/tools/**/*.ts', 'kindgi/agents/**/*.ts']);
    expect(m('kindgi/tools/echo/index.ts')).toBe(true);
    expect(m('kindgi/agents/a.ts')).toBe(true);
    expect(m('kindgi/tools/echo/index.test.ts')).toBe(false);
    expect(m('index.json')).toBe(false);
    expect(m('tools/echo/index.ts')).toBe(false);
  });
});

describe('resolveDiscovery', () => {
  test('fills defaults, keeps overrides', () => {
    expect(resolveDiscovery({ tools: 'kindgi/tools/**/*.ts' })).toEqual({
      ...DEFAULT_DISCOVERY,
      tools: 'kindgi/tools/**/*.ts',
    });
    expect(resolveDiscovery(undefined)).toEqual(DEFAULT_DISCOVERY);
  });
});
