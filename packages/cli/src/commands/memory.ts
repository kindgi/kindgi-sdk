// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FactsClient, SupersedeFactInput, WriteFactInput } from '@kindgi/client';

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

const contentCell = (f: Fact) =>
  f.content !== undefined ? truncateCell(JSON.stringify(f.content), 60) : '';

/** `memory facts list --table`. */
const FACTS_TABLE: TableSpec<FactPage, Fact> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (f) => String(f.id) },
    { header: 'TYPE', get: (f) => f.type },
    { header: 'VERSION', get: (f) => String(f.version) },
    { header: 'TRUST', get: (f) => f.trust ?? 'asserted' },
    { header: 'CREATED', get: (f) => String(f.createdAt) },
    { header: 'CONTENT', get: contentCell },
  ],
};

/** `memory facts revisions --table`: newest first, with why each one stopped being current. */
const REVISIONS_TABLE: TableSpec<readonly Fact[], Fact> = {
  rows: (revisions) => revisions,
  columns: [
    { header: 'VERSION', get: (f) => String(f.version) },
    { header: 'TRUST', get: (f) => f.trust ?? 'asserted' },
    { header: 'CREATED', get: (f) => String(f.createdAt) },
    {
      header: 'ENDED',
      get: (f) =>
        f.invalidatedAt === undefined
          ? 'current'
          : `${f.invalidationReason ?? 'ended'} ${String(f.invalidatedAt)} by ${f.invalidatedBy ?? '?'}`,
    },
    { header: 'CONTENT', get: contentCell },
  ],
};

const AS_OF_OPTION = {
  type: 'string',
  description: 'Memory as it stood at this time (ISO 8601), deleted and superseded facts included.',
} as const;

const EXPECT_VERSION_OPTION = {
  type: 'string',
  description:
    'Only if the fact is still at this revision (its `version`); if someone changed it first, nothing changes and the command fails with `fact-changed`.',
} as const;

