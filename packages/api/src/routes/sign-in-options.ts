// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { statusFor, toWireError } from '../errors.js';
import type { IdentityProviderBinding, SignInOption } from '../identity-provider-binding.js';
import { type RateLimitStore, createInMemoryRateLimitStore } from '../rate-limit-store.js';
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
  /**
   * Where the counts live. Default: this process's memory, so each
   * instance counts on its own (N instances let N × `limit` through). A
   * deployment with several instances passes one they share. If it fails,
   * the lookup is answered (the limit is a speed bump, not a lock) and the
   * failure logged.
   */
  readonly store?: RateLimitStore;
}

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;
// While the store fails, one warning at most this often (not one a lookup).
const STORE_FAILED_WARN_EVERY_MS = 60_000;

// One `@`, a non-empty local part, and a domain with a dot.
const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

export function signInOptionsRouter(options: SignInOptionsRouteOptions): Hono<AppEnv> {
  const { identityProvider } = options;
  const limit = options.rateLimit?.limit ?? DEFAULT_LIMIT;
  const windowMs = options.rateLimit?.windowMs ?? DEFAULT_WINDOW_MS;
  const clientKey = options.rateLimit?.clientKey ?? defaultClientKey;
  const store = options.rateLimit?.store ?? createInMemoryRateLimitStore();
  let lastWarnedAt: number | undefined;
  let uncounted = 0;

  const router = new Hono<AppEnv>();
  router.get('/', async (c) => {
    const requestId = c.get('requestId');

    const key = `sign-in-options:${clientKey(c.req.raw)}`;
    let taken: Awaited<ReturnType<RateLimitStore['take']>>;
    try {
      taken = await store.take({ key, limit, windowMs });
    } catch (cause) {
      uncounted += 1;
      const now = Date.now();
      if (lastWarnedAt === undefined || now - lastWarnedAt >= STORE_FAILED_WARN_EVERY_MS) {
        c.get('log').warn(
          `sign-in options: the rate-limit store failed, so lookups aren't counted (${uncounted} since the last warning): ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        lastWarnedAt = now;
        uncounted = 0;
      }
      taken = { allowed: true };
    }
    if (!taken.allowed) {
      c.header('Retry-After', String(Math.max(Math.ceil(taken.retryAfterMs / 1000), 1)));
      c.status(statusFor('rate-limit-exceeded') as never);
      return c.json(
        toWireError(
          { code: 'rate-limit-exceeded', message: 'Too many sign-in lookups: try again shortly' },
          requestId,
        ),
      );
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
