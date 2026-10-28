// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createLogger } from '@kindgi/log';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, createInMemoryRateLimitStore } from '../src/index.js';
import type {
  ConsoleLink,
  IdentityProviderBinding,
  RateLimitStore,
  RunHandlerBinding,
  SignInLegalLinks,
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
    signInOptions?: IdentityProviderBinding['signInOptions'];
    emailLink?: {
      captchaSiteKey?: string;
      allowedFor?: (emailDomain: string) => Promise<boolean>;
    };
    legal?: SignInLegalLinks;
    links?: readonly ConsoleLink[];
    logLines?: string[];
  } = {},
) {
  const calls: SignInOptionsInput[] = [];
  const identityProvider: IdentityProviderBinding = {
    list: async () => ({ data: [] }),
    get: async () => null,
    register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
    unregister: async () => ({ unregistered: false }),
    ...(opts.signInOptions !== undefined && { signInOptions: opts.signInOptions }),
    ...(opts.withSignInOptions !== false &&
      opts.signInOptions === undefined && {
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
    ...(opts.emailLink !== undefined && { signInEmailLink: opts.emailLink }),
    ...(opts.legal !== undefined && { signInLegal: opts.legal }),
    ...(opts.links !== undefined && { consoleLinks: opts.links }),
    ...(opts.logLines !== undefined && {
      logger: createLogger({ write: (line) => opts.logLines?.push(line) }),
    }),
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
      methods: { identityProviders: true, apiToken: false },
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

  test('without an email: nothing, and the binding is not asked (email first)', async () => {
    const { app, calls } = makeApp();
    const res = await lookup(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      methods: { identityProviders: true, apiToken: false },
    });
    expect(calls).toEqual([]);
  });

  test('a domain nobody claims answers an empty list, same shape', async () => {
    const { app } = makeApp();
    const res = await lookup(app, 'someone@elsewhere.org');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      methods: { identityProviders: true, apiToken: false },
    });
  });

  test('a binding without signInOptions answers an empty list', async () => {
    const { app } = makeApp({ withSignInOptions: false });
    const res = await lookup(app, 'alice@acme.com');
    expect(await res.json()).toEqual({
      data: [],
      methods: { identityProviders: true, apiToken: false },
    });
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

  // Without an email the answer is the deployment's configuration, the same
  // for everyone: the console reads it on every page load for its links.
  test('only lookups with an email are counted: reads without one pass the limit, and spend none of it', async () => {
    const { app } = makeApp({ rateLimit: { limit: 2, windowMs: 60_000 } });
    for (let i = 0; i < 5; i += 1) expect((await lookup(app)).status).toBe(200);
    expect((await lookup(app, 'a@acme.com')).status).toBe(200);
    expect((await lookup(app, 'b@acme.com')).status).toBe(200);
    expect((await lookup(app, 'c@acme.com')).status).toBe(429);
    expect((await lookup(app)).status).toBe(200);
  });

  test('an email that is no email is still counted', async () => {
    const { app } = makeApp({ rateLimit: { limit: 1, windowMs: 60_000 } });
    expect((await lookup(app, 'not-an-email')).status).toBe(400);
    expect((await lookup(app, 'a@acme.com')).status).toBe(429);
  });

  test("the deployment's own ways in come after a workspace's; the emailed link is a method", async () => {
    const { app } = makeApp({
      signInOptions: async () => [
        { providerId: 'acme-okta', displayName: 'Acme Okta', signInUrl: '/auth/start/idp-x' },
        {
          providerId: 'google',
          displayName: 'Google',
          signInUrl: '/auth/kindgi/social/start/google',
          owner: 'deployment',
        },
      ],
      emailLink: { captchaSiteKey: 'site-key' },
    });
    const body = (await (await lookup(app, 'a@acme.com')).json()) as {
      data: Array<Record<string, unknown>>;
      methods: Record<string, unknown>;
    };
    expect(body.data.map((o) => [o.providerId, o.owner])).toEqual([
      ['acme-okta', undefined],
      ['google', 'deployment'],
    ]);
    expect(body.methods.emailLink).toEqual({ captchaSiteKey: 'site-key' });
  });

  test('the emailed link can be left out for a domain (a workspace that signs its people in with its own identity provider)', async () => {
    const asked: string[] = [];
    const { app } = makeApp({
      signInOptions: async () => [],
      emailLink: {
        captchaSiteKey: 'site-key',
        allowedFor: async (domain) => {
          asked.push(domain);
          return domain !== 'acme.com';
        },
      },
    });
    const methodsFor = async (email: string) =>
      ((await (await lookup(app, email)).json()) as { methods: Record<string, unknown> }).methods;
    expect((await methodsFor('a@acme.com')).emailLink).toBeUndefined();
    expect((await methodsFor('guest@gmail.com')).emailLink).toEqual({ captchaSiteKey: 'site-key' });
    expect(asked).toEqual(['acme.com', 'gmail.com']);
  });

  test('a spoofed leftmost X-Forwarded-For hop never changes the bucket', async () => {
    const { app } = makeApp({ rateLimit: { limit: 2, windowMs: 60_000 } });
    // The client writes whatever it likes on the left; the proxy appends its peer.
    for (const spoofed of ['10.9.9.1', '10.9.9.2']) {
      expect((await lookup(app, 'a@acme.com', `${spoofed}, 203.0.113.50`)).status).toBe(200);
    }
    expect((await lookup(app, 'a@acme.com', '10.9.9.3, 203.0.113.50')).status).toBe(429);
  });
});

describe("sign-in options: the deployment's terms and privacy policy", () => {
  const TERMS = 'https://acme.example/terms';
  const PRIVACY = 'https://acme.example/privacy';

  test.each([
    ['unset', undefined],
    ['neither set', {}],
  ])('%s: the answer has no `legal` key', async (_, legal) => {
    const { app } = makeApp(legal === undefined ? {} : { legal });
    for (const email of [undefined, 'a@acme.com']) {
      const body = (await (await lookup(app, email)).json()) as Record<string, unknown>;
      expect(Object.keys(body)).not.toContain('legal');
    }
  });

  test.each([
    ['both', { termsUrl: TERMS, privacyUrl: PRIVACY }],
    ['the terms alone', { termsUrl: TERMS }],
    ['the privacy policy alone', { privacyUrl: PRIVACY }],
  ])('%s: `legal` has only what is set, with or without an email', async (_, legal) => {
    const { app } = makeApp({ legal });
    for (const email of [undefined, 'a@acme.com', 'guest@gmail.com']) {
      const body = (await (await lookup(app, email)).json()) as { legal?: unknown };
      expect(body.legal).toEqual(legal);
    }
  });

  // A browser resolves `https:host/terms` against the sign-in page's own
  // address, so the answer carries each link as the browser reads it.
  test('`legal` carries each link as a browser reads it', async () => {
    const { app } = makeApp({
      legal: { termsUrl: 'https:acme.example/terms', privacyUrl: 'HTTPS:/acme.example/privacy' },
    });
    const body = (await (await lookup(app)).json()) as { legal?: unknown };
    expect(body.legal).toStrictEqual({ termsUrl: TERMS, privacyUrl: PRIVACY });
  });

  test.each([
    ['termsUrl', { termsUrl: 'http://acme.example/terms' }],
    ['privacyUrl', { privacyUrl: '/privacy' }],
    ['termsUrl', { termsUrl: 'javascript:alert(1)' }],
    ['privacyUrl', { privacyUrl: 'https://' }],
  ])('createApp refuses a %s that is not an absolute https URL', (field, legal) => {
    expect(() => makeApp({ legal })).toThrow(
      `createApp: signInLegal.${field} must be an absolute https URL`,
    );
  });

  test.each([
    ['termsUrl', { termsUrl: 'https://reader:hunter2@acme.example/terms' }],
    ['privacyUrl', { privacyUrl: 'https://reader@acme.example/privacy' }],
  ])('createApp refuses a %s with a username or password, without quoting it', (field, legal) => {
    expect(() => makeApp({ legal })).toThrow(
      new Error(`createApp: signInLegal.${field} must not carry a username or password.`),
    );
  });
});

describe("sign-in options: the deployment's own links, for the console", () => {
  const HELP = { label: 'Help', url: 'https://help.acme.example/' };
  const STATUS = { label: 'Status', url: 'https://status.acme.example/now' };
  const labelRule =
    'label must be 1 to 40 characters, with no control, format or invisible character.';

  test.each([
    ['unset', undefined],
    ['none', []],
  ])('%s: the answer has no `links` key', async (_, links) => {
    const { app } = makeApp(links === undefined ? {} : { links });
    for (const email of [undefined, 'a@acme.com']) {
      const body = (await (await lookup(app, email)).json()) as Record<string, unknown>;
      expect(Object.keys(body)).not.toContain('links');
    }
  });

  test('`links` keeps the order given, the same with or without an email, beside `legal`', async () => {
    const legal = { termsUrl: 'https://acme.example/terms' };
    const { app } = makeApp({ links: [STATUS, HELP], legal });
    for (const email of [undefined, 'a@acme.com', 'guest@gmail.com']) {
      const body = (await (await lookup(app, email)).json()) as Record<string, unknown>;
      expect(body.links).toStrictEqual([STATUS, HELP]);
      expect(body.legal).toStrictEqual(legal);
    }
  });

  test('each label trimmed, each URL as a browser reads it', async () => {
    const { app } = makeApp({
      links: [
        { label: '  Help ', url: 'https:help.acme.example' },
        { label: 'Status', url: 'HTTPS://status.acme.example/now' },
      ],
    });
    const body = (await (await lookup(app)).json()) as { links?: unknown };
    expect(body.links).toStrictEqual([HELP, STATUS]);
  });

  test('createApp takes 8 links, and refuses 9', () => {
    const links = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        label: `Link ${i}`,
        url: `https://acme.example/${i}`,
      }));
    expect(() => makeApp({ links: links(8) })).not.toThrow();
    expect(() => makeApp({ links: links(9) })).toThrow(
      new Error('createApp: consoleLinks has 9 links; at most 8.'),
    );
  });

  test.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['41 characters', 'x'.repeat(41)],
    ['a newline', 'Help\ndesk'],
    ['a control character', 'Help\u0007'],
    ['a bidirectional override', '\u202eKCOL'],
    ['a zero-width space', 'He\u200blp'],
    ['a line separator', 'Help\u2028desk'],
    ['a variation selector', 'Help\ufe0f'],
  ])('createApp refuses a label that is %s', (_, label) => {
    expect(() => makeApp({ links: [HELP, { label, url: STATUS.url }] })).toThrow(
      new Error(`createApp: consoleLinks[1].${labelRule}`),
    );
  });

  test("createApp refuses a label that is an earlier link's once trimmed", () => {
    expect(() =>
      makeApp({
        links: [
          { label: ' Help', url: HELP.url },
          STATUS,
          { label: 'Help ', url: 'https://www.acme.example' },
        ],
      }),
    ).toThrow(
      new Error(
        "createApp: consoleLinks[2].label is consoleLinks[0]'s once trimmed; each label once.",
      ),
    );
  });

  // Only digits is the env setting's rule (a JavaScript object puts such
  // keys first); a list keeps its order, so createApp takes it.
  test.each([
    ['40 characters', 'x'.repeat(40)],
    ['only digits', '24'],
    ['with spaces and punctuation', 'Hilfe & Kontakt'],
  ])('createApp takes a label of %s', async (_, label) => {
    const { app } = makeApp({ links: [{ label, url: HELP.url }] });
    const body = (await (await lookup(app)).json()) as { links?: unknown };
    expect(body.links).toStrictEqual([{ label, url: HELP.url }]);
  });

  test.each([['http://help.acme.example'], ['/help'], ['javascript:alert(1)'], ['https://']])(
    'createApp refuses the URL %s',
    (url) => {
      expect(() => makeApp({ links: [{ label: 'Help', url }] })).toThrow(
        new Error(`createApp: consoleLinks[0].url must be an absolute https URL (got ${url}).`),
      );
    },
  );

  test('createApp refuses a URL with a username or password, without quoting it', () => {
    expect(() =>
      makeApp({ links: [{ label: 'Help', url: 'https://reader:hunter2@help.acme.example' }] }),
    ).toThrow(new Error('createApp: consoleLinks[0].url must not carry a username or password.'));
  });
});

