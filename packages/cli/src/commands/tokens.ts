// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description: 'Create a new API token.',
  usage: 'kindgi tokens create --spec=<json-or-@file>',
  optionSpec: { spec: { type: 'string' } },
  run: (ctx) => runSdk(ctx, 'tokens create', async () => throwUnwired('tokens.create')),
};

const revoke: LeafCommand = {
  kind: 'leaf',
  name: 'revoke',
  description: 'Revoke an API token.',
  usage: 'kindgi tokens revoke <token-id>',
  run: (ctx) =>
    runSdk(ctx, 'tokens revoke', async () => {
      requiredPositional(ctx, 0, 'token-id');
      throwUnwired('tokens.revoke');
    }),
};

export const tokensCommand: Command = {
  kind: 'group',
  name: 'tokens',
  description: 'Manage API tokens.',
  subcommands: [create, revoke],
};
