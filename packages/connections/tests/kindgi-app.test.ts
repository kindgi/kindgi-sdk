// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { facebookPages } from '../src/facebook-pages.js';
import { type AppEntry, defineApp } from '../src/index.js';
import { instagram } from '../src/instagram.js';

/** An app Kindgi connects through its own app at the network. */
const acmeSocial: AppEntry = {
  id: 'acme-social',
  name: 'Acme Social',
  signIn: { kind: 'kindgi-app' },
  owners: ['company'],
  permissions: {
    'posts.write': { grants: 'posts_publish', says: 'Post as the account', changes: true },
  },
  account: { kind: 'kindgi-app-account', asset: 'page' },
  removal: {},
  setupGuide: '/guides/connections/acme-social/',
};

/** `acmeSocial` with `patch` laid over it, one level deep. */
function withAcmeSocial(patch: Record<string, unknown>): AppEntry {
  return { ...acmeSocial, ...patch } as AppEntry;
}

const oauth2 = {
  kind: 'oauth2',
  authorizeUrl: 'https://auth.acme.example/authorize',
  tokenUrl: 'https://auth.acme.example/token',
  revokeUrl: 'https://auth.acme.example/revoke',
  pkce: 'S256',
} as const;

describe('defineApp, for an app Kindgi connects through its own app', () => {
  it.each(['page', 'instagram'] as const)(
    'takes a kindgi-app entry whose account is a %s',
    (asset) => {
      const entry = defineApp(withAcmeSocial({ account: { kind: 'kindgi-app-account', asset } }));
      expect(entry.signIn).toEqual({ kind: 'kindgi-app' });
      expect(entry.account).toEqual({ kind: 'kindgi-app-account', asset });
      expect(Object.isFrozen(entry.account)).toBe(true);
    },
  );

  it.each([
    [
      'an asset outside the set',
      { account: { kind: 'kindgi-app-account', asset: 'group' } },
      /account.asset must be "page" or "instagram"/,
    ],
    [
      'no asset',
      { account: { kind: 'kindgi-app-account' } },
      /account.asset must be "page" or "instagram"/,
    ],
    [
      "the account of Kindgi's app on an oauth2 sign-in",
      { signIn: oauth2, removal: {} },
      /account.kind "kindgi-app-account" needs a "kindgi-app" sign-in/,
    ],
    [
      'an openid lookup',
      {
        account: { kind: 'openid', issuers: ['https://auth.acme.example'], scopes: ['openid'] },
      },
      /account.kind "openid" needs an "oauth2" sign-in/,
    ],
    [
      'a profile lookup',
      {
        account: {
          kind: 'profile',
          url: 'https://api.acme.example/me',
          scopes: [],
          id: 'id',
          label: ['name'],
        },
      },
      /account.kind "profile" needs an "oauth2" sign-in/,
    ],
    [
      "a GitHub App's installation",
      { account: { kind: 'github-installation' } },
      /account.kind "github-installation" needs a "github-app" sign-in/,
    ],
    [
      'a refreshToken',
      { signIn: { kind: 'kindgi-app', refreshToken: 'optional' } },
      /signIn.refreshToken is for an "oauth2" sign-in/,
    ],
    [
      'an address on the sign-in',
      { signIn: { kind: 'kindgi-app', authorizeUrl: 'https://auth.acme.example/authorize' } },
      /signIn.authorizeUrl isn't taken by a "kindgi-app" sign-in/,
    ],
    [
      'an OAuth revoke',
      { removal: { revoke: 'oauth2-revoke' } },
      /removal.revoke "oauth2-revoke" needs an "oauth2" sign-in with a revokeUrl/,
    ],
    [
      "a GitHub App's revoke",
      { removal: { revoke: 'github-installation-token' } },
      /removal.revoke "github-installation-token" needs a "github-app" sign-in/,
    ],
    [
      'notices',
      { removal: { notices: 'google-risc' } },
      /removal.notices is for an app the workspace registers/,
    ],
    [
      'a member as an owner',
      { owners: ['member', 'company'] },
      /owners must be \["company"\] for a "kindgi-app" sign-in/,
    ],
    [
      'a member as the only owner',
      { owners: ['member'] },
      /owners must be \["company"\] for a "kindgi-app" sign-in/,
    ],
  ])('refuses %s', (_name, patch, message) => {
    expect(() => defineApp(withAcmeSocial(patch))).toThrow(message);
  });

  it('names every sign-in kind and account kind it takes', () => {
    expect(() => defineApp(withAcmeSocial({ signIn: { kind: 'meta' } }))).toThrow(
      'defineApp("acme-social"): signIn.kind must be "oauth2", "github-app" or "kindgi-app"',
    );
    expect(() => defineApp(withAcmeSocial({ account: { kind: 'meta-asset' } }))).toThrow(
      'defineApp("acme-social"): account.kind must be "openid", "github-installation", "profile" or "kindgi-app-account"',
    );
  });
});

