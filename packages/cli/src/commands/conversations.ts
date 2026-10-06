// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { integerFlag, requiredPositional, runSdk, stringFlag, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const STATUSES = ['open', 'closed'] as const;
const REPLAYS = ['exclude', 'include', 'only'] as const;

/** `value` as one of `allowed`, or an error naming the flag. */
function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${flag} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value as T;
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List conversations, newest first.',
  usage:
    'kindgi conversations list [--status=open|closed] [--replays=exclude|include|only] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    status: {
      type: 'string',
      description: 'Only the conversations with this status: `open` or `closed`.',
    },
    replays: {
      type: 'string',
      description:
        "Replay conversations (a comparison's replays): `exclude` (the default) leaves them out, `include` lists them too, `only` lists just them.",
    },
    limit: { type: 'string', description: 'The most conversations to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'conversations list', async () => {
      const status = oneOf('status', stringFlag(ctx, 'status'), STATUSES);
      const replays = oneOf('replays', stringFlag(ctx, 'replays'), REPLAYS);
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().conversations.list({
        ...(status !== undefined && { status }),
        ...(replays !== undefined && { replays }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor: cursor as never }),
      });
    }),
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
  optionSpec: {
    'agent-id': { type: 'string', description: 'The agent the conversation is with, by id.' },
  },
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
  optionSpec: {
    limit: { type: 'string', description: 'The most messages to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
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
