// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * HubSpot, through HubSpot's own MCP server: its tools (contacts,
 * companies, deals, tickets, notes, tasks and the rest) act with a
 * person's own HubSpot account, or with one the company shares. Each
 * workspace registers its own MCP connector in its HubSpot developer
 * account (the setup guide says where), and registers the server as an
 * MCP endpoint with `auth: { scheme: 'connection', app: 'hubspot', as }`.
 *
 * - **Sign-in:** OAuth 2.0 with PKCE at HubSpot's MCP authorization
 *   server, with the client secret in the token request's body. The
 *   connector's own settings in HubSpot set the scopes, so the sign-in
 *   asks for none (`scopesFrom: 'registration'`), and the one permission
 *   is what the connector grants.
 * - **Whose account:** HubSpot names none for these tokens, so the
 *   connection's account is its owner (`account: { kind: 'none' }`): one
 *   connection per person, or one for the company.
 * - **Withdrawing:** HubSpot has no revoke endpoint for these tokens, so a
 *   disconnect deletes Kindgi's, and the person removes the connector at
 *   HubSpot (the setup guide says where).
 * - **Tokens:** go to `https://mcp.hubspot.com` only, minted for its
 *   `resource`.
 */
export const hubspot = defineApp({
  id: 'hubspot',
  name: 'HubSpot',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://mcp.hubspot.com/oauth/authorize/user',
    tokenUrl: 'https://mcp.hubspot.com/oauth/v3/token',
    pkce: 'S256',
    scopesFrom: 'registration',
  },
  owners: ['member', 'company'],
  permissions: {
    'mcp.tools': {
      grants: 'mcp.tools',
      says: "Use HubSpot's tools as you: read and change the records your HubSpot user may, as far as the connector allows",
      changes: true,
    },
  },
  account: { kind: 'none' },
  removal: {},
  setupGuide: '/guides/connections/hubspot/',
  mcpServers: [
    {
      origin: 'https://mcp.hubspot.com',
      resource: 'https://mcp.hubspot.com',
      issuer: 'https://mcp.hubspot.com',
    },
  ],
});
