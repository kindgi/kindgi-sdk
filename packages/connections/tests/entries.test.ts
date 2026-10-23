// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { github } from '../src/github.js';
import { google } from '../src/google.js';
import { SIGN_IN_TENANT_PATTERN, defineApp } from '../src/index.js';
import { linkedin } from '../src/linkedin.js';
import { microsoft } from '../src/microsoft.js';

describe('the Google entry', () => {
  it('is a checked, frozen entry', () => {
    expect(defineApp(google)).toEqual(google);
    expect(Object.isFrozen(google)).toBe(true);
  });

  it("is a member's own account, signed in with OAuth and PKCE", () => {
    expect(google.owners).toEqual(['member']);
    expect(google.signIn).toMatchObject({
      kind: 'oauth2',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      revokeUrl: 'https://oauth2.googleapis.com/revoke',
      pkce: 'S256',
    });
    // A refresh token each time, and earlier grants kept when a tool asks for more.
    expect(google.signIn.kind === 'oauth2' && google.signIn.authorizeParams).toEqual({
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    });
  });

  it('says what mail permissions allow, and which change anything', () => {
    expect(google.permissions['gmail.send']).toEqual({
      grants: 'https://www.googleapis.com/auth/gmail.send',
      says: 'Send mail as you',
      changes: true,
      review: 'sensitive',
    });
    expect(google.permissions['gmail.readonly']).toMatchObject({
      changes: false,
      review: 'restricted',
    });
  });

  it('learns the account from the ID token, from either form of the issuer', () => {
    expect(google.account).toEqual({
      kind: 'openid',
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      scopes: ['openid', 'email'],
    });
  });

  it('revokes grant-wide and hears removals by RISC', () => {
    expect(google.removal).toEqual({
      revoke: 'oauth2-revoke',
      revokeIsGrantWide: true,
      notices: 'google-risc',
    });
  });
});

describe('the GitHub entry', () => {
  it('is a checked, frozen entry', () => {
    expect(defineApp(github)).toEqual(github);
    expect(Object.isFrozen(github)).toBe(true);
  });

  it("is the company's GitHub App installation", () => {
    expect(github.owners).toEqual(['company']);
    expect(github.signIn).toEqual({ kind: 'github-app' });
    expect(github.account).toEqual({ kind: 'github-installation' });
    expect(github.removal).toEqual({
      revoke: 'github-installation-token',
      notices: 'github-webhooks',
    });
  });

  it('reads issues, and labels and edits them', () => {
    expect(Object.keys(github.permissions)).toEqual(['issues.read', 'issues.write']);
    expect(github.permissions['issues.write']).toMatchObject({
      grants: 'issues:write',
      changes: true,
    });
  });
});

describe('the Microsoft entry', () => {
  it('is a checked, frozen entry', () => {
    expect(defineApp(microsoft)).toEqual(microsoft);
    expect(Object.isFrozen(microsoft)).toBe(true);
  });

  it("is a member's own account, signed in with OAuth and PKCE in the registration's directory", () => {
    expect(microsoft.owners).toEqual(['member']);
    expect(microsoft.signIn).toEqual({
      kind: 'oauth2',
      authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
      pkce: 'S256',
      authorizeParams: { prompt: 'select_account' },
      // Without it, Microsoft gives no refresh token.
      scopes: ['offline_access'],
      // Microsoft may answer `https://graph.microsoft.com/mail.send` for `Mail.Send`.
      scopeResource: 'https://graph.microsoft.com/',
      // No default: Microsoft signs a single-tenant app in only at its own
      // directory, so each registration names it.
      tenant: {},
    });
    for (const directory of [
      'organizations',
      'common',
      'consumers',
      'acme.onmicrosoft.com',
      '9188040d-6c67-4c5b-b112-36a304b66dad',
    ]) {
      expect(SIGN_IN_TENANT_PATTERN.test(directory)).toBe(true);
    }
    for (const notOne of ['', '.', '..', '-acme', 'acme/../common', 'acme?x=1', 'a b']) {
      expect(SIGN_IN_TENANT_PATTERN.test(notOne)).toBe(false);
    }
  });

  it('says what mail permissions allow, and which change anything', () => {
    expect(microsoft.permissions).toEqual({
      'mail.send': { grants: 'Mail.Send', says: 'Send mail as you', changes: true },
      'mail.read': { grants: 'Mail.Read', says: 'Read your mail', changes: false },
    });
  });

  it("learns whose account it is from Graph's /me, since the ID token can't say", () => {
    expect(microsoft.account).toEqual({
      kind: 'profile',
      url: 'https://graph.microsoft.com/v1.0/me',
      scopes: ['User.Read'],
      id: 'id',
      label: ['mail', 'userPrincipalName'],
    });
  });

  it('withdraws nothing at Microsoft, which has no revoke for one app', () => {
    expect(microsoft.removal).toEqual({});
  });

  it("paces every call by Graph's mailbox limit, and sends alone by Exchange's", () => {
    expect(microsoft.rateLimits).toEqual([
      { per: 'connection', units: 10_000, perSeconds: 600 },
      {
        per: 'connection',
        units: 30,
        perSeconds: 60,
        costs: { 'outlook.messages.list': 0, 'outlook.messages.get': 0 },
      },
    ]);
    expect(microsoft.setupGuide).toBe('/guides/connections/microsoft/');
  });
});

describe('the LinkedIn entry', () => {
  it('is a checked, frozen entry', () => {
    expect(defineApp(linkedin)).toEqual(linkedin);
    expect(Object.isFrozen(linkedin)).toBe(true);
  });

  it("is a member's own profile, signed in with OAuth and PKCE", () => {
    expect(linkedin.owners).toEqual(['member']);
    expect(linkedin.signIn).toEqual({
      kind: 'oauth2',
      authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
      pkce: 'S256',
    });
  });

  it('says in plain words all that posting as the person allows', () => {
    // LinkedIn's one self-serve grant for a member covers comments and reactions too.
    expect(linkedin.permissions).toEqual({
      'posts.write': {
        grants: 'w_member_social',
        says: 'Post, comment and react on LinkedIn as you, and edit or delete what you posted',
        changes: true,
      },
    });
  });

  it("learns whose profile it is from OpenID Connect's userinfo, without asking for the email", () => {
    expect(linkedin.account).toEqual({
      kind: 'profile',
      url: 'https://api.linkedin.com/v2/userinfo',
      scopes: ['openid', 'profile'],
      id: 'sub',
      label: ['name'],
    });
  });

  it('withdraws nothing at LinkedIn, which has no revoke for one app', () => {
    expect(linkedin.removal).toEqual({});
  });

  it("paces every call by LinkedIn's daily limit per member", () => {
    expect(linkedin.rateLimits).toEqual([{ per: 'connection', units: 150, perSeconds: 86_400 }]);
    expect(linkedin.setupGuide).toBe('/guides/connections/linkedin/');
  });
});
