// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/** The Calendar API's calls, by their own names: none counts in Gmail's units. */
const CALENDAR_CALLS_FREE = {
  'calendar.events.list': 0,
  'calendar.events.get': 0,
  'calendar.events.insert': 0,
  'calendar.events.patch': 0,
  'calendar.freebusy.query': 0,
} as const;

/**
 * Google, for a member's own account or the company's (a tenant admin
 * signs in as it): mail sent as them, their mail read, and their own
 * calendar's events read, added and changed. Each tenant registers its
 * own Google Cloud project and OAuth client (the setup guide says how).
 *
 * - **Sign-in:** OAuth 2.0 with PKCE. `access_type=offline` gets a refresh
 *   token, and `include_granted_scopes` keeps what the person granted
 *   before when a tool asks for more. `prompt=consent` shows the consent
 *   page each time, so a refresh token comes back each time.
 * - **Whose account:** the ID token's `sub` and `email`. Google's ID
 *   tokens carry `iss` as `https://accounts.google.com` or
 *   `accounts.google.com`.
 * - **Withdrawing:** Google's revoke withdraws everything the person
 *   granted the registration, so a disconnect withdraws it at Google only
 *   when no other connection of theirs uses that grant.
 * - **Rate limits:** 6,000 units a minute per connection, in Gmail's quota
 *   units: a send costs 100, reading a message 60 (20 for its headers or
 *   its date only), a thread 120, a message list 5, the mailbox's history 2 and its
 *   profile 1. The Calendar API's 600 requests a minute per person, each
 *   call 1. Its 10,000 a minute for the tenant's whole Google Cloud
 *   project is Google's own to enforce: a call over it is refused as a
 *   rate limit, and `appFetch` tries again.
 */
export const google = defineApp({
  id: 'google',
  name: 'Google',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    pkce: 'S256',
    authorizeParams: { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' },
  },
  owners: ['member', 'company'],
  permissions: {
    'gmail.send': {
      grants: 'https://www.googleapis.com/auth/gmail.send',
      says: 'Send mail as you',
      changes: true,
      review: 'sensitive',
    },
    'gmail.readonly': {
      grants: 'https://www.googleapis.com/auth/gmail.readonly',
      says: 'Read your mail',
      changes: false,
      review: 'restricted',
    },
    'calendar.events.owned.readonly': {
      grants: 'https://www.googleapis.com/auth/calendar.events.owned.readonly',
      says: 'See the events on your calendars',
      changes: false,
      review: 'sensitive',
    },
    'calendar.freebusy': {
      grants: 'https://www.googleapis.com/auth/calendar.freebusy',
      says: "See when you're free or busy",
      changes: false,
      review: 'sensitive',
    },
    'calendar.events.owned': {
      grants: 'https://www.googleapis.com/auth/calendar.events.owned',
      says: 'Add and change events on your calendars',
      changes: true,
      review: 'sensitive',
    },
  },
  account: {
    kind: 'openid',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scopes: ['openid', 'email'],
  },
  removal: { revoke: 'oauth2-revoke', revokeIsGrantWide: true, notices: 'google-risc' },
  rateLimits: [
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
        ...CALENDAR_CALLS_FREE,
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
  ],
  setupGuide: '/guides/connections/google/',
});
