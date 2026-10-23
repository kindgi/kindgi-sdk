// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { type AppEntry, defineApp } from '../src/index.js';

const acme: AppEntry = {
  id: 'acme',
  name: 'Acme',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://auth.acme.example/authorize',
    tokenUrl: 'https://auth.acme.example/token',
    revokeUrl: 'https://auth.acme.example/revoke',
    pkce: 'S256',
    authorizeParams: { access_type: 'offline' },
  },
  owners: ['member', 'company'],
  permissions: {
    'notes.read': { grants: 'notes:read', says: 'Read your notes', changes: false },
    'notes.write': {
      grants: 'notes:write',
      says: 'Write notes as you',
      changes: true,
      review: 'sensitive',
    },
  },
  account: { kind: 'openid', issuers: ['https://auth.acme.example'], scopes: ['openid', 'email'] },
  removal: { revoke: 'oauth2-revoke', revokeIsGrantWide: false },
  rateLimits: [{ per: 'connection', units: 100, perSeconds: 60, costs: { 'acme.write-note': 5 } }],
  setupGuide: '/guides/connections/acme/',
};

/** `acme` with `patch` laid over it, one level deep. */
function withAcme(patch: Record<string, unknown>): AppEntry {
  return { ...acme, ...patch } as AppEntry;
}

