// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { codeOf, fieldOf, isError, textOf } from './error-fields.js';
import { scrubText } from './redact.js';

/** How many causes are said: the error and three below it, as a log record's `err` has. */
const CAUSES = 3;

/** The most characters a cause is said in, `…` included. */
export const MAX_CAUSE_CHARS = 500;

/**
 * What an error's causes add to its message: `''` when it has none, else
 * `; caused by <Name> [<code>]: <message>` for each, in order. A tool's
 * error then says why, where the error alone says only `fetch failed`:
 *
 * ```text
 * fetch failed; caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)
 * ```
 *
 * - **`Name [code]: message`** is Node's own form. The code is left out
 *   when the cause's message already holds it (`connect ECONNREFUSED …`),
 *   and the message when it's empty.
 * - **An `AggregateError` with an empty message** says its `errors`'
 *   messages instead, joined by `, `: Node's refused connection is
 *   `AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:4000, connect
 *   ECONNREFUSED 127.0.0.1:4000`.
 * - **Three causes at most** are looked at. One whose message its effect's
 *   message already holds, its code too when it has one, is passed over
 *   and the next is looked at; one with an empty message never is. An
 *   error met a second time (a cycle) ends the walk.
 * - **A plain object** with a string `message` or a code is said like an
 *   error, named `Object` unless it has a name, and its own `cause` isn't
 *   looked at: a storage error's is the database driver's, whose text can
 *   carry the query and the values it was bound to. A string is said as it
 *   is; any other value as `String(value)`. `null` ends the walk.
 * - **Each cause is masked with `scrubText`'s full mask, then made one
 *   line,** then cut to {@link MAX_CAUSE_CHARS} characters with `…`. The
 *   cut never splits a word, so no part of a token shows past it; a word
 *   longer than the cut is left out whole.
 *
 * A value that isn't an error has no causes: `''`. It never throws.
 */
export function describeCauses(err: unknown): string {
  try {
    if (!isError(err)) return '';
    let parts = '';
    let effect = messageText(err);
    const seen = new Set<unknown>([err]);
    let cause = fieldOf(err, 'cause');
    for (let looked = 0; looked < CAUSES; looked += 1) {
      if (cause === undefined || cause === null || seen.has(cause)) break;
      seen.add(cause);
      const said = causeOf(cause);
      if (!passedOver(said, effect)) parts += `; caused by ${shown(said.text)}`;
      effect = said.message;
      if (said.next === undefined) break;
      cause = said.next;
    }
    return parts;
  } catch {
    return '';
  }
}

/** One cause: what's said of it, its own message and code, and what's below it. */
interface Cause {
  readonly text: string;
  readonly message: string;
  readonly code?: string;
  readonly next?: unknown;
}

function causeOf(cause: unknown): Cause {
  if (typeof cause === 'string') return { text: cause, message: cause };
  const error = isError(cause);
  if (!error && !errorLike(cause)) {
    const text = textOf(cause);
    return { text, message: text };
  }
  const message = messageText(cause);
  const { code } = codeOf(cause);
  const words = message === '' && isAggregate(cause) ? aggregateText(cause) : message;
  const coded = code !== undefined && !message.includes(code) ? ` [${code}]` : '';
  return {
    text: `${labelOf(cause, error)}${coded}${words === '' ? '' : `: ${words}`}`,
    message,
    ...(code !== undefined && { code }),
    ...(error && { next: fieldOf(cause, 'cause') }),
  };
}

/** A plain object said like an error: one with a string `message` or a code. */
function errorLike(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  return typeof fieldOf(value, 'message') === 'string' || codeOf(value).code !== undefined;
}

/** Its name when that's a non-empty string, else `Error` or `Object`. */
function labelOf(cause: object, error: boolean): string {
  const name = fieldOf(cause, 'name');
  if (typeof name === 'string' && name !== '') return name;
  return error ? 'Error' : 'Object';
}

/**
 * Whether a cause adds nothing to its effect: its message isn't empty and
 * the effect's message holds it, and its code too when it has one.
 */
function passedOver(cause: Cause, effect: string): boolean {
  if (cause.message === '' || !effect.includes(cause.message)) return false;
  return cause.code === undefined || effect.includes(cause.code);
}

function messageText(err: object): string {
  const message = fieldOf(err, 'message');
  return typeof message === 'string' ? message : '';
}

function isAggregate(err: object): boolean {
  try {
    return err instanceof AggregateError && Array.isArray(fieldOf(err, 'errors'));
  } catch {
    return false;
  }
}

/** An `AggregateError`'s `errors`, each one's message once, joined by `, `. */
function aggregateText(err: object): string {
  const errors = fieldOf(err, 'errors') as readonly unknown[];
  const messages: string[] = [];
  for (const each of errors) {
    const message = typeof each === 'object' && each !== null ? messageText(each) : textOf(each);
    if (message !== '' && !messages.includes(message)) messages.push(message);
  }
  return messages.join(', ');
}

/** A cause's text masked, on one line, cut short. */
function shown(text: string): string {
  return cut(oneLine(scrubText(text, { fullMask: true })));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * `text` at {@link MAX_CAUSE_CHARS} characters at most, `…` included. A
 * cut that lands inside a word goes back to the space before it.
 */
function cut(text: string): string {
  if (text.length <= MAX_CAUSE_CHARS) return text;
  const end = MAX_CAUSE_CHARS - 1;
  const inWord = text[end] !== ' ' && text[end - 1] !== ' ';
  const kept = inWord
    ? text.slice(0, Math.max(0, text.lastIndexOf(' ', end - 1)))
    : text.slice(0, end);
  return `${kept.trimEnd()}…`;
}
