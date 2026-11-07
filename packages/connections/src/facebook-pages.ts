// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * Facebook Pages, for the company: posts made as one of its Pages. The
 * company connects through Kindgi's own Meta app, so it registers nothing at
 * Meta or with Kindgi (the setup guide says what an admin does).
 *
 * - **Sign-in:** Facebook Login for Business, through Kindgi's connect step,
 *   with this entry's own configuration at Meta: it grants only the
 *   permissions below, on Pages. The token is the business's, not a
 *   person's, and Meta sets it never to expire, so there's no refresh.
 * - **Whose account:** a Page the admin shared with Kindgi's app when they
 *   said yes: its id, labelled with its name. When they shared several, the
 *   console asks which.
 * - **Withdrawing:** a disconnect withdraws nothing at Meta: it deletes
 *   Kindgi's token, and the business removes Kindgi at Meta (the setup
 *   guide says where).
 * - **Rate limits:** Meta counts the business's calls for each Page, not
 *   across every business on Kindgi's app, and its own refusal says when
 *   they're over.
 */
export const facebookPages = defineApp({
  id: 'facebook-pages',
  name: 'Facebook Pages',
  signIn: { kind: 'kindgi-app' },
  owners: ['company'],
  permissions: {
    'posts.write': {
      grants: 'pages_manage_posts',
      says: 'Post on the Page as the Page, and delete what it posted',
      changes: true,
    },
    'pages.read': {
      grants: 'pages_read_engagement',
      says: "See the Page's name and posts",
      changes: false,
    },
  },
  account: { kind: 'kindgi-app-account', asset: 'page' },
  removal: {},
  setupGuide: '/guides/connections/facebook-pages/',
});
