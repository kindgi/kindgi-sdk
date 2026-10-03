// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List supervisor observations.',
  usage: 'kindgi observations list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: {
      type: 'string',
      description: 'The most observations to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) => runSdk(ctx, 'observations list', async () => throwUnwired('observations.list')),
};

export const observationsCommand: Command = {
  kind: 'group',
  name: 'observations',
  description: 'Read supervisor observations.',
  subcommands: [list],
};
