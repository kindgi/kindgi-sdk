// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The names a pack service keeps although its pack doesn't declare them
 * are one list in every language: the TypeScript pack service's
 * (`@kindgi/handler-runtime`), Python's (`kindgi.pack.env_filter`) and
 * Java's (`PackEnv`; `PackEnvTest` holds the launcher to it). The suite
 * checks a name of each kind black-box; this checks every name.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PLATFORM_ENV_NAMES, PLATFORM_ENV_PREFIXES } from '@kindgi/handler-runtime';
import { describe, expect, test } from 'vitest';

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
}

/** The text between `start` and the next `end` after it. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from + start.length, to);
}

/** The double-quoted strings in `text`, in order. */
function quoted(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
}

describe('the platform names a pack service keeps', () => {
  test('Python', () => {
    const python = source('sdks/python/src/kindgi/pack/env_filter.py');
    expect(
      new Set(quoted(between(python, 'PLATFORM_ENV_NAMES: frozenset[str] = frozenset(', '\n)\n'))),
    ).toEqual(new Set(PLATFORM_ENV_NAMES));
    expect(quoted(between(python, 'PLATFORM_ENV_PREFIXES: tuple[str, ...] = (', ')'))).toEqual([
      ...PLATFORM_ENV_PREFIXES,
    ]);
  });

  test('Java', () => {
    const java = source('sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/PackEnv.java');
    expect(new Set(quoted(between(java, 'PLATFORM_ENV_NAMES = Set.of(', ');')))).toEqual(
      new Set(PLATFORM_ENV_NAMES),
    );
    expect(quoted(between(java, 'PLATFORM_ENV_PREFIXES = List.of(', ');'))).toEqual([
      ...PLATFORM_ENV_PREFIXES,
    ]);
  });
});
