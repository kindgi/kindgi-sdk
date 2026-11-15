---
title: Add an app
description: What an app's entry tells Kindgi, from how its people sign in to how its tokens are withdrawn, for adding an app Kindgi doesn't have yet.
sidebar:
  order: 40
  label: Add an app
---

Kindgi knows an app through its entry: data that says how people sign in to
it, what its permissions mean in plain words, how its tokens are withdrawn,
and how it reports access removed at the app. The app's tools sit next to
its entry.
Google, Microsoft, GitHub, LinkedIn, HubSpot and Asana have entries in
`@kindgi/connections`.

An app that signs people in with standard OAuth 2.0 (the authorization code
flow, with PKCE) fits the sign-in Kindgi already has, so adding it takes
its entry and its tools in `@kindgi/connections`, its setup page in these
docs, and a runtime release that serves it: a runtime registers only the
apps whose entries it ships with. An app that signs in
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
  token and revoke addresses, any extra parameters its authorize page
  needs (`authorizeParams`), scopes it asks for at every sign-in
  (`scopes`), and the resource the app may name its granted scopes with
  (`scopeResource`). For an app that signs people in at a directory, such
  as Microsoft, set `tenant` (`{}`, or with a `default`), and `{tenant}` in
  its addresses is filled from each registration's directory. For an app
  that may give no refresh token, such as LinkedIn, set `refreshToken:
  'optional'`. A connect that brings none then works until just before
  its access token ends, which the app's token answer must say
  (`expires_in`), and needs reconnecting from then. A refresh token the app gives anyway is
  used as usual. By default, a connect that brings no refresh token, with
  none kept from before, is refused. For an app whose registration at the
  app sets the scopes, set `scopesFrom: 'registration'`
  ([An app with its own MCP server](#an-app-with-its-own-mcp-server)).
- **`owners`:** who can own a connection to it: `'member'`, a person in
  your workspace, for their own account; `'company'`, for the company's;
  or both.
- **`account`:** how Kindgi learns whose account it is, so lists and
  approvals can show it. `openid` reads the sign-in's ID token; `profile`
  asks a URL with the new token, and reads the account's id and a label
  from named fields of the answer. `none` looks nothing up: the owner is
  the account
  ([An app with its own MCP server](#an-app-with-its-own-mcp-server)).
- **`removal`:** how a token is withdrawn at the app (`revoke`), whether
  that withdraws everything the person allowed your registration
  (`revokeIsGrantWide`: Google's does), and how the app reports access
  removed at the app (`notices`), if it does.
- **`rateLimits`:** the app's limits for each connection: how many units
  it allows in how many seconds, and in `costs`, how many units a call
  takes, by its operation's name. One not listed takes 1, and a cost of 0
  leaves the call out of that limit.
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
app's page, and Kindgi keeps only what they allowed. A reconnect never
takes away what a connection already has. If they allow at least what it
has, Kindgi keeps the new grant, and a connection that needed
reconnecting works again. If they allow less, the connection stays as it
was. Either way, if the connection still can't do what was asked, the
reconnect is declined, naming what they didn't allow.

## An app with its own MCP server

Some apps run an MCP server of their own, such as HubSpot's and Asana's,
which signs people in with OAuth. The entry lists the server, and an MCP
endpoint registered at the runtime for it signs in with a connection
([Sign in as a connection](../../tools/mcp-servers/#sign-in-as-a-connection)).
Its tools come from the server, so the entry has no tools next to it:
adding the app takes its entry, its setup page and a runtime release that
serves it.

```ts excerpt
export const acmeTasks = defineApp({
  id: 'acme-tasks',
  name: 'Acme Tasks',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://mcp.tasks.acme.com/authorize',
    tokenUrl: 'https://mcp.tasks.acme.com/token',
    pkce: 'S256',
    scopesFrom: 'registration',
  },
  owners: ['member', 'company'],
  permissions: {
    'mcp.tools': { grants: 'mcp.tools', says: "Use Acme Tasks' tools as you", changes: true },
  },
  account: { kind: 'none' },
  removal: {},
  mcpServers: [
    {
      origin: 'https://mcp.tasks.acme.com',
      resource: 'https://mcp.tasks.acme.com/v1',
      issuer: 'https://mcp.tasks.acme.com',
    },
  ],
  setupGuide: '/guides/connections/acme-tasks/',
});
```

- **`mcpServers`:** the app's MCP servers, each with:
  - `origin`: an https origin only, with no path and no trailing `/`. A
    connection's token goes only to a listed origin;
  - `resource`: the resource each token is minted for (RFC 8707), on
    `origin`, with no query, fragment or user;
  - `issuer`: the authorization server the server's Protected Resource
    Metadata must name, https, with no query or fragment.
- **`signIn.scopesFrom: 'registration'`:** the app's registration at the
  app sets the scopes, so the sign-in asks for none: it sends no `scope`.
  Every connection then holds all of the entry's permissions, and each
  permission's `grants` is its own key. The default, `'sign-in'`, asks for
  the permissions the connect names.
- **`account: { kind: 'none' }`:** Kindgi doesn't look the account up, and
  the owner is the account: a person's own, or the company's. A connection
  is named after the app, such as `HubSpot`, unless the connect names it.
  So each owner has one connection to the app in an environment, and
  connecting again renews it.
- **`removal: {}`:** Kindgi withdraws nothing at the app when someone
  disconnects, and only destroys the stored token.

`defineApp` refuses:

- `mcpServers` without an `oauth2` sign-in, an empty list, or an origin
  listed twice;
- with `scopesFrom: 'registration'`: `signIn.scopes`,
  `signIn.scopeResource`, an `openid` account, a `profile` account with
  `scopes`, and a permission whose `grants` isn't its key;
- `scopesFrom` on a `github-app` or `token` sign-in, and `account: { kind:
  'none' }` on any sign-in but `oauth2`.

A tool of your pack can't declare a need for an app with `mcpServers`: its
token is for the app's MCP server only, and never reaches a tool's
`ctx.connections`.
