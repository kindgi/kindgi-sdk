// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Sealed page cursors. A list's binding pages by a position it can read
 * (a row's time and id); handed out as is, that position can name a row
 * the caller may not read, when the list hides rows after fetching them.
 * Sealed, the cursor says nothing: the position is encrypted and
 * authenticated (AES-256-GCM) with the runtime's pagination key, bound to
 * the tenant, the caller, the list and its filters, and good for a day.
 *
 * Envelope: `k1.<kid>.<nonce>.<ciphertext+tag>`, base64url, where the
 * plaintext is `{"c": <the position>, "t": <issued, epoch ms>}` and the
 * associated data is the context. `kid` names the key that sealed it, so a
 * key can be rotated: the first key seals, any listed key opens.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** A pagination key: 32 bytes, named so a cursor says which one sealed it. */
export interface CursorKey {
  /** 1–32 characters of `[A-Za-z0-9_-]`. */
  readonly kid: string;
  readonly key: Uint8Array;
}

/** What a sealed cursor is bound to: it opens only in the same context. */
export interface CursorContext {
  readonly tenantId: string;
  /** The caller, as `<kind>:<id>`. */
  readonly principal: string;
  /** The list: the request's path. */
  readonly list: string;
  /** The list's filters: its query parameters other than `cursor` and `limit`, sorted. */
  readonly filters: string;
}

export type OpenedCursor =
  /** A sealed cursor of this context: the position it holds. */
  | { readonly kind: 'sealed'; readonly cursor: string }
  /** Not a sealed cursor: a position a client sent as is, which a list still takes. */
  | { readonly kind: 'plain' }
  /** Sealed, but not for this context (or by an unknown key), tampered with, or expired. */
  | { readonly kind: 'refused'; readonly reason: 'expired' | 'foreign' };

export interface CursorSealer {
  seal(cursor: string, context: CursorContext): string;
  open(raw: string, context: CursorContext): OpenedCursor;
}

/** How long a sealed cursor opens: a day, enough for any paging, short of keeping. */
export const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

const PREFIX = 'k1.';
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A sealer over `keys`: the first seals, every one opens. */
export function createAeadCursorSealer(options: {
  readonly keys: readonly CursorKey[];
  readonly ttlMs?: number;
  readonly now?: () => number;
}): CursorSealer {
  const [current] = options.keys;
  if (current === undefined) throw new Error('A cursor sealer needs at least one key');
  const byKid = new Map<string, Uint8Array>();
  for (const { kid, key } of options.keys) {
    if (!KID.test(kid)) throw new Error(`Cursor key id "${kid}" must be 1–32 of [A-Za-z0-9_-]`);
    if (key.length !== 32)
      throw new Error(`Cursor key "${kid}" must be 32 bytes, not ${key.length}`);
    if (byKid.has(kid)) throw new Error(`Cursor key id "${kid}" is listed twice`);
    byKid.set(kid, key);
  }
  const ttlMs = options.ttlMs ?? CURSOR_TTL_MS;
  const now = options.now ?? Date.now;

  return {
    seal(cursor, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', current.key, nonce);
      cipher.setAAD(associated(context));
      const body = Buffer.concat([
        cipher.update(JSON.stringify({ c: cursor, t: now() }), 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return `${PREFIX}${current.kid}.${nonce.toString('base64url')}.${body.toString('base64url')}`;
    },
    open(raw, context) {
      if (!raw.startsWith(PREFIX)) return { kind: 'plain' };
      const issued = decrypt(byKid, raw.slice(PREFIX.length), context);
      if (issued === undefined) return { kind: 'refused', reason: 'foreign' };
      const age = now() - issued.t;
      // A cursor from the future (a clock moved back) is as stale as an old one.
      if (age > ttlMs || age < -60_000) return { kind: 'refused', reason: 'expired' };
      return { kind: 'sealed', cursor: issued.c };
    },
  };
}

/** The context as the AEAD's associated data. */
function associated(context: CursorContext): Buffer {
  return Buffer.from(
    JSON.stringify([context.tenantId, context.principal, context.list, context.filters]),
    'utf8',
  );
}

/** `<kid>.<nonce>.<body>` opened, or `undefined` for anything that doesn't authenticate. */
function decrypt(
  keys: ReadonlyMap<string, Uint8Array>,
  rest: string,
  context: CursorContext,
): { readonly c: string; readonly t: number } | undefined {
  const [kid, nonceText, bodyText, extra] = rest.split('.');
  if (
    kid === undefined ||
    nonceText === undefined ||
    bodyText === undefined ||
    extra !== undefined
  ) {
    return undefined;
  }
  const key = keys.get(kid);
  const nonce = Buffer.from(nonceText, 'base64url');
  const body = Buffer.from(bodyText, 'base64url');
  if (key === undefined || nonce.length !== NONCE_BYTES || body.length <= TAG_BYTES)
    return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associated(context));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    const text = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(text) as { c?: unknown; t?: unknown };
    return typeof parsed.c === 'string' && typeof parsed.t === 'number'
      ? { c: parsed.c, t: parsed.t }
      : undefined;
  } catch {
    return undefined;
  }
}
