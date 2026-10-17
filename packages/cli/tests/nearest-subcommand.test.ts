// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { nearestSubcommand } from '../src/help.js';

describe('nearestSubcommand', () => {
  const names = ['list', 'get', 'publish', 'unregister', 'versions'];

  test('a typo: the subcommand a letter or two away', () => {
    expect(nearestSubcommand('lsit', names)).toBe('list');
    expect(nearestSubcommand('versoins', names)).toBe('versions');
    expect(nearestSubcommand('gte', names)).toBe('get');
  });

  test("a word another group uses for the same thing: this group's", () => {
    expect(nearestSubcommand('register', names)).toBe('publish');
    expect(nearestSubcommand('delete', names)).toBe('unregister');
    expect(nearestSubcommand('ls', names)).toBe('list');
    expect(nearestSubcommand('show', names)).toBe('get');
  });

  test('never the opposite of what was typed', () => {
    expect(nearestSubcommand('register', ['list', 'unregister'])).toBeUndefined();
    expect(nearestSubcommand('unregister', ['list', 'register'])).toBeUndefined();
  });

  test('nothing near: none', () => {
    expect(nearestSubcommand('deploy', names)).toBeUndefined();
    expect(nearestSubcommand('register', ['list', 'get'])).toBeUndefined();
  });
});