describe('defineApp', () => {
  it('returns an equal, deeply frozen copy', () => {
    const entry = defineApp(acme);
    expect(entry).toEqual(acme);
    expect(entry).not.toBe(acme);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.permissions['notes.write'])).toBe(true);
    expect(Object.isFrozen(entry.account)).toBe(true);
    expect(Object.isFrozen(acme)).toBe(false);
  });

  it('takes a github-app entry', () => {
    const entry = defineApp(
      withAcme({
        signIn: { kind: 'github-app' },
        account: { kind: 'github-installation' },
        removal: { revoke: 'github-installation-token', notices: 'github-webhooks' },
      }),
    );
    expect(entry.signIn.kind).toBe('github-app');
  });

  it("takes a sign-in in the app's own directory, a profile lookup, and a limit a call costs 0 in", () => {
    const signIn = {
      kind: 'oauth2',
      authorizeUrl: 'https://auth.acme.example/{tenant}/authorize',
      tokenUrl: 'https://auth.acme.example/{tenant}/token',
      revokeUrl: 'https://auth.acme.example/{tenant}/revoke',
      pkce: 'S256',
      scopes: ['offline_access'],
      scopeResource: 'https://api.acme.example/',
      tenant: {},
    } as const;
    const entry = defineApp(
      withAcme({
        signIn,
        account: {
          kind: 'profile',
          url: 'https://api.acme.example/me',
          scopes: ['me.read'],
          id: 'id',
          label: ['mail', 'login'],
        },
        removal: {},
        rateLimits: [
          { per: 'connection', units: 30, perSeconds: 60, costs: { 'acme.read-note': 0 } },
        ],
      }),
    );
    expect(entry.account.kind).toBe('profile');
    expect(entry.signIn.kind === 'oauth2' && entry.signIn.tenant).toEqual({});
    const withDefault = defineApp(
      withAcme({ signIn: { ...signIn, tenant: { default: 'organizations' } }, removal: {} }),
    );
    expect(withDefault.signIn.kind === 'oauth2' && withDefault.signIn.tenant).toEqual({
      default: 'organizations',
    });
  });

  it.each([
    ['an id that is not a slug', { id: 'Acme' }, /id must match/],
    ['a one-letter id', { id: 'a' }, /id must match/],
    ['an empty name', { name: ' ' }, /name must be a non-empty string/],
    [
      'a setup guide that is not a docs path',
      { setupGuide: 'https://acme.example/' },
      /setupGuide must be a docs path/,
    ],
    ['an unknown sign-in kind', { signIn: { kind: 'saml' } }, /signIn.kind must be/],
    [
      'an http authorize URL',
      { signIn: { ...acme.signIn, authorizeUrl: 'http://auth.acme.example/authorize' } },
      /signIn.authorizeUrl must be an https URL/,
    ],
    [
      'a token URL that is not a URL',
      { signIn: { ...acme.signIn, tokenUrl: 'token' } },
      /signIn.tokenUrl must be an https URL/,
    ],
    ['plain PKCE', { signIn: { ...acme.signIn, pkce: 'plain' } }, /signIn.pkce must be "S256"/],
    [
      'an authorize param that is not a string',
      { signIn: { ...acme.signIn, authorizeParams: { prompt: true } } },
      /signIn.authorizeParams.prompt must be a string/,
    ],
    ['no owners', { owners: [] }, /owners must list at least one/],
    ['an unknown owner', { owners: ['person'] }, /owners has "person"/],
    ['an owner twice', { owners: ['member', 'member'] }, /owners lists "member" twice/],
    ['no permissions', { permissions: {} }, /permissions must have at least one/],
    [
      'a permission key that is not a key',
      { permissions: { 'Notes Read': acme.permissions['notes.read'] } },
      /permissions\["Notes Read"\]: the key must match/,
    ],
    [
      'a permission that says nothing',
      { permissions: { 'notes.read': { grants: 'notes:read', says: '', changes: false } } },
      /permissions\["notes.read"\].says must be a non-empty string/,
    ],
    [
      'a permission without changes',
      { permissions: { 'notes.read': { grants: 'notes:read', says: 'Read your notes' } } },
      /permissions\["notes.read"\].changes must be true or false/,
    ],
    [
      'an unknown review class',
      { permissions: { 'notes.read': { ...acme.permissions['notes.read'], review: 'secret' } } },
      /permissions\["notes.read"\].review must be/,
    ],
    [
      'an openid lookup without issuers',
      { account: { kind: 'openid', issuers: [], scopes: ['openid'] } },
      /account.issuers must list at least one issuer/,
    ],
    [
      'a first issuer that is not https',
      { account: { kind: 'openid', issuers: ['auth.acme.example'], scopes: ['openid'] } },
      /account.issuers\[0\], the issuer keys are found at, must be an https URL/,
    ],
    [
      'openid scopes without openid',
      { account: { kind: 'openid', issuers: ['https://auth.acme.example'], scopes: ['email'] } },
      /account.scopes must include "openid"/,
    ],
    [
      'an installation lookup on oauth2',
      { account: { kind: 'github-installation' } },
      /needs a "github-app" sign-in/,
    ],
    ['an unknown account kind', { account: { kind: 'saml' } }, /account.kind must be/],
    [
      'an oauth2 revoke without a revoke URL',
      { signIn: { ...acme.signIn, revokeUrl: undefined } },
      /removal.revoke "oauth2-revoke" needs an "oauth2" sign-in with a revokeUrl/,
    ],
    [
      'an installation-token revoke on oauth2',
      { removal: { revoke: 'github-installation-token' } },
      /needs a "github-app" sign-in/,
    ],
    ['an unknown revoke', { removal: { revoke: 'delete' } }, /removal.revoke must be/],
    ['an unknown notice kind', { removal: { notices: 'email' } }, /removal.notices must be/],
    [
      'a rate limit per tenant',
      { rateLimits: [{ per: 'tenant', units: 1, perSeconds: 1 }] },
      /rateLimits\[0\].per must be "connection"/,
    ],
    [
      'a rate limit of zero units',
      { rateLimits: [{ per: 'connection', units: 0, perSeconds: 1 }] },
      /rateLimits\[0\].units must be a positive whole number/,
    ],
    [
      'a fractional cost',
      {
        rateLimits: [
          { per: 'connection', units: 10, perSeconds: 1, costs: { 'acme.write-note': 0.5 } },
        ],
      },
      /rateLimits\[0\].costs\["acme.write-note"\] must be a whole number, 0 or more/,
    ],
    [
      'a negative cost',
      {
        rateLimits: [
          { per: 'connection', units: 10, perSeconds: 1, costs: { 'acme.read-note': -1 } },
        ],
      },
      /rateLimits\[0\].costs\["acme.read-note"\] must be a whole number, 0 or more/,
    ],
    [
      'a {tenant} in a URL without signIn.tenant',
      { signIn: { ...acme.signIn, authorizeUrl: 'https://auth.acme.example/{tenant}/authorize' } },
      /signIn.authorizeUrl has \{tenant\}, so signIn.tenant is needed/,
    ],
    [
      'a signIn.tenant with a URL that lacks {tenant}',
      {
        signIn: {
          ...acme.signIn,
          revokeUrl: undefined,
          authorizeUrl: 'https://auth.acme.example/{tenant}/authorize',
          tenant: { default: 'common' },
        },
        removal: {},
      },
      /signIn.tokenUrl must hold \{tenant\} once, for signIn.tenant/,
    ],
    [
      'a URL that holds {tenant} twice',
      {
        signIn: {
          ...acme.signIn,
          revokeUrl: undefined,
          authorizeUrl: 'https://auth.acme.example/{tenant}/{tenant}/authorize',
          tokenUrl: 'https://auth.acme.example/{tenant}/token',
          tenant: { default: 'common' },
        },
        removal: {},
      },
      /signIn.authorizeUrl must hold \{tenant\} once, for signIn.tenant/,
    ],
    [
      "a tenant default that isn't a directory's name",
      {
        signIn: {
          ...acme.signIn,
          authorizeUrl: 'https://auth.acme.example/{tenant}/authorize',
          tokenUrl: 'https://auth.acme.example/{tenant}/token',
          tenant: { default: 'acme/../other' },
        },
      },
      /signIn.tenant.default must match/,
    ],
    [
      'a tenant default that is a dot path segment',
      {
        signIn: {
          ...acme.signIn,
          authorizeUrl: 'https://auth.acme.example/{tenant}/authorize',
          tokenUrl: 'https://auth.acme.example/{tenant}/token',
          tenant: { default: '..' },
        },
      },
      /signIn.tenant.default must match/,
    ],
    [
      "a signIn.tenant that isn't an object",
      {
        signIn: {
          ...acme.signIn,
          authorizeUrl: 'https://auth.acme.example/{tenant}/authorize',
          tokenUrl: 'https://auth.acme.example/{tenant}/token',
          tenant: 'common',
        },
      },
      /signIn.tenant must be an object/,
    ],
    [
      'a revokeUrl with {tenant} without signIn.tenant',
      { signIn: { ...acme.signIn, revokeUrl: 'https://auth.acme.example/{tenant}/revoke' } },
      /signIn.revokeUrl has \{tenant\}, so signIn.tenant is needed/,
    ],
    [
      'a revokeUrl that holds {tenant} twice',
      {
        signIn: {
          ...acme.signIn,
          authorizeUrl: 'https://auth.acme.example/{tenant}/authorize',
          tokenUrl: 'https://auth.acme.example/{tenant}/token',
          revokeUrl: 'https://auth.acme.example/{tenant}/{tenant}/revoke',
          tenant: {},
        },
      },
      /signIn.revokeUrl can hold \{tenant\} once at most/,
    ],
    [
      'a profile lookup whose URL holds {tenant}',
      {
        signIn: {
          ...acme.signIn,
          authorizeUrl: 'https://auth.acme.example/{tenant}/authorize',
          tokenUrl: 'https://auth.acme.example/{tenant}/token',
          tenant: {},
        },
        account: {
          kind: 'profile',
          url: 'https://api.acme.example/{tenant}/me',
          scopes: [],
          id: 'id',
          label: ['mail'],
        },
      },
      /account.url can't hold \{tenant\}/,
    ],
    [
      'an empty sign-in scope',
      { signIn: { ...acme.signIn, scopes: ['offline_access', ''] } },
      /signIn.scopes\[1\] must be a non-empty string/,
    ],
    [
      "a scopeResource that isn't https",
      { signIn: { ...acme.signIn, scopeResource: 'http://api.acme.example/' } },
      /signIn.scopeResource must be an https URL/,
    ],
    [
      'a profile lookup on a github-app sign-in',
      {
        signIn: { kind: 'github-app' },
        account: {
          kind: 'profile',
          url: 'https://api.acme.example/me',
          scopes: [],
          id: 'id',
          label: ['email'],
        },
        removal: {},
      },
      /account.kind "profile" needs an "oauth2" sign-in/,
    ],
    [
      "a profile url that isn't https",
      {
        account: {
          kind: 'profile',
          url: 'http://api.acme.example/me',
          scopes: [],
          id: 'id',
          label: ['email'],
        },
      },
      /account.url must be an https URL/,
    ],
    [
      'a profile lookup with no label field',
      {
        account: {
          kind: 'profile',
          url: 'https://api.acme.example/me',
          scopes: [],
          id: 'id',
          label: [],
        },
      },
      /account.label must name at least one field/,
    ],
    [
      'a profile lookup with no id field',
      {
        account: {
          kind: 'profile',
          url: 'https://api.acme.example/me',
          scopes: [],
          id: '',
          label: ['email'],
        },
      },
      /account.id must be a non-empty string/,
    ],
  ])('refuses %s, naming the field', (_what, patch, message) => {
    expect(() => defineApp(withAcme(patch))).toThrow(TypeError);
    expect(() => defineApp(withAcme(patch))).toThrow(message);
  });

  it('names the entry in its error', () => {
    expect(() => defineApp(withAcme({ name: '' }))).toThrow('defineApp("acme"): name');
  });

  it('refuses something that is not an object', () => {
    expect(() => defineApp(null as unknown as AppEntry)).toThrow(
      'defineApp: the entry must be an object',
    );
  });
});
