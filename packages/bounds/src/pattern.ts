// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { RE2JS, RE2JSException, RE2JSSyntaxException } from 're2js';

import { tenantInputBounds } from './bounds.js';

/**
 * A tenant's pattern, compiled for the engine the process's bounds name.
 * Both answers are those of the JavaScript `RegExp` it was written as,
 * starting from the beginning of `input` each time (`lastIndex` 0).
 */
export interface TenantPattern {
  /** Whether it matches in `input`: anywhere, or at the start under the `y` flag. */
  test(input: string): boolean;
  /**
   * How many times it matches in `input`, one after another without
   * overlapping, as `input.match()` with the `g` flag counts them. It stops
   * counting at `atMost`: a caller that needs "at least n" asks for n, so a
   * long input costs no more than that.
   */
  count(input: string, atMost?: number): number;
}

export type CompiledTenantPattern =
  | { readonly kind: 'ok'; readonly pattern: TenantPattern }
  /** Why it can't run here: a fragment that reads after a colon, with no full stop. */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Compiles a pattern a tenant wrote (a JavaScript regular expression's
 * source and flags) under the process's bounds: no longer than
 * `patternMaxLength` with its flags, on V8's engine or on RE2's.
 *
 * Under RE2 (the hosted profile), a pattern runs in linear time in its
 * input. The price is what RE2 doesn't have, refused by name:
 * backreferences, lookahead and lookbehind. A few things also read
 * differently, the same way for every pattern (the package README lists
 * them): RE2 always matches by code point and folds case as the `u` flag
 * does; `.` stops only at `\n`, and with `m`, `^` and `$` only around
 * `\n`; `\s` is ASCII whitespace. What RE2 would silently read otherwise
 * is refused: `[]` and `[^]` (the start of a class to RE2), `[:` in a
 * class (a POSIX class to RE2) and, without the `u` flag, the escapes
 * JavaScript reads as the letter itself (`\p`, `\P`, `\A`, `\z`, `\Q`,
 * `\a`, `\x{`). So is `\u`, which RE2 doesn't have. And it accepts only
 * what `RegExp` accepts: a pattern V8 refuses is refused in V8's words, even
 * where RE2 would compile it (`(?i)`, `(?P<n>…)`).
 *
 * Flags under RE2: `i`, `m`, `s` and `u` map to RE2's own; `y` anchors at
 * the start as it does from `lastIndex` 0; `g` and `d` change no answer
 * here. `v` is refused: RE2 has no set notation.
 */
export function compileTenantPattern(source: string, flags = ''): CompiledTenantPattern {
  const bounds = tenantInputBounds();
  const tooLong = lengthProblem(source, flags);
  if (tooLong !== undefined) return { kind: 'refused', reason: tooLong };
  return bounds.regex === 're2' ? compileRe2(source, flags) : compileV8(source, flags);
}

/**
 * Why `compileTenantPattern` would refuse `source` with `flags` for its
 * syntax, or `undefined` when it wouldn't: over `patternMaxLength`, what
 * `RegExp` refuses and, under RE2, a flag or a construct RE2 doesn't have
 * or reads otherwise. It builds no RE2 program, so it costs about what
 * V8's parse does. A pattern RE2 refuses only as it builds the program
 * passes here, and is refused when it's compiled: one too large (a
 * repeat over 1,000, say), or with an escape RE2 doesn't have that this
 * check doesn't name (`\N`, `[\b]`, `\cA`, a long property name such as
 * `\p{Letter}`).
 */
export function tenantPatternSyntaxProblem(source: string, flags = ''): string | undefined {
  const tooLong = lengthProblem(source, flags);
  if (tooLong !== undefined) return tooLong;
  if (tenantInputBounds().regex !== 're2') {
    const parsed = parse(source, flags);
    return typeof parsed === 'string' ? parsed : undefined;
  }
  const re2Flags = re2FlagsFor(flags);
  return typeof re2Flags === 'string' ? re2Flags : re2SyntaxProblem(source, flags);
}

/** Why `source` with `flags` is over `patternMaxLength`, or `undefined`. */
function lengthProblem(source: string, flags: string): string | undefined {
  const max = tenantInputBounds().patternMaxLength;
  const length = source.length + flags.length;
  return length > max ? `${length} characters with its flags, over the limit of ${max}` : undefined;
}

/** `source` with `flags` as V8 parses it, or V8's reason for refusing it. */
function parse(source: string, flags: string): RegExp | string {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    return (error as Error).message;
  }
}

function compileV8(source: string, flags: string): CompiledTenantPattern {
  const once = parse(source, flags);
  if (typeof once === 'string') return { kind: 'refused', reason: once };
  const every = flags.includes('g') ? once : new RegExp(source, `${flags}g`);
  const byCodePoint = flags.includes('u') || flags.includes('v');
  return {
    kind: 'ok',
    pattern: {
      test(input) {
        once.lastIndex = 0;
        return once.test(input);
      },
      count(input, atMost = Number.POSITIVE_INFINITY) {
        every.lastIndex = 0;
        let found = 0;
        while (found < atMost) {
          const match = every.exec(input);
          if (match === null) break;
          found += 1;
          // As `match()` steps past an empty match, so the next one can't be the same.
          if (match[0] === '') every.lastIndex = after(input, every.lastIndex, byCodePoint);
        }
        return found;
      },
    },
  };
}

const RE2_ENGINE = 'RE2, the engine patterns run on here,';

const RE2_FLAGS: Readonly<Record<string, number>> = {
  i: RE2JS.CASE_INSENSITIVE,
  m: RE2JS.MULTILINE,
  s: RE2JS.DOTALL,
  u: 0,
  g: 0,
  d: 0,
  y: 0,
};