describe('the Facebook Pages entry', () => {
  it('is a checked, frozen entry', () => {
    expect(defineApp(facebookPages)).toEqual(facebookPages);
    expect(Object.isFrozen(facebookPages)).toBe(true);
  });

  it("is the company's Page, connected through Kindgi's app", () => {
    expect(facebookPages.id).toBe('facebook-pages');
    expect(facebookPages.name).toBe('Facebook Pages');
    expect(facebookPages.owners).toEqual(['company']);
    expect(facebookPages.signIn).toEqual({ kind: 'kindgi-app' });
    expect(facebookPages.account).toEqual({ kind: 'kindgi-app-account', asset: 'page' });
  });

  it('says what posting as the Page and reading it allow, and which change anything', () => {
    expect(facebookPages.permissions).toEqual({
      'posts.write': {
        grants: 'pages_manage_posts',
        says: 'Post on the Page as the Page, and edit or delete its posts',
        changes: true,
      },
      'pages.read': {
        grants: 'pages_read_engagement',
        says: "See the Page's name and posts",
        changes: false,
      },
    });
  });

  it('withdraws nothing at Meta and hears no removals, and has its own guide', () => {
    expect(facebookPages.removal).toEqual({});
    expect(facebookPages.rateLimits).toBeUndefined();
    expect(facebookPages.setupGuide).toBe('/guides/connections/facebook-pages/');
  });
});

describe('the Instagram entry', () => {
  it('is a checked, frozen entry', () => {
    expect(defineApp(instagram)).toEqual(instagram);
    expect(Object.isFrozen(instagram)).toBe(true);
  });

  it("is the company's Instagram professional account, connected through Kindgi's app", () => {
    expect(instagram.id).toBe('instagram');
    expect(instagram.name).toBe('Instagram');
    expect(instagram.owners).toEqual(['company']);
    expect(instagram.signIn).toEqual({ kind: 'kindgi-app' });
    expect(instagram.account).toEqual({ kind: 'kindgi-app-account', asset: 'instagram' });
  });

  it('says what posting and reading the account allow, and which change anything', () => {
    expect(instagram.permissions).toEqual({
      'posts.write': {
        grants: 'instagram_content_publish',
        says: 'Post photos to the account',
        changes: true,
      },
      'account.read': {
        grants: 'instagram_basic',
        says: "See the account's name and profile",
        changes: false,
      },
    });
  });

  it('withdraws nothing at Meta and hears no removals, and has its own guide', () => {
    expect(instagram.removal).toEqual({});
    expect(instagram.setupGuide).toBe('/guides/connections/instagram/');
  });

  it("grants nothing the Pages entry grants, so neither token does the other's job", () => {
    const grants = (entry: AppEntry) => Object.values(entry.permissions).map((p) => p.grants);
    for (const grant of grants(instagram)) expect(grants(facebookPages)).not.toContain(grant);
  });
});
