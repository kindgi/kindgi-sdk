// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { github } from '../src/github.js';
import { google } from '../src/google.js';
import { defineApp } from '../src/index.js';

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
