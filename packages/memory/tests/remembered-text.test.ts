// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `rememberedTextProblem`: the one check of a remembered fact's text, the
 * agent's and a reviewer's edit of it alike.
 */

import { describe, expect, test } from 'vitest';

import { MAX_REMEMBERED_TEXT, rememberedTextProblem } from '../src/index.js';

describe('rememberedTextProblem', () => {
  test('a short text, and one at the cap, can be remembered', () => {
    expect(rememberedTextProblem('Prefers tea.')).toBeUndefined();
    expect(rememberedTextProblem('x'.repeat(MAX_REMEMBERED_TEXT))).toBeUndefined();
  });

  test('the cap counts characters (code points), as a JSON Schema maxLength does', () => {
    expect(rememberedTextProblem('🙂'.repeat(MAX_REMEMBERED_TEXT))).toBeUndefined();
    expect(rememberedTextProblem('🙂'.repeat(MAX_REMEMBERED_TEXT + 1))).toBe(
      `must be at most ${MAX_REMEMBERED_TEXT} characters`,
    );
  });

  test.each([
    ['empty', '', 'must not be empty'],
    ['only spaces', ' \n\t ', 'must not be empty'],
    [
      'over the cap',
      'x'.repeat(MAX_REMEMBERED_TEXT + 1),
      `must be at most ${MAX_REMEMBERED_TEXT} characters`,
    ],
    ['not a string', 42, 'must be a string'],
  ])('%s: refused', (_name, text, problem) => {
    expect(rememberedTextProblem(text)).toBe(problem);
  });
});
