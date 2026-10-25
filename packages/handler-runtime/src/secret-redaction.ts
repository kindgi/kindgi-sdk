// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** What stands in for a call's secret in its error. */
const REDACTED = '[redacted]';

/**
 * A secret of fewer characters isn't looked for. It would turn up inside
 * ordinary words, and masking each of those would garble the message
 * without hiding the secret.
 */
export const MIN_SECRET_LENGTH = 4;

/**
 * How deep into an error its strings are looked at: each cause, and each
 * error, array or plain object it holds, is one level down. What's past
 * it is left out.
 */
const DEPTH = 8;

/** A property that can't be read or written out: the copy leaves it out. */
const LEFT_OUT: unique symbol = Symbol('left out');

/**
 * A pack call's error with the call's secrets taken out, before any text
 * is made of it. Each secret (a string of `MIN_SECRET_LENGTH` characters
 * or more; anything else in `secrets` is passed over) becomes `[redacted]`
 * wherever the error spells it: as it is, or escaped the way a JSON string
 * writes it, for a request body quoted in a message. Matches that overlap
 * or touch become one `[redacted]`.
 *
 * The first part of a secret counts too, when the text stops right after
 * it: at a line break, at the string's end, or just before `"...`, where
 * a quoted value was shortened. It must be `MIN_SECRET_LENGTH` characters
 * or more.
 *
 * It looks where `withoutConnectionTokens` (@kindgi/tools) does: every
 * string the error holds as its own, the errors, arrays and plain objects
 * it holds, and so on down its `cause` chain.
 *
 * What holds no secret comes back as it is. Each error, array and plain
 * object that does is copied, never changed: an error keeps its prototype
 * and every own property, so it's still what it was (a `DOMException` is
 * still one); an array stays an array. Any other object it holds is kept
 * as it is, unless its JSON form holds a secret: then that form, with the
 * secret taken out, stands in for it. A property that throws when read or
 * written out is left out, as is what's past the depth looked at. With no
 * secret to look for, the error itself comes back.
 */
export function withoutSecrets<E>(error: E, secrets: readonly unknown[]): E {
  const plain = [...new Set(secrets.filter(isLongEnough))];
  if (plain.length === 0) return error;
  // Each secret as it is, and as a JSON string writes it.
  const spellings = [
    ...new Set(plain.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])),
  ];
  const copy = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return mask(value, spellings);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= DEPTH) return undefined;
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        const out = held(item, depth + 1);
        return out === LEFT_OUT ? undefined : out;
      });
      return items.every((item, i) => Object.is(item, value[i])) ? value : items;
    }
    return copyOwn(value, (own) => held(own, depth + 1));
  };
  // What an error, array or plain object holds, its cause included:
  // another of those is looked at in turn; any other object is kept, or
  // written out with the secrets taken out.
  const held = (value: unknown, depth: number): unknown =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !isPlainObject(value)
      ? asJson(value, spellings)
      : copy(value, depth);
  return copy(error, 0) as E;
}

function isLongEnough(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_SECRET_LENGTH;
}

/**
 * `value` as it is when its JSON form spells no secret; else that form,
 * masked, read back. One that can't be written out or read back is left
 * out.
 */
function asJson(value: object, spellings: readonly string[]): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const masked = mask(json, spellings);
    return masked === json ? value : JSON.parse(masked);
  } catch {
    return LEFT_OUT;
  }
}

/**
 * `text` with every stretch a secret spells, whole or as a first part the
 * text stops after, replaced; stretches that overlap or touch become one
 * `[redacted]`.
 */
function mask(text: string, spellings: readonly string[]): string {
  const hidden = new Uint8Array(text.length);
  for (const spelling of spellings) {
    // Every place the secret's first characters appear: from each, how far
    // the text goes on spelling it.
    const opening = spelling.slice(0, MIN_SECRET_LENGTH);
    for (let at = text.indexOf(opening); at !== -1; at = text.indexOf(opening, at + 1)) {
      const run = spelledFrom(text, at, spelling);
      if (run === spelling.length || stopsAt(text, at + run)) hidden.fill(1, at, at + run);
    }
  }
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (hidden[i] === 0) out += text[i];
    else if (i === 0 || hidden[i - 1] === 0) out += REDACTED;
  }
  return out;
}

/** How many of `spelling`'s characters `text` has in order from `at`. */
function spelledFrom(text: string, at: number, spelling: string): number {
  let n = 0;
  while (n < spelling.length && text[at + n] === spelling[n]) n += 1;
  return n;
}

/** Whether `text` stops at `at`: its end, a line break, or a shortened quote's `"...`. */
function stopsAt(text: string, at: number): boolean {
  return (
    at === text.length || text[at] === '\n' || text[at] === '\r' || text.startsWith('"...', at)
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * `value` itself when `map` gives back everything it holds as it is; else
 * a copy with its prototype and every own property it can read, each value
 * as `map` gives it, one `map` leaves out not copied.
 *
 * A `DOMException` (a cancelled run's `AbortError`, an
 * `AbortSignal.timeout`'s `TimeoutError`) keeps its name and message where
 * only its prototype's accessors can read them, and those throw on a copy
 * made on that prototype: they're looked at too, and a copy is built anew
 * from them.
 */
function copyOwn(value: object, map: (own: unknown) => unknown): object {
  const { props, changed } = readOwn(value, map);
  if (value instanceof DOMException) {
    const name = String(map(value.name));
    const message = String(map(value.message));
    if (!changed && name === value.name && message === value.message) return value;
    return withProps(new DOMException(message, name), props);
  }
  if (!changed) return value;
  return withProps(Object.create(Object.getPrototypeOf(value) as object | null), props);
}

/**
 * Every own property of `value` it can read, as `map` gives it, one `map`
 * leaves out not kept; and whether any isn't what `value` holds.
 */
function readOwn(
  value: object,
  map: (own: unknown) => unknown,
): { props: [PropertyKey, PropertyDescriptor][]; changed: boolean } {
  const props: [PropertyKey, PropertyDescriptor][] = [];
  let changed = false;
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
    // An accessor (an engine's `stack`) is read once and kept as a value;
    // one that throws is left out.
    let own: unknown;
    try {
      own = 'value' in d ? d.value : Reflect.get(value, key);
    } catch {
      changed = true;
      continue;
    }
    const mapped = map(own);
    changed ||= !Object.is(mapped, own);
    if (mapped === LEFT_OUT) continue;
    props.push([
      key,
      {
        value: mapped,
        writable: d.writable ?? true,
        enumerable: d.enumerable ?? false,
        configurable: true,
      },
    ]);
  }
  return { props, changed };
}

function withProps(out: object, props: readonly [PropertyKey, PropertyDescriptor][]): object {
  for (const [key, d] of props) Object.defineProperty(out, key, d);
  return out;
}
