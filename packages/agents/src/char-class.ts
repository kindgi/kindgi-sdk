// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The character tests the text scans share, by UTF-16 code. Each says what
 * a pattern's class says without the `u` flag, so ASCII only: `\w` and `\b`
 * know no other letters.
 */

/** `[A-Za-z]`. */
export function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** `\w`, without the `u` flag: `[A-Za-z0-9_]`. */
export function isWordChar(c: number): boolean {
  return isLetter(c) || (c >= 48 && c <= 57) || c === 95;
}

/** `[a-z0-9+.-]`, either case: a URL scheme's characters. */
export function isSchemeChar(c: number): boolean {
  return isLetter(c) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
}

/** `[a-z0-9_-]`, either case: a dotted id's segment. */
export function isSegmentChar(c: number): boolean {
  return isWordChar(c) || c === 45;
}

/** Whether a word character at `at` starts a word: `\b` before it. */
export function startsWord(text: string, at: number): boolean {
  return at === 0 || !isWordChar(text.charCodeAt(at - 1));
}
