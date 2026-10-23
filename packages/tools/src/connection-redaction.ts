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

/** A property that can't be read or written out: the copy leaves it out. */
const LEFT_OUT: unique symbol = Symbol('left out');

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
 * Any other object it holds (a `Date`, a `Map`, a request) is kept as it
 * is, unless its JSON form, which is what a run writes of it, holds a
 * token: then that form, redacted, stands in for it. A property that
 * throws when read or written out is left out, as is what's past the
 * depth looked at. With no tokens, the error itself comes back.
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
  // Each token as it reads inside a JSON string.
  const written = [...new Set(tokens.map((token) => JSON.stringify(token).slice(1, -1)))];
  const copy = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redact(value, tokens);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= DEPTH) return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => {
        const out = held(item, depth + 1);
        return out === LEFT_OUT ? undefined : out;
      });
    }
    return copyOwn(value, (own) => held(own, depth + 1));
  };
  // What an error, array or plain object holds, its cause included:
  // another of those is copied in turn; any other object is kept, or
  // written out redacted.
  const held = (value: unknown, depth: number): unknown =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !isPlainObject(value)
      ? asWritten(value, written)
      : copy(value, depth);
  return copy(error, 0) as E;
}

/**
 * `value` as it is when its JSON form holds none of `written` (the tokens
 * as JSON writes them); else that form, redacted, read back. One that
 * can't be written out or read back is left out.
 */
function asWritten(value: object, written: readonly string[]): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || !written.some((token) => json.includes(token))) return value;
    return JSON.parse(redact(json, written));
  } catch {
    return LEFT_OUT;
  }
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
 * read, each value as `map` gives it; one `map` leaves out isn't copied.
 */
function copyOwn(value: object, map: (own: unknown) => unknown): object {
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
    const mapped = map(own);
    if (mapped === LEFT_OUT) continue;
    Object.defineProperty(out, key, {
      value: mapped,
      writable: d.writable ?? true,
      enumerable: d.enumerable ?? false,
      configurable: true,
    });
  }
  return out;
}
