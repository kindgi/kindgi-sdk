// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { writeFile } from 'node:fs/promises';

import type {
  FactsClient,
  MemoryClient,
  MemoryErasuresClient,
  SearchInput,
  SupersedeFactInput,
  WriteFactInput,
} from '@kindgi/client';

import { UsageError } from '../errors.js';
import {
  type TableSpec,
  integerFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
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
    throw new UsageError(`--${flag} must be a JSON object`);
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
      if (inputText === undefined) throw new UsageError('--input=<json-or-@file> is required');
      const input = (await jsonObjectFlag(inputText, 'input')) as Partial<SupersedeFactInput>;
      if (!('content' in input)) throw new UsageError('--input needs `content`: the next revision');
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

type RetrievalHits = Awaited<ReturnType<MemoryClient['search']>>;

/** `memory facts retrieve --table`: best first. */
const HITS_TABLE: TableSpec<RetrievalHits, RetrievalHits[number]> = {
  rows: (hits) => hits,
  columns: [
    { header: 'ID', get: (h) => String(h.fact.id) },
    { header: 'TYPE', get: (h) => h.fact.type },
    { header: 'TRUST', get: (h) => h.fact.trust ?? 'asserted' },
    { header: 'SCORE', get: (h) => (h.score === undefined ? '' : h.score.toFixed(4)) },
    { header: 'CONTENT', get: (h) => contentCell(h.fact) },
  ],
};

const factsRetrieve: LeafCommand = {
  kind: 'leaf',
  name: 'retrieve',
  description:
    'Search the memory facts you may see: newest first, by keyword, by meaning, or both fused by rank.',
  usage: 'kindgi memory facts retrieve --query=<json-or-@file>',
  optionSpec: {
    query: {
      type: 'string',
      description:
        'The retrieval as inline JSON or `@<file>`: a `mode` (`list`, `keyword`, `semantic` or `both`), and optionally `query` (required for a search), `type`, `scope` and `limit`. `semantic` and `both` need embeddings on the runtime (`KINDGI_MEMORY_EMBEDDINGS`). Required.',
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'memory facts retrieve',
      async () => {
        const text = stringFlag(ctx, 'query');
        if (text === undefined) throw new UsageError('--query=<json-or-@file> is required');
        const input = (await jsonObjectFlag(text, 'query')) as Partial<SearchInput>;
        // The mode and the rest are the server's to check.
        return await ctx
          .client()
          .memory.search({ ...input, mode: input.mode as SearchInput['mode'] });
      },
      HITS_TABLE,
    ),
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

// ---------- erasures ----------

type ErasurePage = Awaited<ReturnType<MemoryErasuresClient['list']>>;
type Erasure = ErasurePage['data'][number];
type LedgerEntry = Awaited<ReturnType<MemoryErasuresClient['export']>>[number];

/** `memory erasures list --table`. */
const ERASURES_TABLE: TableSpec<ErasurePage, Erasure> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (e) => e.id },
    { header: 'KIND', get: (e) => e.selectorKind },
    { header: 'STATUS', get: (e) => (e.status === 'running' ? `running (${e.phase})` : e.status) },
    { header: 'CREATED', get: (e) => e.createdAt },
    { header: 'COMPLETED', get: (e) => e.completedAt ?? '' },
    { header: 'REPLAYABLE', get: (e) => (e.matchable ? 'yes' : 'no') },
    { header: 'BY', get: (e) => e.requestedBy },
  ],
};

const SELECTOR_FLAGS = ['participant', 'external', 'fact', 'conversation'] as const;

