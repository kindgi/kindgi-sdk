// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tenant's pattern on the engine the bounds name: the answers of the
 * JavaScript `RegExp` it was written as, on V8 or on RE2 (linear time),
 * with what RE2 doesn't have refused by name.
 */

import { afterEach, describe, expect, test } from 'vitest';

import {
  HOSTED_BOUNDS,
  SELF_HOSTED_BOUNDS,
  type TenantPattern,
  compileTenantPattern,
  tenantPatternSyntaxProblem,
} from '../src/index.js';
import { overrideTenantInputBounds } from '../src/testing.js';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});
const onRe2 = () => {
  restore = overrideTenantInputBounds(HOSTED_BOUNDS);
};

function compiled(source: string, flags?: string): TenantPattern {
  const result = compileTenantPattern(source, flags);
  if (result.kind !== 'ok') throw new Error(`refused: ${result.reason}`);
  return result.pattern;
}
function refusal(source: string, flags?: string): string {
  const result = compileTenantPattern(source, flags);
  if (result.kind !== 'refused') throw new Error(`compiled: /${source}/${flags ?? ''}`);
  return result.reason;
}
/** What V8 says, from a fresh `RegExp` each time, as the checks did before. */
const v8 = {
  test: (source: string, flags: string, input: string) => new RegExp(source, flags).test(input),
  count: (source: string, flags: string, input: string) =>
    (input.match(new RegExp(source, flags.includes('g') ? flags : `${flags}g`)) ?? []).length,
};

describe('length: the source with its flags, against patternMaxLength', () => {
  test.each([
    ['self-hosted', SELF_HOSTED_BOUNDS],
    ['hosted', HOSTED_BOUNDS],
  ])('%s: at the limit it compiles; one over, refused with both numbers', (_, bounds) => {
    restore = overrideTenantInputBounds(bounds);
    const max = bounds.patternMaxLength;
    expect(compileTenantPattern('a'.repeat(max - 1), 'i').kind).toBe('ok');
    expect(refusal('a'.repeat(max), 'i')).toBe(
      `${max + 1} characters with its flags, over the limit of ${max}`,
    );
  });
});

describe('on V8 (self-hosted): the RegExp it was written as', () => {
  test("a pattern that doesn't compile is refused with V8's own words", () => {
    expect(refusal('(unclosed')).toBe(
      'Invalid regular expression: /(unclosed/: Unterminated group',
    );
    expect(refusal('a', 'x')).toContain("Invalid flags supplied to RegExp constructor 'x'");
  });

  test('compiled once, asked many times: g and y keep no state between answers', () => {
    const global = compiled('a', 'g');
    expect([global.test('a'), global.test('a'), global.test('a')]).toEqual([true, true, true]);
    const sticky = compiled('b', 'y');
    expect([sticky.test('ab'), sticky.test('ba'), sticky.test('ab')]).toEqual([false, true, false]);
    expect([global.count('aaa'), global.count('aaa')]).toEqual([3, 3]);
  });

  test.each([
    ['\\[[^\\]]+\\]', '', 'per [Smith] and [Jones], and [Lee]'],
    ['a*', '', 'baa'],
    ['x*', '', '😀a'],
    ['x*', 'u', '😀a'],
    ['\\b', '', 'ab cd'],
    ['a', 'y', 'aab'],
    ['a', 'y', 'baa'],
    ['a', 'i', 'AaA'],
  ])('count(/%s/%s) on %j is what match() with g counts', (source, flags, input) => {
    expect(compiled(source, flags).count(input)).toBe(v8.count(source, flags, input));
  });

  test('count stops at atMost', () => {
    expect(compiled('a').count('aaaaa', 2)).toBe(2);
    expect(compiled('a').count('a', 2)).toBe(1);
  });
});

