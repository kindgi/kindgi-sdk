// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * Asana, through Asana's own MCP server: its tools (tasks, projects,
 * comments and the rest) act with a person's own Asana account, or with
 * one the company shares. Each workspace registers its own MCP app in
 * Asana's developer console (the setup guide says how), and registers the
 * server as an MCP endpoint with
 * `auth: { scheme: 'connection', app: 'asana', as }`.
 *
 * - **Sign-in:** OAuth 2.0 with PKCE at Asana's authorization server,
 *   `https://app.asana.com`, which the v2 server's metadata names, with the
 *   client secret in the token request's body. (`https://mcp.asana.com`'s
 *   own authorization server is the older server's, which registers its
 *   own clients.) Asana's MCP apps
 *   have no scopes to ask for, so the sign-in asks for none
 *   (`scopesFrom: 'registration'`), and the one permission is what the app
 *   is granted. The access token lasts an hour and is renewed with its
 *   refresh token; it works with Asana's MCP server only.
 * - **Whose account:** Asana names none for these tokens, so the
 *   connection's account is its owner (`account: { kind: 'none' }`): one
 *   connection per person, or one for the company.
 * - **Withdrawing:** a disconnect deletes Kindgi's tokens, and the person
 *   removes the app's access at Asana (the setup guide says where).
 * - **Tokens:** go to `https://mcp.asana.com` only, minted for the
 *   `resource` the v2 server's metadata names, `https://mcp.asana.com/v2/mcp`.
 */
export const asana = defineApp({
  id: 'asana',
  name: 'Asana',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    pkce: 'S256',
    scopesFrom: 'registration',
  },
  owners: ['member', 'company'],
  permissions: {
    'mcp.tools': {
      grants: 'mcp.tools',
      says: "Use Asana's tools as you: read and change the tasks, projects and comments your Asana user may",
      changes: true,
    },
  },
  account: { kind: 'none' },
  removal: {},
  setupGuide: '/guides/connections/asana/',
  mcpServers: [
    {
      origin: 'https://mcp.asana.com',
      resource: 'https://mcp.asana.com/v2/mcp',
      issuer: 'https://app.asana.com',
    },
  ],
});
