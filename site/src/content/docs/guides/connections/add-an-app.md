---
title: Add an app
description: What an app's entry tells Kindgi, from how its people sign in to how its tokens are withdrawn, for adding an app Kindgi doesn't have yet.
sidebar:
  order: 40
  label: Add an app
---

Kindgi knows an app through its entry: data that says how people sign in to
it, what its permissions mean in plain words, how its tokens are withdrawn,
and how it reports an uninstall. The app's tools sit next to its entry.
Google and GitHub have entries in `@kindgi/connections`.

An app that signs people in with standard OAuth 2.0 (the authorization code
flow, with PKCE) fits the sign-in Kindgi already has, so adding it takes
only its entry and its tools in `@kindgi/connections`, and its setup page
in these docs. An app that signs in
some other way needs code in the runtime as well.

## An entry

```ts excerpt
export const acmeCrm = defineApp({
  id: 'acme-crm',
  name: 'Acme CRM',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://crm.acme.com/oauth/authorize',
    tokenUrl: 'https://crm.acme.com/oauth/token',
    revokeUrl: 'https://crm.acme.com/oauth/revoke',
    pkce: 'S256',
  },
  owners: ['member'],
  permissions: {
    'contacts.read': { grants: 'contacts:read', says: 'Read your contacts', changes: false },
    'notes.write': { grants: 'notes:write', says: 'Add notes as you', changes: true },
  },
  account: { kind: 'openid', issuers: ['https://crm.acme.com'], scopes: ['openid', 'email'] },
  removal: { revoke: 'oauth2-revoke' },
  rateLimits: [{ per: 'connection', units: 600, perSeconds: 60 }],
  setupGuide: '/guides/connections/acme-crm/',
});
```

- **`id`** and **`name`:** how tools and people refer to the app.
- **`signIn`:** how people sign in. `oauth2` takes the app's authorize,
  token and revoke addresses, and any extra parameters its authorize page
  needs (`authorizeParams`).
- **`owners`:** who can own a connection to it: `'member'`, a person in
  your workspace, for their own account; `'company'`, for the company's;
  or both.
- **`account`:** how Kindgi learns whose account it is, so lists and
  approvals can show it.
- **`removal`:** how a token is withdrawn at the app, and how the app
  reports an uninstall, if it does.
- **`rateLimits`:** the app's limits for each connection: how many units
  it allows in how many seconds.
- **`setupGuide`:** the page in these docs that tells an admin how to
  register the app, as a path such as `/guides/connections/acme-crm/`.

## Permissions

Each permission has a name your tools use, the app's own scope or
permission it grants, plain words people see when they connect and when
they approve, and whether it changes anything (`changes: false` is read
only). Where the app reviews what its permissions reach, such as Google's
sensitive and restricted scopes, `review` gives that permission's class.

Name what a tool needs, and nothing more: a tool that only reads asks only
for read permissions. A person can allow less than what's asked on the
app's page, and Kindgi keeps only what they allowed.
