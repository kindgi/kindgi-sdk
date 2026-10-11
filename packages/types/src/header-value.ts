// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whether fetch can send a value in a header. Fetch trims leading and
 * trailing whitespace (tab, space, CR, LF), then throws on a NUL or a line
 * break with an error that quotes the value: `Headers.append: "<value>" is an
 * invalid header value.` It throws on a character above U+00FF too, and the
 * request refuses any other control character. A secret sent in a header is
 * checked with this first, so a bad one is refused by the header's name and
 * never quoted into an error, a log or a run.
 *
 * Check the value **as it's sent**: `Bearer ` and a secret that starts with a
 * line break make that break an inner one, which fetch refuses
 * (`bearerValueProblem`).
 */

/** Leading and trailing HTTP whitespace, which fetch trims before it checks. */
const EDGE_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/** Why fetch can't send `value` in a header, or `undefined` when it can. */
export function headerValueProblem(value: string): string | undefined {
  const sent = value.replace(EDGE_WHITESPACE, '');
  for (let i = 0; i < sent.length; i++) {
    const code = sent.charCodeAt(i);
    if (code === 0x0a || code === 0x0d) return 'a line break';
    if (code > 0xff) return 'a character above U+00FF';
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return 'a control character';
  }
  return undefined;
}

/**
 * Why fetch can't send `Bearer <token>` in `Authorization`, or `undefined`
 * when it can: the token checked as it's sent, after `Bearer `, where a
 * leading line break is an inner one.
 */
export function bearerValueProblem(token: string): string | undefined {
  return headerValueProblem(`Bearer ${token}`);
}