describe('on RE2 (hosted): what it lacks, refused by name', () => {
  test.each([
    ['(a)\\1', 'has no backreferences (`\\1` at index 3)'],
    ['(?<n>a)\\k<n>', 'has no backreferences (`\\k<` at index 7)'],
    ['(?=a)', 'has no lookahead or lookbehind (`(?=` at index 0)'],
    ['b(?!a)', 'has no lookahead or lookbehind (`(?!` at index 1)'],
    ['(?<=a)b', 'has no lookahead or lookbehind (`(?<=` at index 0)'],
    ['(?<!a)b', 'has no lookahead or lookbehind (`(?<!` at index 0)'],
    ['a[]b', 'reads `[]` as the start of a class, not as JavaScript does (at index 1)'],
    ['[^]a]', 'reads `[^]` as the start of a class, not as JavaScript does (at index 0)'],
    [
      '[[:alpha:]]',
      'reads `[:` in a class as a POSIX class such as `[:alpha:]`, not as JavaScript does (at index 1)',
    ],
  ])('/%s/: %s', (source, why) => {
    onRe2();
    expect(refusal(source)).toBe(`RE2, the engine patterns run on here, ${why}`);
  });

  test.each([
    ['\\(?=a\\)', '(=a)'],
    ['[(?=]', '='],
    ['\\[]', 'a[]'],
    ['[a[]', '['],
    ['\\\\1', 'a\\1'],
    ['(?<n>a)b', 'ab'],
    ['\\\\p{L}', '\\p{L}'],
    ['\\x41', 'A'],
  ])(
    '/%s/ has the same characters escaped, in a class, or a named group: it runs',
    (source, input) => {
      onRe2();
      expect(compiled(source).test(input)).toBe(true);
      expect(v8.test(source, '', input)).toBe(true);
    },
  );

  test('flags: v, an unknown one and a repeated one are refused; d and g change nothing', () => {
    onRe2();
    expect(refusal('a', 'v')).toBe(
      'RE2, the engine patterns run on here, has no `v` flag (set notation)',
    );
    expect(refusal('a', 'x')).toBe("`x` isn't a flag");
    expect(refusal('a', 'ii')).toBe('the `i` flag is given twice');
    expect(compiled('a', 'dg').test('ba')).toBe(true);
  });

  test("a pattern RE2 can't compile is refused with RE2's words: repeat counts over 1000", () => {
    onRe2();
    expect(refusal('(x{1000}){1000}')).toBe(
      'RE2, the engine patterns run on here, refuses it: invalid repeat count: `{1000}`',
    );
    expect(refusal('x{1001}')).toBe(
      'RE2, the engine patterns run on here, refuses it: invalid repeat count: `{1001}`',
    );
    // V8 runs both.
    expect(/(x{1000}){1000}/.test('x')).toBe(false);
    expect(/x{1001}/.test('x')).toBe(false);
  });

  const misread = (written: string, reads: string, letter: string, index: number) =>
    `RE2, the engine patterns run on here, reads \`${written}\` as ${reads}, where JavaScript without the \`u\` flag reads the letter \`${letter}\` (at index ${index})`;
  test.each([
    ['\\p{L}', '\\p', 'a Unicode class', 'p', 0],
    ['a\\pL', '\\p', 'a Unicode class', 'p', 1],
    ['\\P{L}', '\\P', 'a negated Unicode class', 'P', 0],
    ['\\Aab', '\\A', 'the start of the text', 'A', 0],
    ['ab\\z', '\\z', 'the end of the text', 'z', 2],
    ['\\Q.\\E', '\\Q', 'the start of a quoted literal (`\\Q…\\E`)', 'Q', 0],
    ['\\a', '\\a', 'the bell character', 'a', 0],
    ['\\x{41}', '\\x{', 'the start of a code point (`\\x{41}`)', 'x', 0],
    ['[\\p{L}]', '\\p', 'a Unicode class', 'p', 1],
    ['[\\x{41}]', '\\x{', 'the start of a code point (`\\x{41}`)', 'x', 1],
    ['[\\a]', '\\a', 'the bell character', 'a', 1],
  ])(
    '/%s/ without u: JavaScript reads %s as the letter, RE2 as something else: refused by name',
    (source, written, reads, letter, index) => {
      onRe2();
      expect(refusal(source)).toBe(misread(written, reads, letter, index));
      expect(() => new RegExp(source)).not.toThrow();
    },
  );

  test.each([
    ['\\u0041', ''],
    ['[\\u4e00-\\u9fff]', ''],
    ['a\\u{41}', 'u'],
  ])('/%s/%s: RE2 has no \\u escapes, refused by name', (source, flags) => {
    onRe2();
    expect(refusal(source, flags)).toBe(
      `RE2, the engine patterns run on here, has no \`\\u\` escapes: write the character itself (at index ${source.indexOf('\\u')})`,
    );
  });
});

describe('on RE2: what RegExp accepts, never more', () => {
  test.each([
    ['(?i)abc', ''],
    ['(?s).', ''],
    ['(?P<n>a)', ''],
    ['x{1000}{1000}', ''],
    ['\\pL', 'u'],
    ['\\p{Greek}', 'u'],
    ['\\x{41}', 'u'],
    ['\\A', 'u'],
    ['\\z', 'u'],
    ['\\a', 'u'],
    ['\\Q.\\E', 'u'],
  ])("/%s/%s, which V8 refuses, is refused in V8's words", (source, flags) => {
    onRe2();
    let words: string | undefined;
    try {
      new RegExp(source, flags);
    } catch (error) {
      words = (error as Error).message;
    }
    expect(words).toMatch(/^Invalid regular expression: /);
    expect(refusal(source, flags)).toBe(words);
  });
});