/** A JSON object from inline JSON or `@<file>`, or an error naming the flag. */
async function jsonObjectFlag(
  text: string,
  flag: string,
): Promise<Readonly<Record<string, unknown>>> {
  const value = await readJsonInput(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`--${flag} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

const factsList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List the memory facts you may see, the current revision of each.',
  usage:
    'kindgi memory facts list [--type=<type>] [--scope=<json-or-@file>] [--as-of=<time>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    type: { type: 'string', description: 'Only the facts of this type.' },
    scope: {
      type: 'string',
      description:
        'Only the facts in this scope, as inline JSON or `@<file>`: any of `userId`, `orgId`, `projectId`, `threadId`, `sessionId`, `participantId`; every key given must match.',
    },
    'as-of': AS_OF_OPTION,
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
        const asOf = stringFlag(ctx, 'as-of');
        return await ctx.client().memory.facts.list({
          ...(type !== undefined && { type }),
          ...(scope !== undefined && { scope }),
          ...(asOf !== undefined && { asOf }),
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
  description: 'A memory fact by id: its current revision, one revision, or as it stood then.',
  usage: 'kindgi memory facts get <fact-id> [--revision=<n>] [--as-of=<time>]',
  optionSpec: {
    revision: { type: 'string', description: 'This revision (its `version`), current or not.' },
    'as-of': AS_OF_OPTION,
  },
  run: (ctx) =>
    runSdk(ctx, 'memory facts get', async () => {
      const id = requiredPositional(ctx, 0, 'fact-id');
      const version = integerFlag(ctx, 'revision');
      const asOf = stringFlag(ctx, 'as-of');
      const options = {
        ...(version !== undefined && { version }),
        ...(asOf !== undefined && { asOf }),
      };
      return Object.keys(options).length === 0
        ? await ctx.client().memory.facts.read(id as never)
        : await ctx.client().memory.facts.read(id as never, options);
    }),
};

const factsRevisions: LeafCommand = {
  kind: 'leaf',
  name: 'revisions',
  description: "A memory fact's revisions, newest first: who changed or deleted it, when and why.",
  usage: 'kindgi memory facts revisions <fact-id>',
  run: (ctx) =>
    runSdk(
      ctx,
      'memory facts revisions',
      async () => {
        const id = requiredPositional(ctx, 0, 'fact-id');
        return await ctx.client().memory.facts.revisions(id as never);
      },
      REVISIONS_TABLE,
    ),
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
        'The fact as inline JSON or `@<file>`: its `type` and `content`, and optionally `scope` (default: your tenant; narrow it with `userId`, `orgId`, `projectId`, `threadId`, `sessionId`, or an app\'s end user with `projectId` and `participantId`), `retention` (`keepDays`, `keepUntil`, `legalHold`), `subjects` (whom it is about: `[{"kind":"participant","id":"…"}]`) and `validFrom`/`validUntil`/`observedAt`. Required.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'memory facts write', async () => {
      const inputText = stringFlag(ctx, 'input');
      if (inputText === undefined) throw new Error('--input=<json-or-@file> is required');
      const input = (await jsonObjectFlag(inputText, 'input')) as Partial<WriteFactInput>;
      const scope: unknown = input.scope ?? {};
      if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
        throw new Error('--input `scope` must be a JSON object');
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
  description:
    "Change a memory fact's content: writes its next revision (same id). Prints the new revision.",
  usage: 'kindgi memory facts supersede <fact-id> --input=<json-or-@file> [--expect-version=<n>]',
  optionSpec: {
    input: {
      type: 'string',
      description:
        'The next revision as inline JSON or `@<file>`: its `content`, and optionally `retention`, `subjects` and `validFrom`/`validUntil`/`observedAt` (absent ones keep their current values). Its type and scope stay. Required.',
    },
    'expect-version': EXPECT_VERSION_OPTION,
  },
  run: (ctx) =>
    runSdk(ctx, 'memory facts supersede', async () => {
      const id = requiredPositional(ctx, 0, 'fact-id');
      const inputText = stringFlag(ctx, 'input');
      if (inputText === undefined) throw new Error('--input=<json-or-@file> is required');
      const input = (await jsonObjectFlag(inputText, 'input')) as Partial<SupersedeFactInput>;
      if (!('content' in input)) throw new Error('--input needs `content`: the next revision');
      const expectVersion = integerFlag(ctx, 'expect-version');
      // The rest is the server's to check.
      return await ctx.client().memory.facts.supersede(id as never, {
        ...input,
        content: input.content,
        ...(expectVersion !== undefined && { expectVersion }),
      });
    }),
};

const factsDelete: LeafCommand = {
  kind: 'leaf',
  name: 'delete',
  description:
    'Delete a memory fact: agents and reads no longer see it; its history stays until retention removes it. Prints the closed revision.',
  usage: 'kindgi memory facts delete <fact-id> [--expect-version=<n>]',
  optionSpec: { 'expect-version': EXPECT_VERSION_OPTION },
  run: (ctx) =>
    runSdk(ctx, 'memory facts delete', async () => {
      const id = requiredPositional(ctx, 0, 'fact-id');
      const expectVersion = integerFlag(ctx, 'expect-version');
      return expectVersion === undefined
        ? await ctx.client().memory.facts.delete(id as never)
        : await ctx.client().memory.facts.delete(id as never, { expectVersion });
    }),
};

const factsVerify: LeafCommand = {
  kind: 'leaf',
  name: 'verify',
  description:
    'Mark a memory fact verified: you checked it. Prints the new revision (`trust: verified`).',
  usage: 'kindgi memory facts verify <fact-id> [--expect-version=<n>]',
  optionSpec: { 'expect-version': EXPECT_VERSION_OPTION },
  run: (ctx) =>
    runSdk(ctx, 'memory facts verify', async () => {
      const id = requiredPositional(ctx, 0, 'fact-id');
      const expectVersion = integerFlag(ctx, 'expect-version');
      return expectVersion === undefined
        ? await ctx.client().memory.facts.verify(id as never)
        : await ctx.client().memory.facts.verify(id as never, { expectVersion });
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
  description: 'Memory facts: list, get, write, supersede, delete, verify, revisions.',
  subcommands: [
    factsList,
    factsGet,
    factsRevisions,
    factsWrite,
    factsSupersede,
    factsDelete,
    factsVerify,
    factsRetrieve,
  ],
};

export const memoryCommand: Command = {
  kind: 'group',
  name: 'memory',
  description: 'Memory: the facts agents remember, by type and scope.',
  subcommands: [factsGroup],
};
