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

  it("is a member's own account or the company's mailbox, signed in with OAuth and PKCE", () => {
    expect(google.owners).toEqual(['member', 'company']);
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

  it("asks for calendar permissions that reach only the account's own calendars", () => {
    expect(google.permissions['calendar.events.owned.readonly']).toEqual({
      grants: 'https://www.googleapis.com/auth/calendar.events.owned.readonly',
      says: 'See the events on your calendars',
      changes: false,
      review: 'sensitive',
    });
    expect(google.permissions['calendar.freebusy']).toEqual({
      grants: 'https://www.googleapis.com/auth/calendar.freebusy',
      says: "See when you're free or busy",
      changes: false,
      review: 'sensitive',
    });
    expect(google.permissions['calendar.events.owned']).toEqual({
      grants: 'https://www.googleapis.com/auth/calendar.events.owned',
      says: 'Add and change events on your calendars',
      changes: true,
      review: 'sensitive',
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

  it("paces mail in Gmail's quota units, 6,000 a minute per mailbox, and calendar calls at 600", () => {
    // developers.google.com/workspace/gmail/api/reference/quota (read 2026-10-26),
    // developers.google.com/workspace/calendar/api/guides/quota (read 2026-10-31).
    expect(google.rateLimits).toEqual([
      {
        per: 'connection',
        units: 6000,
        perSeconds: 60,
        costs: {
          'gmail.send': 100,
          'gmail.messages.get': 60,
          'gmail.messages.get.metadata': 20,
          'gmail.threads.get': 120,
          'gmail.messages.list': 5,
          'gmail.history.list': 2,
          'gmail.profile.get': 1,
          'calendar.events.list': 0,
          'calendar.events.get': 0,
          'calendar.events.insert': 0,
          'calendar.events.patch': 0,
          'calendar.freebusy.query': 0,
        },
      },
      {
        per: 'connection',
        units: 600,
        perSeconds: 60,
        costs: {
          'gmail.send': 0,
          'gmail.messages.get': 0,
          'gmail.messages.get.metadata': 0,
          'gmail.threads.get': 0,
          'gmail.messages.list': 0,
          'gmail.history.list': 0,
          'gmail.profile.get': 0,
        },
      },
    ]);
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
    expect(github.permissions['issues.write']).toMatchObject({
      grants: 'issues:write',
      changes: true,
    });
  });

  it("reads and commits a repository's files, and opens its pull requests, for a project's repo connection", () => {
    expect(Object.keys(github.permissions)).toEqual([
      'issues.read',
      'issues.write',
      'contents.read',
      'contents.write',
      'pull_requests.read',
      'pull_requests.write',
    ]);
    expect(github.permissions['contents.write']).toMatchObject({
      grants: 'contents:write',
      changes: true,
    });
    expect(github.permissions['pull_requests.write']).toMatchObject({
      grants: 'pull_requests:write',
      changes: true,
    });
  });
});

describe('the Microsoft entry', () => {
  it('is a checked, frozen entry', () => {
    expect(defineApp(microsoft)).toEqual(microsoft);
    expect(Object.isFrozen(microsoft)).toBe(true);
  });

  it("is a member's own account or the company's mailbox, signed in with OAuth and PKCE in the registration's directory", () => {
    expect(microsoft.owners).toEqual(['member', 'company']);
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

  it('says what mail and calendar permissions allow, and which change anything', () => {
    expect(microsoft.permissions).toEqual({
      'mail.send': { grants: 'Mail.Send', says: 'Send mail as you', changes: true },
      'mail.read': { grants: 'Mail.Read', says: 'Read your mail', changes: false },
      'calendars.readbasic': {
        grants: 'Calendars.ReadBasic',
        says: "See your calendar's events, without their details",
        changes: false,
      },
      'calendars.readwrite': {
        grants: 'Calendars.ReadWrite',
        says: 'Read, add and change events on your calendar',
        changes: true,
      },
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
        // Reads, the mail calls' delta and the calendar's too, never count
        // against sends. A calendar create or update can send meeting
        // requests, so it counts.
        costs: {
          'outlook.messages.list': 0,
          'outlook.messages.get': 0,
          'outlook.messages.delta': 0,
          'outlook.folders.get': 0,
          'outlook.calendar.view': 0,
          'outlook.events.get': 0,
        },
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

  it("is a member's own profile, signed in with OAuth and PKCE, with no refresh token needed", () => {
    expect(linkedin.owners).toEqual(['member']);
    expect(linkedin.signIn).toEqual({
      kind: 'oauth2',
      authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
      pkce: 'S256',
      // LinkedIn gives refresh tokens only to the partners it approves.
      refreshToken: 'optional',
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

  it("learns whose profile it is from the ID token, at LinkedIn's live issuer first and its documented one too", () => {
    expect(linkedin.account).toEqual({
      kind: 'openid',
      issuers: ['https://www.linkedin.com/oauth', 'https://www.linkedin.com'],
      scopes: ['openid', 'email'],
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