describe('on RE2: each mapped flag answers as V8 does, where they could differ', () => {
  test.each([
    ['^b$', 'm', 'a\nb\nc'],
    ['^b$', '', 'a\nb\nc'],
    ['a.b', 's', 'a\nb'],
    ['a.b', '', 'a\nb'],
    ['i', 'i', 'İ'],
    ['İ', 'i', 'i'],
    ['i', 'iu', 'İ'],
    ['i', 'i', 'I'],
    ['^\\p{L}$', 'u', 'é'],
    ['^\\p{L}$', 'u', '1'],
    ['^.$', 'u', '😀'],
    ['^.{2}$', 'u', '😀'],
  ])('/%s/%s on %j', (source, flags, input) => {
    onRe2();
    expect(compiled(source, flags).test(input)).toBe(v8.test(source, flags, input));
  });

  test.each([
    ['\\[[^\\]]+\\]', 'u', 'per [Smith] and [Jones], and [Lee]'],
    ['a*', 'u', 'baa'],
    ['x*', 'u', '😀a'],
    ['\\b', 'u', 'ab cd'],
    ['a', 'uy', 'aab'],
    ['a', 'uy', 'baa'],
    ['', 'uy', 'ab'],
  ])('count(/%s/%s) on %j as V8 counts it', (source, flags, input) => {
    onRe2();
    expect(compiled(source, flags).count(input)).toBe(v8.count(source, flags, input));
  });

  test('y anchors test at the start, as V8 does from lastIndex 0', () => {
    onRe2();
    expect(compiled('b', 'y').test('ab')).toBe(false);
    expect(compiled('a', 'y').test('ab')).toBe(true);
  });
});

describe('on RE2: what reads differently, the same way for every pattern (the README lists it)', () => {
  test.each([
    // RE2 always matches by code point, and folds case, as `u` does.
    ['^.$', '', '😀', true, false],
    ['ſ', 'i', 's', true, false],
    // `.` stops only at \n; with m, ^ and $ only around \n.
    ['a.b', '', 'a\rb', true, false],
    ['a.b', '', 'a b', true, false],
    ['a$', 'm', 'a\r\nb', false, true],
    // \s is ASCII whitespace.
    ['^\\s$', '', ' ', false, true],
    ['^\\s$', '', '\v', false, true],
  ])('/%s/%s on %j: RE2 %s, V8 %s', (source, flags, input, re2Answer, v8Answer) => {
    onRe2();
    expect(compiled(source, flags).test(input)).toBe(re2Answer);
    expect(v8.test(source, flags, input)).toBe(v8Answer);
  });
});

describe('on RE2: linear time', () => {
  test('a pattern that backtracks exponentially on V8 answers at once', () => {
    onRe2();
    const started = performance.now();
    expect(compiled('^(a+)+$').test(`${'a'.repeat(5_000)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('counting asks no more than atMost of the input', () => {
    onRe2();
    // Every match of `x.*y|x` reads to the end of the input: counting all
    // 16,000 takes seconds; three, at once.
    const started = performance.now();
    expect(compiled('x.*y|x').count('x'.repeat(16_000), 3)).toBe(3);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('tenantPatternSyntaxProblem: compileTenantPattern’s verdict on the syntax, without RE2’s program', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['^a+$', ''],
    [']', ''],
    [']', 'u'],
    ['a{', ''],
    ['(?=a)', ''],
    ['(?<!a)b', ''],
    ['(a)\\1', ''],
    ['(?<n>a)\\k<n>', ''],
    ['\\p{L}', ''],
    ['\\p{L}', 'u'],
    ['[', ''],
    ['[]', ''],
    ['\\u0041', ''],
    ['a', 'v'],
    ['a', 'gg'],
    ['a'.repeat(1_025), ''],
  ];

  test.each([
    ['hosted', HOSTED_BOUNDS],
    ['self-hosted', SELF_HOSTED_BOUNDS],
  ] as const)('%s: the same verdict, for the same reason', (_, bounds) => {
    restore = overrideTenantInputBounds(bounds);
    for (const [source, flags] of cases) {
      const result = compileTenantPattern(source, flags);
      expect(tenantPatternSyntaxProblem(source, flags), `/${source}/${flags}`).toBe(
        result.kind === 'refused' ? result.reason : undefined,
      );
    }
  });

  test('on RE2: the flags decide the syntax, as they do when it’s compiled', () => {
    onRe2();
    expect(tenantPatternSyntaxProblem(']')).toBeUndefined();
    expect(tenantPatternSyntaxProblem(']', 'u')).toBe(refusal(']', 'u'));
    expect(tenantPatternSyntaxProblem('\\p{L}', 'u')).toBeUndefined();
    expect(tenantPatternSyntaxProblem('\\p{L}')).toBe(refusal('\\p{L}'));
  });

  test.each([
    ['a{1001}', ''],
    ['\\N', ''],
    ['[\\b]', ''],
    ['\\cA', ''],
    ['\\p{Letter}', 'u'],
  ])(
    'on RE2: /%s/%s, refused only as RE2 builds it, passes, and compiling it refuses it',
    (source, flags) => {
      onRe2();
      expect(tenantPatternSyntaxProblem(source, flags)).toBeUndefined();
      expect(refusal(source, flags)).toContain('RE2, the engine patterns run on here, refuses it');
    },
  );
});
