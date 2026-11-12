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
 *   3. **The full mask,** for text more people read than a log's: a tool's
 *      error, on a run's record, in the console and in the model's view.
 *      A Kindgi token becomes `[redacted]` whole, with no prefix and no
 *      last four, and a URL's query or fragment value whose name looks
 *      secret becomes `[redacted]`, its name kept (`?token=`,
 *      `#access_token=`, `X-Amz-Signature=`, a SAS `sig=`, `?key=`).
 *      A record is never written with it.
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

/**
 * A Kindgi token: `kgi_`, a kind of two or three letters (`bt`, `ak`, `sk`,
 * `pt`, `lk`, the license renewer's `lrk` and `lrp`), then its body.
 */
const KINDGI_TOKEN = /\bkgi_([a-z]{2,3})_([A-Za-z0-9._~+/=-]+)/g;
const BEARER = /\b(Bearer)\s+[^\s"',;]+/gi;
/** A URL password's tail, from just after `://`: the user, `:`, the password, `@`. */
const URL_PASSWORD_TAIL = /([^\s:/@]+):[^\s@/]+@/y;
/** A URL's query or fragment parameter: `?`, `&` or `#`, its name, `=`, its value. */
const URL_PARAM_MARK = /[?&#]/g;
const URL_PARAM_NAME = /[^\s=&#"'<>]*/y;
const URL_PARAM_VALUE = /[^\s&#"'<>]*/y;
/**
 * More endings that make a parameter's name secret, on top of rule 1's: a
 * signed URL's signature (`X-Amz-Signature`, `X-Goog-Signature`, a SAS
 * `sig`).
 */
const PARAM_SECRET_ENDINGS: readonly string[] = ['signature', 'sig'];

/**
 * Whether a URL parameter's name looks secret: rule 1's endings and a
 * signature's, or exactly `key` (an API key, `?key=…`). Only exactly:
 * `sort_key` and `idempotency_key` are ids.
 */
function isSecretParam(name: string): boolean {
  return normalize(name) === 'key' || isSecretKey(name, PARAM_SECRET_ENDINGS);
}

/** `[a-z0-9+.-]`, either case: a URL scheme's characters. */
function isSchemeChar(c: number): boolean {
  return isLetter(c) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** `\w`, without the `u` flag: `[A-Za-z0-9_]`. */
function isWordChar(c: number): boolean {
  return isLetter(c) || (c >= 48 && c <= 57) || c === 95;
}

/**
 * `text` with each URL's password masked: `scheme://user:password@` becomes
 * `scheme://user:***@`. These are the matches of
 * `/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi`, found in time in
 * step with the text's length. That pattern tries a scheme from every word's
 * start, so its time grows with the square of a long run of scheme
 * characters.
 *
 * From each `://`, the scheme is walked back once, no further than the last
 * match's end. A match's scheme starts at a letter in that run with a word
 * break before it; which one doesn't change what's written.
 */
function maskUrlPasswords(text: string): string {
  let out = '';
  let last = 0;
  let at = text.indexOf('://');
  while (at !== -1) {
    let start = at;
    while (start > last && isSchemeChar(text.charCodeAt(start - 1))) start--;
    let scheme = false;
    for (let i = start; i < at && !scheme; i++) {
      scheme = isLetter(text.charCodeAt(i)) && (i === 0 || !isWordChar(text.charCodeAt(i - 1)));
    }
    URL_PASSWORD_TAIL.lastIndex = at + 3;
    const tail = scheme ? URL_PASSWORD_TAIL.exec(text) : null;
    if (tail === null) {
      at = text.indexOf('://', at + 1);
      continue;
    }
    const userEnd = at + 3 + (tail[1] ?? '').length;
    out += `${text.slice(last, userEnd)}:***@`;
    last = at + 3 + tail[0].length;
    at = text.indexOf('://', last);
  }
  return out + text.slice(last);
}

/**
 * `text` with each URL parameter whose name looks secret given the value
 * `[redacted]`, its name kept. These are the matches of
 * `/([?&#])([^\s=&#"'<>]+)=([^\s&#"'<>]*)/g`, found in time in step with the
 * text's length. That pattern tries a name from every `?` in a name, so its
 * time grows with the square of a long name.
 *
 * A name with no `=` after it fails from each `?` inside it too, at the same
 * end, so the search goes on from the name's end, that character included (it
 * may be the next `&` or `#`).
 */
function maskUrlParams(text: string): string {
  let out = '';
  let last = 0;
  URL_PARAM_MARK.lastIndex = 0;
  for (let mark = URL_PARAM_MARK.exec(text); mark !== null; mark = URL_PARAM_MARK.exec(text)) {
    URL_PARAM_NAME.lastIndex = mark.index + 1;
    const name = URL_PARAM_NAME.exec(text)?.[0] ?? '';
    const nameEnd = mark.index + 1 + name.length;
    URL_PARAM_MARK.lastIndex = nameEnd;
    if (name === '' || text[nameEnd] !== '=') continue;
    URL_PARAM_VALUE.lastIndex = nameEnd + 1;
    const value = URL_PARAM_VALUE.exec(text)?.[0] ?? '';
    const end = nameEnd + 1 + value.length;
    URL_PARAM_MARK.lastIndex = end;
    if (value !== '' && isSecretParam(name)) {
      out += `${text.slice(last, nameEnd + 1)}${REDACTED}`;
      last = end;
    }
  }
  return out + text.slice(last);
}

/**
 * A string with known secret shapes masked (see rule 2). With `fullMask`,
 * rule 3's: a Kindgi token whole, and a URL's secret parameters.
 */
export function scrubText(text: string, options: { readonly fullMask?: boolean } = {}): string {
  const full = options.fullMask === true;
  const scrubbed = maskUrlPasswords(
    text
      .replace(KINDGI_TOKEN, (_m, kind: string, body: string) => {
        if (full) return REDACTED;
        const tail = body.length >= 16 ? body.slice(-4) : '';
        return `kgi_${kind}_…${tail}`;
      })
      .replace(BEARER, '$1 [redacted]'),
  );
  if (!full) return scrubbed;
  return maskUrlParams(scrubbed);
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
