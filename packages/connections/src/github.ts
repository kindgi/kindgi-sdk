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
 * - **A project's repo connection** (`PUT /v1/projects/:id/repo-connection`)
 *   uses `contents.write` and `pull_requests.write` to open a draft pull
 *   request when a block change is pinned there, and `pull_requests.read`
 *   to say whether it was merged.
 */
export const github = defineApp({
  id: 'github',
  name: 'GitHub',
  signIn: { kind: 'github-app' },
  owners: ['company'],
  permissions: {
    'issues.read': { grants: 'issues:read', says: 'Read issues', changes: false },
    'issues.write': { grants: 'issues:write', says: 'Label and edit issues', changes: true },
    'contents.read': { grants: 'contents:read', says: 'Read repository files', changes: false },
    'contents.write': {
      grants: 'contents:write',
      says: 'Make branches and commit files',
      changes: true,
    },
    'pull_requests.read': {
      grants: 'pull_requests:read',
      says: 'Read pull requests',
      changes: false,
    },
    'pull_requests.write': {
      grants: 'pull_requests:write',
      says: 'Open, comment on and close pull requests',
      changes: true,
    },
  },
  account: { kind: 'github-installation' },
  removal: { revoke: 'github-installation-token', notices: 'github-webhooks' },
  setupGuide: '/guides/connections/github/',
});
