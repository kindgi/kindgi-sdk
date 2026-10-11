// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { statusFor, toWireError } from '../errors.js';
import type { SiteBinding } from '../site-binding.js';
import type { AppEnv } from '../types.js';

/**
 * The two routes a site calls before anyone is signed in, mounted outside
 * the bearer chain:
 *
 * - `POST /v1/auth/sites/enroll`: the site posts its public key with a
 *   one-time enrollment code, and learns its id and the audience its
 *   statements carry;
 * - `POST /v1/auth/site-sign-in`: a person's statement, signed by the
 *   site, for a session limited to the site's project.
 *
 * Both are thin: a size cap and a shape check here, everything else in
 * the deployment's binding (limits, keys, signature, people, sessions).
 * A bearer token, if sent, is never read.
 */
export interface SiteAuthRouteOptions {
  readonly binding: SiteBinding;
  /**
   * The client's address, as the deployment knows it (the socket's, or past
   * its trusted proxies), for the binding's limit on failures per address.
   */
  readonly clientAddress?: (request: Request) => string | undefined;
}

/** The most a request body may be: a statement is a few hundred bytes. */
export const SITE_REQUEST_MAX_BYTES = 4096;

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function siteEnrollRouter(options: SiteAuthRouteOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/', async (c) => {
    const body = await readBody(c);
    if (body.kind !== 'ok') return body.response;
    const { code, publicKey } = body.value;
    if (typeof code !== 'string' || code.length === 0 || code.length > 200) {
      return badInput(c, '`code` must be the enrollment code you were given');
    }
    if (publicKey === null || typeof publicKey !== 'object' || Array.isArray(publicKey)) {
      return badInput(c, '`publicKey` must be a JWK object');
    }
    const clientAddress = options.clientAddress?.(c.req.raw);
    const outcome = await options.binding.enroll({
      code,
      publicKey: publicKey as Record<string, unknown>,
      ...(clientAddress !== undefined && { clientAddress }),
    });
    switch (outcome.kind) {
      case 'ok':
        return c.json({ siteId: outcome.siteId, audience: outcome.audience });
      case 'invalid-key':
        c.status(statusFor('site-key-invalid') as never);
        return c.json(
          toWireError({ code: 'site-key-invalid', message: outcome.message }, c.get('requestId')),
        );
      case 'rate-limited':
        return rateLimited(c, outcome.retryAfterSeconds);
      case 'refused':
        c.status(statusFor('site-enrollment-refused') as never);
        return c.json(
          toWireError(
            {
              code: 'site-enrollment-refused',
              message:
                'That enrollment code is wrong, used or expired, or its site is paused: ask a tenant admin for a new one',
            },
            c.get('requestId'),
          ),
        );
    }
  });
  return r;
}

export function siteSignInRouter(options: SiteAuthRouteOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/', async (c) => {
    const body = await readBody(c);
    if (body.kind !== 'ok') return body.response;
    const { statement } = body.value;
    if (typeof statement !== 'string' || !COMPACT_JWS.test(statement)) {
      return badInput(c, '`statement` must be a compact JWS, signed by the site');
    }
    const clientAddress = options.clientAddress?.(c.req.raw);
    const outcome = await options.binding.signIn({
      statement,
      ...(clientAddress !== undefined && { clientAddress }),
    });
    switch (outcome.kind) {
      case 'ok':
        return c.json({
          token: outcome.token,
          expiresAt: outcome.expiresAt,
          userId: outcome.userId,
          actor: `user:${outcome.userId as unknown as string}`,
          projectId: outcome.projectId,
        });
      case 'rate-limited':
        return rateLimited(c, outcome.retryAfterSeconds);
      case 'refused':
        c.status(statusFor('site-sign-in-refused') as never);
        return c.json(
          toWireError(
            {
              code: 'site-sign-in-refused',
              message: outcome.message,
              reason: outcome.reason,
            },
            c.get('requestId'),
          ),
        );
    }
  });
  return r;
}

type Body =
  | { readonly kind: 'ok'; readonly value: Record<string, unknown> }
  | { readonly kind: 'refused'; readonly response: Response };

/** The body, as a JSON object no bigger than `SITE_REQUEST_MAX_BYTES`. */
async function readBody(c: Context<AppEnv>): Promise<Body> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > SITE_REQUEST_MAX_BYTES) return { kind: 'refused', response: tooLarge(c) };
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > SITE_REQUEST_MAX_BYTES) {
    return { kind: 'refused', response: tooLarge(c) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'refused', response: badInput(c, 'The body must be a JSON object') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'refused', response: badInput(c, 'The body must be a JSON object') };
  }
  return { kind: 'ok', value: parsed as Record<string, unknown> };
}

function tooLarge(c: Context<AppEnv>): Response {
  c.status(statusFor('site-request-too-large') as never);
  return c.json(
    toWireError(
      {
        code: 'site-request-too-large',
        message: `The body is over ${SITE_REQUEST_MAX_BYTES} bytes`,
      },
      c.get('requestId'),
    ),
  ) as unknown as Response;
}

function badInput(c: Context<AppEnv>, message: string): Response {
  c.status(statusFor('bad-input') as never);
  return c.json(
    toWireError({ code: 'bad-input', message }, c.get('requestId')),
  ) as unknown as Response;
}

function rateLimited(c: Context<AppEnv>, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(Math.max(Math.ceil(retryAfterSeconds), 1)));
  c.status(statusFor('rate-limit-exceeded') as never);
  return c.json(
    toWireError(
      { code: 'rate-limit-exceeded', message: 'Too many requests from here: try again shortly' },
      c.get('requestId'),
    ),
  ) as unknown as Response;
}
