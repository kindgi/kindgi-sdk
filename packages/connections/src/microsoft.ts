// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * Microsoft, for a member's own work, school or personal account: mail
 * sent as them through Outlook, their mail read. Each tenant registers its
 * own app in Microsoft Entra (the setup guide says how).
 *
 * - **Sign-in:** OAuth 2.0 with PKCE, in the directory the registration
 *   names: its tenant id or domain for a single-tenant app (a company's
 *   own, the usual one), `organizations` for any work or school account,
 *   `common` to take personal accounts too, `consumers` for personal ones
 *   only. There's no default: Microsoft signs in a single-tenant app only
 *   at its own directory, and refuses it at `organizations` or `common` on
 *   its own page, where the server never hears of it. `offline_access`
 *   gets a refresh token, and `prompt=select_account` lets a person signed
 *   in to several accounts choose.
 * - **Granted scopes:** Microsoft may name one with its resource and in
 *   lowercase (`https://graph.microsoft.com/mail.send`), so the server
 *   compares them without the resource, in any case.
 * - **Whose account:** Microsoft Graph's `/me`: `id`, the person's object
 *   id, the same for every app in their directory; the label is `mail`,
 *   else `userPrincipalName`. The ID token can't say it: its issuer is the
 *   person's own directory, and its `email` isn't always there.
 * - **Withdrawing:** Microsoft has no revoke endpoint for one app's
 *   tokens, so a disconnect deletes Kindgi's, and the person removes the
 *   app at Microsoft (the setup guide says where).
 * - **Rate limits:** Graph's 10,000 requests per 10 minutes per mailbox,
 *   and Exchange's 30 messages a minute. Graph's 4 calls at once per
 *   mailbox, and Exchange's 10,000 recipients a day, are its own to
 *   enforce: a 429 says how long to wait.
 */
export const microsoft = defineApp({
  id: 'microsoft',
  name: 'Microsoft',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    pkce: 'S256',
    authorizeParams: { prompt: 'select_account' },
    scopes: ['offline_access'],
    scopeResource: 'https://graph.microsoft.com/',
    tenant: {},
  },
  owners: ['member'],
  permissions: {
    'mail.send': { grants: 'Mail.Send', says: 'Send mail as you', changes: true },
    'mail.read': { grants: 'Mail.Read', says: 'Read your mail', changes: false },
  },
  account: {
    kind: 'profile',
    url: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['User.Read'],
    id: 'id',
    label: ['mail', 'userPrincipalName'],
  },
  removal: {},
  rateLimits: [
    { per: 'connection', units: 10_000, perSeconds: 600 },
    {
      per: 'connection',
      units: 30,
      perSeconds: 60,
      costs: { 'outlook.messages.list': 0, 'outlook.messages.get': 0 },
    },
  ],
  setupGuide: '/guides/connections/microsoft/',
});
