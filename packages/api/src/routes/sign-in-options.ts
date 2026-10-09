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
 * the binding isn't asked. `methods` tells a sign-in page which ways in
 * there are; always mounted, so with none it says so (both `false`).
 */
export interface SignInOptionsRouteOptions {
  /** Absent: no sign-in with identity providers here (only an API token, if allowed). */
  readonly identityProvider?: IdentityProviderBinding;
  /** Whether a person may sign in to the console with an API token here. */
  readonly tokenSignIn: boolean;
  /**
   * The browser session cookie's kind, when there are browser sessions:
   * `secure` (the default), or `plain` (development on a loopback address;
   * see `SessionCookieOptions.secure`). A sign-in page checks the browser
   * keeps that kind before offering sign-in.
   */
  readonly sessionCookie?: 'secure' | 'plain';
  /**
   * The emailed sign-in link, when the deployment offers it: a sign-in page
   * shows "Email me a sign-in link", with the Turnstile widget when there's
   * a site key. `allowedFor`: whether it's offered for an email's domain
   * (say, not where a workspace signs its people in with its own identity
   * provider). Absent: for every domain.
   */
  readonly emailLink?: {
    readonly captchaSiteKey?: string;
    readonly allowedFor?: (emailDomain: string) => Promise<boolean>;
  };
  readonly rateLimit?: SignInOptionsRateLimit;
}

export interface SignInOptionsRateLimit {
  /** Requests per client per window. Default 30. */
  readonly limit?: number;
  /** Default 60 000 ms. */
  readonly windowMs?: number;
  /**
   * Who the client is. Default: the nearest `X-Forwarded-For` hop (the
   * rightmost, written by the proxy in front), else one shared bucket;
   * never the leftmost, which the client writes. A deployment that knows
   * its client's address (the socket's, or past its trusted proxies)
   * passes its own.
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
    const emailLink = options.emailLink;
    const linkOffered =
      emailLink !== undefined &&
      (emailDomain === undefined ||
        emailLink.allowedFor === undefined ||
        (await emailLink.allowedFor(emailDomain)));
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: offered.map((o) => ({
        providerId: o.providerId,
        displayName: o.displayName,
        signInUrl: o.signInUrl,
        ...(o.owner !== undefined && { owner: o.owner }),
      })),
      methods: {
        identityProviders: identityProvider !== undefined,
        apiToken: options.tokenSignIn,
        ...(options.sessionCookie !== undefined && { sessionCookie: options.sessionCookie }),
        ...(linkOffered && {
          emailLink: {
            ...(emailLink.captchaSiteKey !== undefined && {
              captchaSiteKey: emailLink.captchaSiteKey,
            }),
          },
        }),
      },
    });
  });
  return router;
}

function defaultClientKey(request: Request): string {
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  return hops.at(-1) ?? 'shared';
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
