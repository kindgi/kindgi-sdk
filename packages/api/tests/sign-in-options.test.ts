// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  RunHandlerBinding,
  SignInOptionsInput,
  SignInOptionsRateLimit,
  TokenResolver,
} from '../src/index.js';

/**
 * `GET /v1/auth/sign-in-options`: unauthenticated, answered by the email's
 * domain only (so it can't tell who has an account), rate-limited.
 */

const tenantId = randomUUID() as TenantId;
const resolveToken: TokenResolver = async () => ({ tenantId, scopes: [] });

// Who has an account doesn't matter to the answer; this is only here to
// prove it: alice exists, nobody doesn't.
const PEOPLE = new Set(['alice@acme.com']);

function makeApp(
  opts: {
    withSignInOptions?: boolean;
    rateLimit?: SignInOptionsRateLimit;
  } = {},
) {
  const calls: SignInOptionsInput[] = [];
  const identityProvider: IdentityProviderBinding = {
    list: async () => ({ data: [] }),
    get: async () => null,
    register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
    unregister: async () => ({ unregistered: false }),
    ...(opts.withSignInOptions !== false && {
      signInOptions: async (input: SignInOptionsInput) => {
        calls.push(input);
        if (input.emailDomain === 'acme.com' || input.emailDomain === undefined) {
          return [
            {
              providerId: 'acme-okta',
              displayName: 'Acme Okta',
              signInUrl: '/auth/start/idp_7f3a',
            },
          ];
        }
        return [];
      },
    }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    identityProvider,
    ...(opts.rateLimit !== undefined && { signInOptionsRateLimit: opts.rateLimit }),
  });
  return { app, calls };
}

const lookup = (app: ReturnType<typeof makeApp>['app'], email?: string, from = '203.0.113.7') =>
  app.request(
    email === undefined
      ? '/v1/auth/sign-in-options'
      : `/v1/auth/sign-in-options?email=${encodeURIComponent(email)}`,
    { headers: { 'x-forwarded-for': from } },
  );

describe('sign-in options', () => {
  test('no credential needed; the email domain is looked up, lowercased', async () => {
    const { app, calls } = makeApp();
    const res = await lookup(app, 'Alice@ACME.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      data: [
        { providerId: 'acme-okta', displayName: 'Acme Okta', signInUrl: '/auth/start/idp_7f3a' },
      ],
    });
    expect(calls).toEqual([{ emailDomain: 'acme.com' }]);
  });

  test('a known and an unknown person at the same domain get byte-identical answers', async () => {
    const { app } = makeApp();
    expect(PEOPLE.has('alice@acme.com')).toBe(true);
    expect(PEOPLE.has('nobody@acme.com')).toBe(false);
    const known = await lookup(app, 'alice@acme.com');
    const unknown = await lookup(app, 'nobody@acme.com');
    expect(known.status).toBe(unknown.status);
    expect(known.headers.get('content-type')).toBe(unknown.headers.get('content-type'));
    expect(await known.text()).toBe(await unknown.text());
  });

  test('without an email: the buttons (the binding decides; here, one tenant)', async () => {
    const { app, calls } = makeApp();
    const res = await lookup(app);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(calls).toEqual([{}]);
  });

  test('a domain nobody claims answers an empty list, same shape', async () => {
    const { app } = makeApp();
    const res = await lookup(app, 'someone@elsewhere.org');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  test('a binding without signInOptions answers an empty list', async () => {
    const { app } = makeApp({ withSignInOptions: false });
    const res = await lookup(app, 'alice@acme.com');
    expect(await res.json()).toEqual({ data: [] });
  });

  test('an email that is no email → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await lookup(app, 'not-an-email');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
  });

  test('rate-limited per client: 429 with Retry-After; another client is unaffected', async () => {
    const { app } = makeApp({ rateLimit: { limit: 2, windowMs: 60_000 } });
    expect((await lookup(app, 'a@acme.com')).status).toBe(200);
    expect((await lookup(app, 'b@acme.com')).status).toBe(200);
    const third = await lookup(app, 'c@acme.com');
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      'rate-limit-exceeded',
    );
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await lookup(app, 'a@acme.com', '198.51.100.9')).status).toBe(200);
  });
});
