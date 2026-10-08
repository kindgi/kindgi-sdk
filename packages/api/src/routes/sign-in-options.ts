// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { statusFor, toWireError } from '../errors.js';
import type { IdentityProviderBinding, SignInOption } from '../identity-provider-binding.js';
import type { AppEnv } from '../types.js';

/**
 * `GET /v1/auth/sign-in-options?email=`: how a person can sign in, before
 * anyone is signed in. Mounted outside the auth chain.
 *
 * It answers by the email's DOMAIN only, so the answer for two people at
 * the same domain is the same byte for byte, whether or not either of
 * them has an account: it can't be used to find out who does. Requests
 * are rate-limited per client, as a speed bump against scraping.
 *
 * Email first: without an email, nothing is offered (an empty list), and
 * the binding isn't asked. The empty answer still tells a sign-in page
 * that sign-in with identity providers is on (off is a 404).
 */
export interface SignInOptionsRouteOptions {
  /** Absent: no sign-in with identity providers here (only an API token, if allowed). */
  readonly identityProvider?: IdentityProviderBinding;
  /** Whether a person may sign in to the console with an API token here. */
  readonly tokenSignIn: boolean;
  readonly rateLimit?: SignInOptionsRateLimit;
}

export interface SignInOptionsRateLimit {
  /** Requests per client per window. Default 30. */
  readonly limit?: number;
  /** Default 60 000 ms. */
  readonly windowMs?: number;
  /**
   * Who the client is. Default: the first `X-Forwarded-For` address, else
   * one shared bucket. A deployment whose proxy sets another header (or
   * that sees the socket address) passes its own.
   */
  readonly clientKey?: (request: Request) => string;
}

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;
// The bucket map is pruned once it holds this many clients.
const MAX_TRACKED_CLIENTS = 10_000;

// One `@`, a non-empty local part, and a domain with a dot.
const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

export function signInOptionsRouter(options: SignInOptionsRouteOptions): Hono<AppEnv> {
  const { identityProvider } = options;
  const limit = options.rateLimit?.limit ?? DEFAULT_LIMIT;
  const windowMs = options.rateLimit?.windowMs ?? DEFAULT_WINDOW_MS;
  const clientKey = options.rateLimit?.clientKey ?? defaultClientKey;
  const buckets = new Map<string, { windowStart: number; count: number }>();

  const router = new Hono<AppEnv>();
  router.get('/', async (c) => {
    const requestId = c.get('requestId');

    const now = Date.now();
    const key = clientKey(c.req.raw);
    const bucket = buckets.get(key);
    if (bucket === undefined || now - bucket.windowStart >= windowMs) {
      if (buckets.size >= MAX_TRACKED_CLIENTS) pruneExpired(buckets, now, windowMs);
      buckets.set(key, { windowStart: now, count: 1 });
    } else if (bucket.count >= limit) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      c.header('Retry-After', String(Math.max(retryAfter, 1)));
      c.status(statusFor('rate-limit-exceeded') as never);
      return c.json(
        toWireError(
          { code: 'rate-limit-exceeded', message: 'Too many sign-in lookups: try again shortly' },
          requestId,
        ),
      );
    } else {
      bucket.count += 1;
    }

    const email = c.req.query('email');
    let emailDomain: string | undefined;
    if (email !== undefined) {
      const match = EMAIL_RE.exec(email.trim());
      if (match === null) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`email` must be an email address' },
            requestId,
          ),
        );
      }
      emailDomain = (match[1] as string).toLowerCase();
    }

    const offered: readonly SignInOption[] =
      identityProvider?.signInOptions === undefined || emailDomain === undefined
        ? []
        : await identityProvider.signInOptions({ emailDomain });
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: offered.map((o) => ({
        providerId: o.providerId,
        displayName: o.displayName,
        signInUrl: o.signInUrl,
      })),
      methods: {
        identityProviders: identityProvider !== undefined,
        apiToken: options.tokenSignIn,
      },
    });
  });
  return router;
}

function defaultClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : 'shared';
}

function pruneExpired(
  buckets: Map<string, { windowStart: number; count: number }>,
  now: number,
  windowMs: number,
): void {
  for (const [k, b] of buckets) {
    if (now - b.windowStart >= windowMs) buckets.delete(k);
  }
  // Still full: every client is mid-window. Drop the oldest half rather
  // than grow without bound.
  if (buckets.size >= MAX_TRACKED_CLIENTS) {
    const keys = [...buckets.keys()].slice(0, Math.floor(MAX_TRACKED_CLIENTS / 2));
    for (const k of keys) buckets.delete(k);
  }
}
