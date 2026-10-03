// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List conversations.',
  usage: 'kindgi conversations list [--status=<status>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    status: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
  },
  run: (ctx) => runSdk(ctx, 'conversations list', async () => throwUnwired('conversations.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a conversation by id.',
  usage: 'kindgi conversations get <conversation-id>',
  run: (ctx) =>
    runSdk(ctx, 'conversations get', async () => {
      requiredPositional(ctx, 0, 'conversation-id');
      throwUnwired('conversations.get');
    }),
};

const open: LeafCommand = {
  kind: 'leaf',
  name: 'open',
  description: 'Open a new conversation.',
  usage: 'kindgi conversations open [--agent-id=<id>]',
  optionSpec: { 'agent-id': { type: 'string' } },
  run: (ctx) => runSdk(ctx, 'conversations open', async () => throwUnwired('conversations.open')),
};

const close: LeafCommand = {
  kind: 'leaf',
  name: 'close',
  description: 'Close a conversation.',
  usage: 'kindgi conversations close <conversation-id>',
  run: (ctx) =>
    runSdk(ctx, 'conversations close', async () => {
      requiredPositional(ctx, 0, 'conversation-id');
      throwUnwired('conversations.close');
    }),
};

const messages: LeafCommand = {
  kind: 'leaf',
  name: 'messages',
  description: "List a conversation's messages.",
  usage: 'kindgi conversations messages <conversation-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: { limit: { type: 'string' }, cursor: { type: 'string' } },
  run: (ctx) =>
    runSdk(ctx, 'conversations messages', async () => {
      requiredPositional(ctx, 0, 'conversation-id');
      throwUnwired('conversations.messages');
    }),
};

export const conversationsCommand: Command = {
  kind: 'group',
  name: 'conversations',
  description: 'Manage conversation sessions.',
  subcommands: [list, get, open, close, messages],
};