describe('the rate limit with a shared store', () => {
  test('two instances sharing a store count together: N instances no longer allow N × limit', async () => {
    const store = createInMemoryRateLimitStore();
    const a = makeApp({ rateLimit: { limit: 2, windowMs: 60_000, store } }).app;
    const b = makeApp({ rateLimit: { limit: 2, windowMs: 60_000, store } }).app;
    expect((await lookup(a, 'a@acme.com')).status).toBe(200);
    expect((await lookup(b, 'b@acme.com')).status).toBe(200);
    const third = await lookup(a, 'c@acme.com');
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await lookup(b, 'c@acme.com')).status).toBe(429);
  });

  test("the store is asked by the client's key, namespaced, with the limit and window", async () => {
    const asked: unknown[] = [];
    const store: RateLimitStore = {
      take: async (input) => {
        asked.push(input);
        return { allowed: true };
      },
    };
    const { app } = makeApp({ rateLimit: { limit: 7, windowMs: 5_000, store } });
    expect((await lookup(app, 'a@acme.com', '10.0.0.1, 203.0.113.50')).status).toBe(200);
    expect(asked).toEqual([{ key: 'sign-in-options:203.0.113.50', limit: 7, windowMs: 5_000 }]);
    // A read without an email isn't asked about.
    expect((await lookup(app, undefined, '10.0.0.1, 203.0.113.50')).status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  test('a refusal from the store: 429 with its Retry-After, rounded up', async () => {
    const store: RateLimitStore = { take: async () => ({ allowed: false, retryAfterMs: 2_100 }) };
    const res = await lookup(makeApp({ rateLimit: { store } }).app, 'a@acme.com');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
  });

  test("a store that fails: the lookup is answered (a speed bump, not a lock), and it's logged", async () => {
    const logLines: string[] = [];
    const store: RateLimitStore = {
      take: async () => {
        throw new Error('connection refused');
      },
    };
    const { app } = makeApp({ rateLimit: { store }, logLines });
    expect((await lookup(app, 'a@acme.com')).status).toBe(200);
    expect((await lookup(app, 'b@acme.com')).status).toBe(200);
    const warnings = logLines.filter((l) => l.includes('the rate-limit store failed'));
    // One warning while the store is down, not one a lookup.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('connection refused');
  });
});
