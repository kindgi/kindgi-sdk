// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Redaction, applied to every record before it's written, at every level.
 *
 *   1. **Keys.** A field whose key looks secret has its value replaced
 *      with `[redacted]`, at any depth: its key, lowercased with `-` and
 *      `_` removed, ends with `authorization`, `cookie`, `token`,
 *      `password`, `passwd`, `secret`, `secrets`, `apikey`, `privatekey`,
 *      `passphrase` or `credential(s)` (`accessToken`, `x-api-key`,
 *      `secrets`), plus any the caller adds. `tokenCount` and
 *      `promptTokens` are not secret, and stay.
 *   2. **Values.** Every string (the message, fields, an error's message
 *      and stack) is scrubbed of known shapes only, so ids are never
 *      mangled: a Kindgi token (`kgi_bt_…`, `kgi_pt_…`) keeps its prefix
 *      and its last four characters; `Bearer <anything>` becomes
 *      `Bearer [redacted]`; a URL's password (`postgres://user:pass@`)
 *      becomes `user:***@`.
 *
 * The first rule is the code rule's net: secret values are never fields
 * to begin with (pass a secret's name, not its value).
 */

import type { SerializedError } from './types.js';

export const REDACTED = '[redacted]';

/** What a value, or a field of one, is written as when reading it throws. */
const UNREADABLE = '[unreadable]';

const SECRET_KEY_ENDINGS: readonly string[] = [
  'authorization',
  'cookie',
  'token',
  'password',
  'passwd',
  'secret',
  'secrets',
  'apikey',
  'privatekey',
  'passphrase',
  'credential',
  'credentials',
];

const normalize = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

/** Whether a field's key looks secret (see rule 1). */
export function isSecretKey(key: string, extra: readonly string[] = []): boolean {
  const k = normalize(key);
  return [...SECRET_KEY_ENDINGS, ...extra.map(normalize)].some((end) => k.endsWith(end));
}

/**
 * A Kindgi token: `kgi_`, a kind of two or three letters (`bt`, `ak`, `sk`,
 * `pt`, `lk`, the license renewer's `lrk` and `lrp`), then its body.
 */
const KINDGI_TOKEN = /\bkgi_([a-z]{2,3})_([A-Za-z0-9._~+/=-]+)/g;
const BEARER = /\b(Bearer)\s+[^\s"',;]+/gi;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;

/** A string with known secret shapes masked (see rule 2). */
export function scrubText(text: string): string {
  return text
    .replace(KINDGI_TOKEN, (_m, kind: string, body: string) => {
      const tail = body.length >= 16 ? body.slice(-4) : '';
      return `kgi_${kind}_…${tail}`;
    })
    .replace(BEARER, '$1 [redacted]')
    .replace(URL_PASSWORD, '$1:***@');
}

const MAX_DEPTH = 8;

/**
 * `value[key]`, or `unreadable` (undefined unless given) when reading it
 * throws (a getter, a revoked proxy).
 */
function read(value: object, key: string, unreadable?: string): unknown {
  try {
    return (value as Readonly<Record<string, unknown>>)[key];
  } catch {
    return unreadable;
  }
}

/**
 * A copy of a call's fields (or a child's bindings), key by key, with a
 * field that throws when read as `[unreadable]`. When the keys can't be
 * listed (a revoked proxy), the copy has none.
 */
export function readFields(fields: object | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields === undefined || fields === null) return out;
  let keys: string[];
  try {
    keys = Object.keys(fields);
  } catch {
    return out;
  }
  for (const key of keys) out[key] = read(fields, key, UNREADABLE);
  return out;
}

/** A string or numeric `code`, as a string. */
function codeOf(err: object): { readonly code?: string } {
  const code = read(err, 'code');
  return typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {};
}

/** `value instanceof Error`, and false where asking throws (a revoked proxy). */
export function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * `String(value)`, for a value that isn't an error. One that can't be made
 * a string (no prototype, a throwing `toString`) is its
 * `Object.prototype.toString` tag, and a revoked proxy `[unreadable]`:
 * logging it never throws.
 */
function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return UNREADABLE;
    }
  }
}

/**
 * A plain object in an error's place (a storage error is
 * `{ code, message, cause }`): its name when that's a non-empty string
 * (else `Object`), its code and its message, and nothing else. Its own
 * cause isn't walked: a storage error's is the database driver's, whose
 * text can carry the query and the values it was bound to. With neither a
 * code nor a message, it's `String(err)`. A field that throws when read
 * counts as missing.
 */
function serializePlain(err: object): SerializedError | string {
  const name = read(err, 'name');
  const message = read(err, 'message');
  const code = codeOf(err);
  if (typeof message !== 'string' && code.code === undefined) return scrubText(textOf(err));
  return {
    name: typeof name === 'string' && name !== '' ? name : 'Object',
    message: typeof message === 'string' ? scrubText(message) : '',
    ...code,
  };
}

/**
 * An error as a record carries it: its name (else `Error`), its scrubbed
 * message (a message that isn't a string is its text, a missing one
 * empty), its code, its stack when asked for, and its causes, three deep.
 * Its other fields aren't written: a database error's carry the query and
 * the values bound to it. A field that throws when read counts as missing.
 */
export function serializeError(
  err: unknown,
  withStack: boolean,
  depth = 0,
): SerializedError | string {
  if (!isError(err)) {
    return typeof err === 'object' && err !== null ? serializePlain(err) : scrubText(textOf(err));
  }
  const name = read(err, 'name');
  const message = read(err, 'message');
  const stack = withStack ? read(err, 'stack') : undefined;
  const cause = read(err, 'cause');
  return {
    name: typeof name === 'string' && name !== '' ? name : 'Error',
    message: scrubText(typeof message === 'string' ? message : textOf(message ?? '')),
    ...codeOf(err),
    ...(typeof stack === 'string' && { stack: scrubText(stack) }),
    ...(cause !== undefined && depth < 3 && { cause: serializeError(cause, withStack, depth + 1) }),
  };
}

/**
 * A value with both rules applied, recursively: secret keys redacted,
 * strings scrubbed. Plain objects and arrays are copied; anything deeper
 * than a few levels, or a cycle (an object inside itself), becomes a
 * marker. An object referenced twice side by side is copied twice. An
 * error is serialized as `err` is, without its stack. A value that
 * throws when read (a getter, a revoked proxy) is `[unreadable]`, and so
 * is a field of one.
 */
export function redactValue(
  value: unknown,
  extraKeys: readonly string[] = [],
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (isError(value)) return serializeError(value, false);
  try {
    return redactObject(value, extraKeys, depth, seen);
  } catch {
    return UNREADABLE;
  }
}

function redactObject(
  value: object,
  extraKeys: readonly string[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[too deep]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        out.push(redactValue(read(value, String(i), UNREADABLE), extraKeys, depth + 1, seen));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = isSecretKey(key, extraKeys)
        ? REDACTED
        : redactValue(read(value, key, UNREADABLE), extraKeys, depth + 1, seen);
    }
    return out;
  } finally {
    // `seen` holds the path from the root: a cycle is an object inside itself.
    seen.delete(value);
  }
}
