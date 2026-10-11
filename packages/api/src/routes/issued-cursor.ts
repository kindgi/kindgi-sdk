// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A list's cursor, checked with its binding's optional `issuedCursor`
 * before the list is read. A cursor the binding says it didn't issue
 * answers `400 bad-input`, as the blocks and tools `/versions` routes
 * answer one that isn't theirs (`versions-cursor.ts`): a list that read
 * it as no cursor would hand back the first page, and a client paging
 * until done would start over. A binding without `issuedCursor` gets any
 * cursor, as before.
 */

import type { Context } from 'hono';

import type { Cursor } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/** The `400` for a cursor `list` didn't issue, or `undefined` to read the list. */
export function refuseUnissuedCursor<L extends string>(
  c: Context<AppEnv>,
  binding: { issuedCursor?(list: L, cursor: Cursor): boolean },
  list: L,
  cursor: string | undefined,
): Response | undefined {
  if (cursor === undefined || cursor.length === 0) return undefined;
  if (binding.issuedCursor?.(list, cursor as Cursor) !== false) return undefined;
  c.status(statusFor('bad-input') as never);
  return c.json(
    toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, c.get('requestId')),
  );
}
