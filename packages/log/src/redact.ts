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

export const REDACTED = '[redacted]';

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

/** A Kindgi token: `kgi_` and a two-letter kind, then its body. */
const KINDGI_TOKEN = /\bkgi_([a-z]{2})_([A-Za-z0-9._~+/=-]+)/g;
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
 * A value with both rules applied, recursively: secret keys redacted,
 * strings scrubbed. Plain objects and arrays are copied; anything deeper
 * than a few levels, or a cycle (an object inside itself), becomes a
 * marker. An object referenced twice side by side is copied twice.
 */
export function redactValue(
  value: unknown,
  extraKeys: readonly string[] = [],
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[too deep]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactValue(v, extraKeys, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key, extraKeys)
        ? REDACTED
        : redactValue(v, extraKeys, depth + 1, seen);
    }
    return out;
  } finally {
    // `seen` holds the path from the root: a cycle is an object inside itself.
    seen.delete(value);
  }
}
