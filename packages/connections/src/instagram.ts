// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * Instagram, for the company: photos posted to its Instagram professional
 * account. The company connects through Kindgi's own Meta app, so it
 * registers nothing at Meta or with Kindgi (the setup guide says what an
 * admin does).
 *
 * - **Sign-in:** Facebook Login for Business, through Kindgi's connect step,
 *   with this entry's own configuration at Meta: it grants only the
 *   permissions below, on Instagram accounts, so its token can't post on
 *   the business's Facebook Pages. The token is the business's, not a
 *   person's, and Meta sets it never to expire, so there's no refresh.
 * - **Whose account:** an Instagram professional account the admin shared
 *   with Kindgi's app when they said yes: its id, labelled with its
 *   `@username`. When they shared several, the console asks which.
 * - **Withdrawing:** a disconnect withdraws nothing at Meta: it deletes
 *   Kindgi's token, and the business removes Kindgi at Meta (the setup
 *   guide says where).
 */
export const instagram = defineApp({
  id: 'instagram',
  name: 'Instagram',
  signIn: { kind: 'kindgi-app' },
  owners: ['company'],
  permissions: {
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
  },
  account: { kind: 'kindgi-app-account', asset: 'instagram' },
  removal: {},
  setupGuide: '/guides/connections/instagram/',
});
