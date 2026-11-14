// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/** Outlook's calls, mail and calendars, by their own names: none counts in OneDrive's and SharePoint's requests. */
const OUTLOOK_CALLS_FREE = {
  'outlook.messages.list': 0,
  'outlook.messages.get': 0,
  'outlook.attachments.get': 0,
  'outlook.messages.delta': 0,
  'outlook.folders.get': 0,
  'outlook.calendar.view': 0,
  'outlook.calendars.list': 0,
  'outlook.events.get': 0,
  'outlook.send': 0,
  'outlook.reply': 0,
  'outlook.events.create': 0,
  'outlook.events.update': 0,
} as const;

/**
 * OneDrive's and SharePoint's calls, by their own names: none counts in the
 * mailbox's requests or its sends. A create that finds a file of its name
 * already there reads that file's details (`onedrive.items.get`).
 */
const FILE_CALLS_FREE = {
  'onedrive.items.list': 0,
  'onedrive.items.search': 0,
  'onedrive.items.get': 0,
  'onedrive.content.put': 0,
  'sharepoint.sites.search': 0,
  'sharepoint.drives.list': 0,
} as const;

/**
 * Microsoft, for a member's own work, school or personal account, or the
 * company's (a tenant admin signs in as it): mail sent as them through
 * Outlook, their mail read, their Outlook calendars listed and their
 * events read, those others share with them too, events on their main
 * calendar added and changed, the files in their OneDrive listed and added
 * to, and the files others share with them and their organization's
 * SharePoint libraries listed. Each workspace registers its own app in
 * Microsoft Entra (the setup guide says how).
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
 *   calendar calls included, and Exchange's 30 messages a minute. A
 *   calendar read isn't a message; a create or an update counts as one,
 *   since one with attendees sends meeting requests. Graph's 4 calls at
 *   once per mailbox, and Exchange's 10,000 recipients a day, are its own
 *   to enforce: a 429 says how long to wait. OneDrive and SharePoint calls
 *   count in neither: they have their own 3,000 per 5 minutes, SharePoint
 *   Online's default for one person's requests, which Kindgi keeps for a
 *   personal OneDrive too, where Microsoft names none.
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
  owners: ['member', 'company'],
  permissions: {
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
    'calendars.read.shared': {
      grants: 'Calendars.Read.Shared',
      says: 'See the events on your calendars, with their details, those others share with you too',
      changes: false,
    },
    'files.read': { grants: 'Files.Read', says: 'See the files in your OneDrive', changes: false },
    'files.readwrite': {
      grants: 'Files.ReadWrite',
      says: 'See, add and change the files in your OneDrive',
      changes: true,
    },
    'files.read.all': {
      grants: 'Files.Read.All',
      says: 'See all the files you can open, those others share with you too',
      changes: false,
    },
    'sites.read.all': {
      grants: 'Sites.Read.All',
      says: "See the files and lists on your organization's SharePoint sites",
      changes: false,
    },
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
    {
      per: 'connection',
      units: 10_000,
      perSeconds: 600,
      costs: {
        'outlook.messages.list': 1,
        'outlook.messages.get': 1,
        'outlook.attachments.get': 1,
        'outlook.messages.delta': 1,
        'outlook.folders.get': 1,
        'outlook.calendar.view': 1,
        'outlook.calendars.list': 1,
        'outlook.events.get': 1,
        'outlook.send': 1,
        'outlook.reply': 1,
        'outlook.events.create': 1,
        'outlook.events.update': 1,
        ...FILE_CALLS_FREE,
      },
    },
    {
      per: 'connection',
      units: 30,
      perSeconds: 60,
      costs: {
        'outlook.messages.list': 0,
        'outlook.messages.get': 0,
        'outlook.attachments.get': 0,
        'outlook.messages.delta': 0,
        'outlook.folders.get': 0,
        'outlook.calendar.view': 0,
        'outlook.calendars.list': 0,
        'outlook.events.get': 0,
        // A send or a reply goes out; a calendar create or update can send meeting requests.
        'outlook.send': 1,
        'outlook.reply': 1,
        'outlook.events.create': 1,
        'outlook.events.update': 1,
        ...FILE_CALLS_FREE,
      },
    },
    {
      per: 'connection',
      units: 3_000,
      perSeconds: 300,
      costs: {
        ...OUTLOOK_CALLS_FREE,
        'onedrive.items.list': 1,
        'onedrive.items.search': 1,
        'onedrive.items.get': 1,
        'onedrive.content.put': 1,
        'sharepoint.sites.search': 1,
        'sharepoint.drives.list': 1,
      },
    },
  ],
  setupGuide: '/guides/connections/microsoft/',
});
