// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Cursor + limit helpers per `docs/API-ROUTE-CONVENTIONS.md` §5.
 *
 * Cursors are opaque url-safe base64 of `{ createdAt: ISO, id: uuid }`.
 * The client MUST NOT parse the string; the server rebuilds it on each
 * page. Sort order is fixed per endpoint (documented per route); the
 * only tie-breaker is `id` so pagination is stable under equal
 * `createdAt`.
 */

export interface DecodedCursor {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeCursor(cursor: DecodedCursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Returns `null` on any decode failure — caller responds with 400 bad-input. */
export function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    return {
      createdAt: (parsed as DecodedCursor).createdAt,
      id: (parsed as DecodedCursor).id,
    };
  } catch {
    return null;
  }
}

/**
 * A cursor's time, as a list's binding compares it: Postgres's own text for
 * a `timestamptz` (`2026-10-09 12:00:00.123456+00`, microseconds, which a
 * binding gives as a page's exact position) or an ISO 8601 time (a cursor
 * from before, milliseconds).
 */
export function isCursorTime(value: string): boolean {
  return PG_TIMESTAMP_TEXT.test(value) || Number.isFinite(Date.parse(value));
}

const PG_TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function clampLimit(raw: string | undefined, def = 25, cap = 100): number {
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, cap);
}
