// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const factsList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List memory facts.',
  usage: 'kindgi memory facts list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: { type: 'string', description: 'The most facts to return (default 25, at most 100).' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) => runSdk(ctx, 'memory facts list', async () => throwUnwired('memory.facts.list')),
};

const factsGet: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a memory fact by id.',
  usage: 'kindgi memory facts get <fact-id>',
  run: (ctx) =>
    runSdk(ctx, 'memory facts get', async () => {
      requiredPositional(ctx, 0, 'fact-id');
      throwUnwired('memory.facts.get');
    }),
};

const factsWrite: LeafCommand = {
  kind: 'leaf',
  name: 'write',
  description: 'Write a memory fact.',
  usage: 'kindgi memory facts write --input=<json-or-@file>',
  optionSpec: {
    input: {
      type: 'string',
      description:
        'The fact as inline JSON or `@<file>`: its `type`, `scope` and `content`, and optionally `retention`.',
    },
  },
  run: (ctx) => runSdk(ctx, 'memory facts write', async () => throwUnwired('memory.facts.write')),
};

const factsSupersede: LeafCommand = {
  kind: 'leaf',
  name: 'supersede',
  description: 'Supersede an existing memory fact.',
  usage: 'kindgi memory facts supersede <fact-id> --input=<json-or-@file>',
  optionSpec: {
    input: {
      type: 'string',
      description:
        'Inline JSON or `@<file>`. Currently unused: superseding a fact takes only its id.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'memory facts supersede', async () => {
      requiredPositional(ctx, 0, 'fact-id');
      throwUnwired('memory.facts.supersede');
    }),
};

const factsRetrieve: LeafCommand = {
  kind: 'leaf',
  name: 'retrieve',
  description: 'Retrieve memory facts by query.',
  usage: 'kindgi memory facts retrieve --query=<json-or-@file>',
  optionSpec: {
    query: {
      type: 'string',
      description:
        'The retrieval as inline JSON or `@<file>`: a `mode` (`list`, `keyword`, `semantic` or `both`), and optionally `query`, `type`, `scope` and `limit`.',
    },
  },
  run: (ctx) => runSdk(ctx, 'memory facts retrieve', async () => throwUnwired('memory.retrieve')),
};

const factsGroup: Command = {
  kind: 'group',
  name: 'facts',
  description: 'Memory facts.',
  subcommands: [factsList, factsGet, factsWrite, factsSupersede, factsRetrieve],
};

export const memoryCommand: Command = {
  kind: 'group',
  name: 'memory',
  description: 'Manage the memory subsystem.',
  subcommands: [factsGroup],
};
