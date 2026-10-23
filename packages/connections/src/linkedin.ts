// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * LinkedIn, for a member's own profile: posts made as them. Each tenant
 * registers its own app at LinkedIn's developer portal, with the two
 * self-serve products "Share on LinkedIn" and "Sign In with LinkedIn using
 * OpenID Connect", which need no review (the setup guide says how). Posts
 * as a company Page are another product that LinkedIn vets first, and
 * aren't here.
 *
 * - **Sign-in:** OAuth 2.0 with PKCE. LinkedIn's access token lasts 60
 *   days, and it gives refresh tokens only to the partners it approves, so
 *   a connection asks its person to connect again after that. Connecting
 *   again skips LinkedIn's consent page while they're signed in there and
 *   the old token is still live. An app that asks for other scopes later
 *   ends the tokens it gave before.
 * - **Whose account:** OpenID Connect's userinfo: `sub`, the member's id,
 *   which is also their posts' author (`urn:li:person:{sub}`); the label is
 *   their name. The ID token can't say it for every member: its `email` is
 *   there only with the `email` scope, which isn't asked for.
 * - **Withdrawing:** LinkedIn has no revoke endpoint for one app's tokens,
 *   so a disconnect deletes Kindgi's, and the person removes the app at
 *   LinkedIn (the setup guide says where).
 * - **Rate limits:** 150 calls a day per member. LinkedIn's 100,000 a day
 *   per app are the registration's, across all its members, and its own to
 *   enforce: a 429 says so.
 */
export const linkedin = defineApp({
  id: 'linkedin',
  name: 'LinkedIn',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    pkce: 'S256',
  },
  owners: ['member'],
  permissions: {
    'posts.write': {
      grants: 'w_member_social',
      says: 'Post, comment and react on LinkedIn as you',
      changes: true,
    },
  },
  account: {
    kind: 'profile',
    url: 'https://api.linkedin.com/v2/userinfo',
    scopes: ['openid', 'profile'],
    id: 'sub',
    label: ['name'],
  },
  removal: {},
  rateLimits: [{ per: 'connection', units: 150, perSeconds: 86_400 }],
  setupGuide: '/guides/connections/linkedin/',
});
