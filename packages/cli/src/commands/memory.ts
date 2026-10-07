// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FactsClient, WriteFactInput } from '@kindgi/client';

import { UsageError } from '../errors.js';
import {
  type TableSpec,
  integerFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
  throwUnwired,
  truncateCell,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * A page of facts, and a fact, as `memory.facts` answers them. Not the
 * client's exported `Fact`: its bundled types export that name twice.
 */
type FactPage = Awaited<ReturnType<FactsClient['list']>>;
type Fact = FactPage['data'][number];

/** `memory facts list --table`. */
const FACTS_TABLE: TableSpec<FactPage, Fact> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (f) => String(f.id) },
    { header: 'TYPE', get: (f) => f.type },
    { header: 'VERSION', get: (f) => String(f.version) },
    { header: 'CREATED', get: (f) => String(f.createdAt) },
    {
      header: 'CONTENT',
      get: (f) => (f.content !== undefined ? truncateCell(JSON.stringify(f.content), 60) : ''),
    },
  ],
};

/** A JSON object from inline JSON or `@<file>`, or an error naming the flag. */
async function jsonObjectFlag(
  text: string,
  flag: string,
): Promise<Readonly<Record<string, unknown>>> {
  const value = await readJsonInput(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError(`--${flag} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

const factsList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List memory facts, the latest version of each.',
  usage:
    'kindgi memory facts list [--type=<type>] [--scope=<json-or-@file>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    type: { type: 'string', description: 'Only the facts of this type.' },
    scope: {
      type: 'string',
      description:
        'Only the facts in this scope, as inline JSON or `@<file>`: any of `userId`, `orgId`, `projectId`, `threadId`, `sessionId`; every key given must match.',
    },
    limit: { type: 'string', description: 'The most facts to return (default 25, at most 100).' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'memory facts list',
      async () => {
        const type = stringFlag(ctx, 'type');
        const scopeText = stringFlag(ctx, 'scope');
        const scope =
          scopeText === undefined ? undefined : await jsonObjectFlag(scopeText, 'scope');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().memory.facts.list({
          ...(type !== undefined && { type }),
          ...(scope !== undefined && { scope }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor: cursor as never }),
        });
      },
      FACTS_TABLE,
    ),
};

const factsGet: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'A memory fact by id, its latest version.',
  usage: 'kindgi memory facts get <fact-id>',
  run: (ctx) =>
    runSdk(ctx, 'memory facts get', async () => {
      const id = requiredPositional(ctx, 0, 'fact-id');
      return await ctx.client().memory.facts.read(id as never);
    }),
};

const factsWrite: LeafCommand = {
  kind: 'leaf',
  name: 'write',
  description: 'Write a memory fact. Prints it, with the id and version the server gave it.',
  usage: 'kindgi memory facts write --input=<json-or-@file>',
  optionSpec: {
    input: {
      type: 'string',
      description:
        'The fact as inline JSON or `@<file>`: its `type` and `content`, and optionally `scope` (default: your tenant; narrow it with `userId`, `orgId`, `projectId`, `threadId`, `sessionId`) and `retention` (`keepDays`, `keepUntil`, `legalHold`). Required.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'memory facts write', async () => {
      const inputText = stringFlag(ctx, 'input');
      if (inputText === undefined) throw new UsageError('--input=<json-or-@file> is required');
      const input = (await jsonObjectFlag(inputText, 'input')) as Partial<WriteFactInput>;
      const scope: unknown = input.scope ?? {};
      if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
        throw new UsageError('--input `scope` must be a JSON object');
      }
      const client = ctx.client();
      // The API asks for the scope's tenant, which can only be the caller's.
      const tenantId =
        (scope as { tenantId?: unknown }).tenantId ?? (await client.identity.whoami()).tenantId;
      // `type` and `content` are the server's to check.
      return await client.memory.facts.write({
        ...input,
        type: input.type as string,
        content: input.content,
        scope: { ...scope, tenantId },
      });
    }),
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
  description: 'Memory facts: list, get, write.',
  subcommands: [factsList, factsGet, factsWrite, factsSupersede, factsRetrieve],
};

export const memoryCommand: Command = {
  kind: 'group',
  name: 'memory',
  description: 'Memory: the facts agents remember, by type and scope.',
  subcommands: [factsGroup],
};