/** RE2's flags for `flags`, or why there are none. */
function re2FlagsFor(flags: string): number | string {
  let re2Flags = 0;
  for (const [index, flag] of [...flags].entries()) {
    if (flags.indexOf(flag) !== index) return `the \`${flag}\` flag is given twice`;
    if (flag === 'v') return `${RE2_ENGINE} has no \`v\` flag (set notation)`;
    const mapped = RE2_FLAGS[flag];
    if (mapped === undefined) return `\`${flag}\` isn't a flag`;
    re2Flags |= mapped;
  }
  return re2Flags;
}

/**
 * Why RE2 can't run `source` with `flags` as JavaScript reads it, for its
 * syntax; `undefined` when it can. What `RegExp` accepts, never more: RE2
 * compiles `(?i)`, `(?P<n>…)` and, with `u`, `\pL` or `\x{41}`, which V8
 * refuses. Constructing it only parses (it never matches), and the pattern
 * is already within its length.
 */
function re2SyntaxProblem(source: string, flags: string): string | undefined {
  const parsed = parse(source, flags);
  if (typeof parsed === 'string') return parsed;
  return unsupportedOnRe2(source, flags.includes('u'));
}

function compileRe2(source: string, flags: string): CompiledTenantPattern {
  const re2Flags = re2FlagsFor(flags);
  if (typeof re2Flags === 'string') return { kind: 'refused', reason: re2Flags };
  const problem = re2SyntaxProblem(source, flags);
  if (problem !== undefined) return { kind: 'refused', reason: problem };
  let re: RE2JS;
  try {
    re = RE2JS.compile(source, re2Flags);
  } catch (error) {
    if (!(error instanceof RE2JSException)) throw error;
    const detail =
      error instanceof RE2JSSyntaxException
        ? error.message.replace(/^error parsing regexp: /, '')
        : error.message;
    return { kind: 'refused', reason: `${RE2_ENGINE} refuses it: ${detail}` };
  }
  const sticky = flags.includes('y');
  return {
    kind: 'ok',
    pattern: {
      test(input) {
        return sticky ? re.matcher(input).lookingAt() : re.test(input);
      },
      count(input, atMost = Number.POSITIVE_INFINITY) {
        const matcher = re.matcher(input);
        let found = 0;
        let from = 0;
        while (found < atMost && from <= input.length && matcher.find(from)) {
          const start = matcher.start();
          const end = matcher.end();
          if (sticky && start !== from) break;
          found += 1;
          from = end === start ? after(input, end, true) : end;
        }
        return found;
      },
    },
  };
}

/**
 * What RE2 doesn't have, or reads differently from JavaScript, by name
 * and where it is; `undefined` when there's none. RE2's own messages
 * would call a lookbehind an "invalid named capture". It runs on a
 * pattern `RegExp` has already parsed with the same flags (`unicode`: `u`).
 */
function unsupportedOnRe2(source: string, unicode: boolean): string | undefined {
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      if (next === 'u') {
        return `${RE2_ENGINE} has no \`\\u\` escapes: write the character itself (at index ${i})`;
      }
      const misread = unicode ? undefined : RE2_READS_OTHERWISE[next];
      if (misread !== undefined && (next !== 'x' || source[i + 2] === '{')) {
        const written = next === 'x' ? '\\x{' : `\\${next}`;
        return `${RE2_ENGINE} reads \`${written}\` as ${misread}, where JavaScript without the \`u\` flag reads the letter \`${next}\` (at index ${i})`;
      }
      if (!inClass && next >= '1' && next <= '9') {
        return `${RE2_ENGINE} has no backreferences (\`\\${next}\` at index ${i})`;
      }
      if (!inClass && next === 'k' && source[i + 2] === '<') {
        return `${RE2_ENGINE} has no backreferences (\`\\k<\` at index ${i})`;
      }
      i += 1;
    } else if (inClass) {
      if (c === ']') inClass = false;
      else if (c === '[' && source[i + 1] === ':') {
        return `${RE2_ENGINE} reads \`[:\` in a class as a POSIX class such as \`[:alpha:]\`, not as JavaScript does (at index ${i})`;
      }
    } else if (c === '[') {
      const first = source[i + 1] === '^' ? i + 2 : i + 1;
      if (source[first] === ']') {
        return `${RE2_ENGINE} reads \`${source.slice(i, first + 1)}\` as the start of a class, not as JavaScript does (at index ${i})`;
      }
      inClass = true;
      i = first - 1;
    } else if (c === '(' && source[i + 1] === '?') {
      const look = LOOKAROUND.find((l) => source.startsWith(l, i));
      if (look !== undefined) {
        return `${RE2_ENGINE} has no lookahead or lookbehind (\`${look}\` at index ${i})`;
      }
    }
  }
  return undefined;
}

const LOOKAROUND = ['(?=', '(?!', '(?<=', '(?<!'] as const;

/** Escapes JavaScript without `u` reads as the letter itself, and RE2 as something else. */
const RE2_READS_OTHERWISE: Readonly<Record<string, string>> = {
  p: 'a Unicode class',
  P: 'a negated Unicode class',
  A: 'the start of the text',
  z: 'the end of the text',
  Q: 'the start of a quoted literal (`\\Q…\\E`)',
  a: 'the bell character',
  x: 'the start of a code point (`\\x{41}`)',
};

/** The index after an empty match at `index`: past a whole surrogate pair when matching by code point. */
function after(input: string, index: number, byCodePoint: boolean): number {
  if (!byCodePoint) return index + 1;
  const code = input.codePointAt(index);
  return index + (code !== undefined && code > 0xffff ? 2 : 1);
}
