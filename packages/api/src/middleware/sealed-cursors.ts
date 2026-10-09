// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import type { CursorContext, CursorSealer } from '../cursor-seal.js';
import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/**
 * Page cursors are sealed at the API's edge, for every list at once. A
 * GET's `cursor` is opened before any route reads it: a sealed one opens
 * to the position its list handed out, and one sealed for another list,
 * filter set or caller, tampered with, or expired, is `400 bad-input`. A
 * plain one passes as it is (a list still takes a position a client sends;
 * it hides what the caller can't read either way). A JSON answer's
 * `nextCursor` is sealed on its way out, so a cursor never shows the row
 * it points after, even one the list hid.
 */
export function sealedCursors(sealer: CursorSealer): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET') return next();
    const context = cursorContext(c);
    if (context === undefined) return next();
    c.set('cursorsSealed', true);
    const raw = c.req.query('cursor');
    if (raw !== undefined && raw !== '') {
      const opened = sealer.open(raw, context);
      if (opened.kind === 'refused') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message:
                opened.reason === 'expired'
                  ? '`cursor` has expired: start again without it'
                  : "`cursor` isn't from this list, for these filters and this caller: start again without it",
            },
            c.get('requestId'),
          ),
        );
      }
      if (opened.kind === 'sealed') {
        const url = new URL(c.req.url);
        url.searchParams.set('cursor', opened.cursor);
        c.req.raw = new Request(url, c.req.raw);
      }
    }
    await next();
    await sealNextCursor(c, sealer, context);
  };
}

/** The request's tenant, caller, list and filters; `undefined` before anyone is known. */
function cursorContext(c: Context<AppEnv>): CursorContext | undefined {
  const tenantId = c.get('tenantId');
  const actor = c.get('principal')?.actor;
  if (tenantId === undefined || actor === undefined) return undefined;
  const filters = [...new URL(c.req.url).searchParams.entries()]
    .filter(([name]) => name !== 'cursor' && name !== 'limit')
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join('&');
  return {
    tenantId: tenantId as unknown as string,
    principal: `${actor.kind}:${actor.id}`,
    list: c.req.path,
    filters,
  };
}

/** A `200` JSON answer with a `nextCursor`, answered again with it sealed. */
async function sealNextCursor(
  c: Context<AppEnv>,
  sealer: CursorSealer,
  context: CursorContext,
): Promise<void> {
  const res = c.res;
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('application/json')) {
    return;
  }
  const body = (await res
    .clone()
    .json()
    .catch(() => undefined)) as Record<string, unknown> | undefined;
  if (typeof body?.nextCursor !== 'string') return;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  const sealed = { ...body, nextCursor: sealer.seal(body.nextCursor, context) };
  // Cleared first: setting `c.res` over an answer merges that answer's headers in.
  c.res = undefined;
  c.res = new Response(JSON.stringify(sealed), { status: res.status, headers });
}
