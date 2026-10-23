// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ToolConnection } from './connections.js';

/** What stands in for a connection's token in a failed call's error. */
export const REDACTED_TOKEN = '[redacted]';

/**
 * How deep into an error its strings are looked at: each cause, and each
 * error, array or plain object it holds, is one level down. What's past
 * it is left out.
 */
const DEPTH = 8;

/**
 * A failed call's error with each of the call's connection tokens
 * replaced by `[redacted]`: in every string the error holds as its own
 * (its message, its stack, a code or a detail), in the errors, arrays and
 * plain objects it holds (a pack error's `issues`, an `AggregateError`'s
 * `errors`, a `details` object), and so on down its `cause` chain. A tool
 * that echoes a token in what it throws then doesn't put it in the run's
 * events, its record or the model's view.
 *
 * Each error, array and plain object is copied, never changed: an error
 * keeps its prototype and every own property, so it's still what it was
 * (a `ConnectionRejectedError` is still one); an array stays an array.
 * Any other object it holds (a `Date`, a `Map`, a response) is kept as it
 * is. A property that throws when read is left out, as is what's past
 * the depth looked at. With no tokens, the error itself comes back.
 */
export function withoutConnectionTokens<E>(
  error: E,
  connections: readonly (Readonly<Record<string, ToolConnection>> | undefined)[],
): E {
  const tokens = [
    ...new Set(
      connections.flatMap((c) =>
        c === undefined ? [] : Object.values(c).map((connection) => connection.accessToken),
      ),
    ),
  ].filter((token) => token !== '');
  if (tokens.length === 0) return error;
  const copy = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redact(value, tokens);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= DEPTH) return undefined;
    if (Array.isArray(value)) return value.map((item) => held(item, depth + 1));
    return copyOwn(value, (key, own) =>
      key === 'cause' ? copy(own, depth + 1) : held(own, depth + 1),
    );
  };
  // What an error, array or plain object holds: another of those is
  // copied in turn; any other object is kept as it is.
  const held = (value: unknown, depth: number): unknown =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !isPlainObject(value)
      ? value
      : copy(value, depth);
  return copy(error, 0) as E;
}

/**
 * `text` with every stretch any of `tokens` covers replaced by one
 * `[redacted]`, so a token that starts or ends inside another leaves no
 * part of either.
 */
function redact(text: string, tokens: readonly string[]): string {
  const covered = new Uint8Array(text.length);
  for (const token of tokens) {
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
      covered.fill(1, at, at + token.length);
    }
  }
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (covered[i] === 0) out += text[i];
    else if (i === 0 || covered[i - 1] === 0) out += REDACTED_TOKEN;
  }
  return out;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of `value` with its prototype and every own property it can
 * read, each value as `map` gives it.
 */
function copyOwn(value: object, map: (key: string | symbol, own: unknown) => unknown): object {
  const out: object = Object.create(Object.getPrototypeOf(value) as object | null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
    // An accessor (an engine's `stack`) is read once and kept as a value;
    // one that throws is left out.
    let own: unknown;
    try {
      own = 'value' in d ? d.value : Reflect.get(value, key);
    } catch {
      continue;
    }
    Object.defineProperty(out, key, {
      value: map(key, own),
      writable: d.writable ?? true,
      enumerable: d.enumerable ?? false,
      configurable: true,
    });
  }
  return out;
}
