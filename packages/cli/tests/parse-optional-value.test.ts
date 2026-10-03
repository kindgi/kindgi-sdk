// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** An option whose value may be left out (`--push [<repository>]`). */

import { describe, expect, test } from 'vitest';

import { parseCommand } from '../src/parse.js';

const spec = { push: { type: 'string', optionalValue: true }, env: { type: 'string' } } as const;

describe('parseCommand: optionalValue', () => {
  test.each([
    [['--push'], ''],
    [['--push', '--env', 'dev'], ''],
    [['--push=registry.example.com/acme/app'], 'registry.example.com/acme/app'],
    [['--push', 'registry.example.com/acme/app', '--env', 'dev'], 'registry.example.com/acme/app'],
    [['--env', 'dev'], undefined],
  ])('%j → push %j', (tokens, push) => {
    expect(parseCommand(tokens, spec).options.push).toBe(push);
  });

  test('an option without it still needs its value', () => {
    expect(() => parseCommand(['--env'], spec)).toThrow();
  });
});