const erasuresCreate: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    "Erase a person's words: their facts, conversations, the runs that served them, and what those left in provenance. Runs in the background; a tenant admin only.",
  usage:
    'kindgi memory erasures create (--participant=<id> | --external=<id> | --fact=<fact-id> | --conversation=<conversation-id>)',
  optionSpec: {
    participant: {
      type: 'string',
      description: "An app's end user (the `participantId` it gave).",
    },
    external: { type: 'string', description: 'A person facts name as an `external` subject.' },
    fact: { type: 'string', description: 'One fact, every revision.' },
    conversation: { type: 'string', description: 'One conversation.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'memory erasures create', async () => {
      const given = SELECTOR_FLAGS.filter((f) => stringFlag(ctx, f) !== undefined);
      if (given.length !== 1) {
        throw new Error('Name exactly one of --participant, --external, --fact or --conversation');
      }
      const flag = given[0] as (typeof SELECTOR_FLAGS)[number];
      const id = stringFlag(ctx, flag) as string;
      return await ctx
        .client()
        .memory.erasures.create(
          flag === 'fact'
            ? { factId: id }
            : flag === 'conversation'
              ? { conversationId: id }
              : { subject: { kind: flag, id } },
        );
    }),
};

const erasuresGet: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'An erasure: its status, phase, and what each store cleared.',
  usage: 'kindgi memory erasures get <erasure-id>',
  run: (ctx) =>
    runSdk(ctx, 'memory erasures get', async () =>
      ctx.client().memory.erasures.get(requiredPositional(ctx, 0, '<erasure-id>')),
    ),
};

const erasuresList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'Erasures, newest first.',
  usage: 'kindgi memory erasures list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor (the previous page's `nextCursor`).",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'memory erasures list',
      async () => {
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().memory.erasures.list({
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      },
      ERASURES_TABLE,
    ),
};

const erasuresExport: LeafCommand = {
  kind: 'leaf',
  name: 'export',
  description:
    'The erasure ledger, content-free, to keep off-box: restoring a backup rolls it back too, and `replay` takes it.',
  usage: 'kindgi memory erasures export [--out=<file>]',
  optionSpec: {
    out: { type: 'string', description: 'Write it to this file (else, to stdout).' },
  },
  run: (ctx) =>
    runSdk(ctx, 'memory erasures export', async () => {
      const erasures = await ctx.client().memory.erasures.export();
      const out = stringFlag(ctx, 'out');
      if (out === undefined) return { erasures };
      await writeFile(out, `${JSON.stringify({ erasures }, null, 2)}\n`, 'utf8');
      return { wrote: out, erasures: erasures.length };
    }),
};

const erasuresReplay: LeafCommand = {
  kind: 'leaf',
  name: 'replay',
  description:
    'After restoring a backup: put the exported ledger back, and erase again whoever the tenant holds again.',
  usage: 'kindgi memory erasures replay <export-file>',
  run: (ctx) =>
    runSdk(ctx, 'memory erasures replay', async () => {
      const file = requiredPositional(ctx, 0, '<export-file>');
      const read = (await readJsonInput(`@${file}`)) as
        | { readonly erasures?: unknown; readonly data?: unknown }
        | unknown[];
      const erasures = Array.isArray(read) ? read : (read.erasures ?? read.data);
      if (!Array.isArray(erasures)) {
        throw new Error(`${file} isn't an export: expected {"erasures": [...]}`);
      }
      return await ctx.client().memory.erasures.replay(erasures as LedgerEntry[]);
    }),
};

const erasuresResume: LeafCommand = {
  kind: 'leaf',
  name: 'resume',
  description:
    'Try an erasure again now; --force stops one waiting on a run in a flow that serves other people (that run is cancelled).',
  usage: 'kindgi memory erasures resume <erasure-id> [--force]',
  optionSpec: {
    force: {
      type: 'boolean',
      description:
        "Don't wait for the shared flow's run: cancel it and go on (it would otherwise wait until its deadline).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'memory erasures resume', async () =>
      ctx.client().memory.erasures.resume(requiredPositional(ctx, 0, '<erasure-id>'), {
        ...(ctx.options.force === true && { force: true }),
      }),
    ),
};

const erasuresGroup: Command = {
  kind: 'group',
  name: 'erasures',
  description:
    "Erasing a person's words: create, get, list, resume, export, replay (a tenant admin only).",
  subcommands: [
    erasuresCreate,
    erasuresGet,
    erasuresList,
    erasuresResume,
    erasuresExport,
    erasuresReplay,
  ],
};

export const memoryCommand: Command = {
  kind: 'group',
  name: 'memory',
  description:
    "Memory: the facts agents remember, by type and scope, and erasing a person's words.",
  subcommands: [factsGroup, erasuresGroup],
};
