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
 * is refused: `[]` and `[^]` (the start of a class to RE2) and `[:` in a
 * class (a POSIX class to RE2).
 *
 * Flags under RE2: `i`, `m`, `s` and `u` map to RE2's own; `y` anchors at
 * the start as it does from `lastIndex` 0; `g` and `d` change no answer
 * here. `v` is refused: RE2 has no set notation.
 */
export function compileTenantPattern(source: string, flags = ''): CompiledTenantPattern {
  const bounds = tenantInputBounds();
  const length = source.length + flags.length;
  if (length > bounds.patternMaxLength) {
    return {
      kind: 'refused',
      reason: `${length} characters with its flags, over the limit of ${bounds.patternMaxLength}`,
    };
  }
  return bounds.regex === 're2' ? compileRe2(source, flags) : compileV8(source, flags);
}

function compileV8(source: string, flags: string): CompiledTenantPattern {
  let once: RegExp;
  try {
    once = new RegExp(source, flags);
  } catch (error) {
    return { kind: 'refused', reason: (error as Error).message };
  }
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

function compileRe2(source: string, flags: string): CompiledTenantPattern {
  let re2Flags = 0;
  for (const [index, flag] of [...flags].entries()) {
    if (flags.indexOf(flag) !== index) {
      return { kind: 'refused', reason: `the \`${flag}\` flag is given twice` };
    }
    if (flag === 'v') {
      return { kind: 'refused', reason: `${RE2_ENGINE} has no \`v\` flag (set notation)` };
    }
    const mapped = RE2_FLAGS[flag];
    if (mapped === undefined) return { kind: 'refused', reason: `\`${flag}\` isn't a flag` };
    re2Flags |= mapped;
  }
  const unsupported = unsupportedOnRe2(source);
  if (unsupported !== undefined) return { kind: 'refused', reason: unsupported };
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
 * would call a lookbehind an "invalid named capture".
 */
function unsupportedOnRe2(source: string): string | undefined {
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1] ?? '';
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

/** The index after an empty match at `index`: past a whole surrogate pair when matching by code point. */
function after(input: string, index: number, byCodePoint: boolean): number {
  if (!byCodePoint) return index + 1;
  const code = input.codePointAt(index);
  return index + (code !== undefined && code > 0xffff ? 2 : 1);
}
