// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List capability descriptors.',
  usage: 'kindgi capabilities list [--feature=<prefix>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    feature: {
      type: 'string',
      description: 'Only the capabilities whose feature starts with this prefix.',
    },
    limit: { type: 'string', description: 'The most capabilities to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) => runSdk(ctx, 'capabilities list', async () => throwUnwired('capabilities.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a capability by id.',
  usage: 'kindgi capabilities get <capability-id>',
  run: (ctx) =>
    runSdk(ctx, 'capabilities get', async () => {
      requiredPositional(ctx, 0, 'capability-id');
      throwUnwired('capabilities.get');
    }),
};

export const capabilitiesCommand: Command = {
  kind: 'group',
  name: 'capabilities',
  description: 'Read framework capability catalog.',
  subcommands: [list, get],
};
