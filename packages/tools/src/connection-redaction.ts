// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ToolConnection } from './connections.js';

/** What stands in for a connection's token in a failed call's error. */
export const REDACTED_TOKEN = '[redacted]';

/** How far down an error's causes its strings are looked at; a cause past it is left out. */
const CAUSE_DEPTH = 8;

/**
 * A failed call's error with each of the call's connection tokens
 * replaced by `[redacted]`: in every string the error holds as its own
 * (its message, its stack, a code or a detail), and so on down its
 * `cause` chain. A tool that echoes a token in what it throws then
 * doesn't put it in the run's events, its record or the model's view.
 *
 * Each error is copied, never changed: the copy keeps its prototype and
 * every own property, so it's still what it was (a
 * `ConnectionRejectedError` is still one). A cause past the depth looked
 * at is left out. With no tokens, the error itself comes back.
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
  const scrub = (text: string): string =>
    tokens.reduce((out, token) => out.split(token).join(REDACTED_TOKEN), text);
  const copy = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= CAUSE_DEPTH) return undefined;
    return copyOwn(value, (key, own) =>
      key === 'cause' ? copy(own, depth + 1) : typeof own === 'string' ? scrub(own) : own,
    );
  };
  return copy(error, 0) as E;
}

/** A copy of `value` with its prototype and every own property, each value as `map` gives it. */
function copyOwn(value: object, map: (key: string | symbol, own: unknown) => unknown): object {
  const out: object = Object.create(Object.getPrototypeOf(value) as object | null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
    // An accessor (an engine's `stack`) is read once and kept as a value.
    const own: unknown = 'value' in d ? d.value : Reflect.get(value, key);
    Object.defineProperty(out, key, {
      value: map(key, own),
      writable: d.writable ?? true,
      enumerable: d.enumerable ?? false,
      configurable: true,
    });
  }
  return out;
}
