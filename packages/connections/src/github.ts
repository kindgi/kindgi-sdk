// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * GitHub, for the company: a GitHub App the tenant registers and installs
 * on its organization. Any run in a project the registration allows may
 * use it, scheduled runs included.
 *
 * - **Sign-in:** the app's installation. Its tokens are made from the
 *   app's private key, for that installation only.
 * - **Whose account:** the installation's account (its id and login).
 * - **Withdrawing:** a disconnect revokes the installation token; the
 *   app stays installed until an admin uninstalls it at GitHub, which
 *   GitHub reports to the server by webhook.
 */
export const github = defineApp({
  id: 'github',
  name: 'GitHub',
  signIn: { kind: 'github-app' },
  owners: ['company'],
  permissions: {
    'issues.read': { grants: 'issues:read', says: 'Read issues', changes: false },
    'issues.write': { grants: 'issues:write', says: 'Label and edit issues', changes: true },
  },
  account: { kind: 'github-installation' },
  removal: { revoke: 'github-installation-token', notices: 'github-webhooks' },
  setupGuide: '/guides/connections/github/',
});
