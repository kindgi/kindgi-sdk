// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A failed call's error with the call's own secret values taken out, for
 * the handler-throw answer. It's `withoutConnectionTokens`'s copy
 * (`@kindgi/tools`), for the values a call's `ctx.secrets` holds, plus a
 * value's start cut short.
 */

/** What stands in for a value. */
const REDACTED = '[redacted]';

/**
 * The shortest value replaced. A shorter one is left as it is: one to
 * three characters would shred the text around it (every `on` in a
 * message), and the gaps left would show the value anyway.
 */
export const SHORTEST_REPLACED = 4;

/**
 * How deep into an error its strings are looked at: each cause, and each
 * error, array or plain object it holds, is one level down. What's past
 * it is left out.
 */
const DEPTH = 8;

/** A property that can't be read or written out: the copy leaves it out. */
const LEFT_OUT: unique symbol = Symbol('left out');

/**
 * A thrown error with each of `values` replaced by `[redacted]`. The
 * values are what the call's `ctx.secrets` holds, which the handler's or
 * a service's own words may echo: a bad key quoted back, a connection
 * string in a `connect … failed`. The handler-throw answer's message is
 * built from the copy, so neither its masking, its one-line causes nor
 * their cut can leave part of a value where a match on the whole value
 * would no longer find it.
 *
 * A value is looked for as it is and as it reads inside a JSON string (a
 * quoted request body), in every string the error holds as its own (its
 * message, its stack, a code), in the errors, arrays and plain objects it
 * holds (an `AggregateError`'s `errors`), and so on down its `cause` chain.
 * Every stretch any value covers becomes one `[redacted]`, so a value
 * inside another, or overlapping it, leaves no part of either. So does the
 * start of one cut short, when that start is `SHORTEST_REPLACED`
 * characters or more: where a line or the text ends (a body cut at a
 * limit), or where `"...` follows it. A value shorter than that is left as
 * it is.
 *
 * What holds no value comes back as it is. Each error, array and plain
 * object that does is copied, never changed: an error keeps its prototype
 * and every own property, so it's still what it was; an array stays an
 * array. Any other object it holds (a `Date`, a `Map`, a request) is kept
 * as it is, unless its JSON form holds a value: then that form, redacted,
 * stands in for it. A property that throws when read or written out is
 * left out, as is what's past the depth looked at.
 */
export function withoutSecretValues<E>(error: E, values: readonly unknown[]): E {
  const kept = [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.length >= SHORTEST_REPLACED,
      ),
    ),
  ];
  if (kept.length === 0) return error;
  // Each value as it reads inside a JSON string.
  const written = [...new Set(kept.map((value) => JSON.stringify(value).slice(1, -1)))];
  const forms = [...new Set([...kept, ...written])];
  const copy = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redact(value, forms);
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
 * `value` as it is when its JSON form holds none of `written` (the values
 * as JSON writes them); else that form, redacted, read back. One that
 * can't be written out or read back is left out.
 */
function asWritten(value: object, written: readonly string[]): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || !written.some((form) => json.includes(form))) return value;
    return JSON.parse(redact(json, written));
  } catch {
    return LEFT_OUT;
  }
}

/**
 * `text` with every stretch any of `forms` covers replaced by one
 * `[redacted]`, so a value that starts or ends inside another leaves no
 * part of either; and with each start of one cut short at a line's end,
 * the text's end or before `"...`.
 */
function redact(text: string, forms: readonly string[]): string {
  const covered = new Uint8Array(text.length);
  for (const form of forms) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      covered.fill(1, at, at + form.length);
    }
  }
  for (const end of cutEnds(text)) {
    for (const form of forms) {
      const start = cutStart(text, end, form);
      if (start !== undefined) covered.fill(1, start, end);
    }
  }
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (covered[i] === 0) out += text[i];
    else if (i === 0 || covered[i - 1] === 0) out += REDACTED;
  }
  return out;
}

/** Where a value can have been cut short: each line's end, before `"...`, the text's end. */
function cutEnds(text: string): number[] {
  const ends: number[] = [text.length];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n' || text[i] === '\r' || text.startsWith('"...', i)) ends.push(i);
  }
  return ends;
}

/**
 * Where the longest start of `form` that ends at `end` begins, when it's
 * `SHORTEST_REPLACED` characters or more and shorter than the whole form.
 */
function cutStart(text: string, end: number, form: string): number | undefined {
  for (let length = Math.min(form.length - 1, end); length >= SHORTEST_REPLACED; length -= 1) {
    if (text.startsWith(form.slice(0, length), end - length)) return end - length;
  }
  return undefined;
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
