// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { KindgiClient } from '@kindgi/client';
import {
  type DiscoveryConfig,
  type IndexedBlock,
  holdsContent,
  readPackBlocks,
  resolveDiscovery,
  writePackBlock,
} from '@kindgi/handler-runtime';
import semver from 'semver';

import type { CommandContext } from '../context.js';
import { UsageError, extractKindgiError } from '../errors.js';
import { loadPackConfig } from '../pack-config.js';
import { callWaitingOutRateLimits } from '../rate-limit-wait.js';
import { packDirOf } from './environments.js';
import { integerFlag, readJsonInput, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const KINDS = ['prompt', 'settings'] as const;
type Kind = (typeof KINDS)[number];

/**
 * The version flag is `--block-version`: the global `--version` flag
 * would swallow `--version` before a command saw it.
 */
function requiredBlockVersion(ctx: CommandContext): string {
  const version = stringFlag(ctx, 'block-version');
  if (version === undefined) throw new UsageError('--block-version=<semver> is required');
  return version;
}

const PAGE_FLAGS = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
} as const;

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List data blocks (the latest version of each).',
  usage:
    'kindgi blocks list [--project=<id>] [--kind=prompt|settings] [--name=<prefix>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    project: { type: 'string', description: 'Only blocks of this project.' },
    kind: { type: 'string', description: 'Only this kind: prompt or settings.' },
    name: { type: 'string', description: 'Only ids starting with this.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'blocks list', async () => {
      const kind = stringFlag(ctx, 'kind');
      if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
        throw new UsageError(`--kind must be one of ${KINDS.join(', ')}, got "${kind}"`);
      }
      const projectId = stringFlag(ctx, 'project');
      const name = stringFlag(ctx, 'name');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().blocks.list({
        ...(kind !== undefined && { kind: kind as Kind }),
        ...(projectId !== undefined && { scope: { kind: 'project' as const, projectId } }),
        ...(name !== undefined && { name }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description: 'Show a data block: its latest version, or the one named by `--block-version`.',
  usage: 'kindgi blocks show <block-id> [--block-version=<semver>]',
  optionSpec: {
    'block-version': { type: 'string', description: 'The version to show. Default: the latest.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'blocks show', async () => {
      const blockId = requiredPositional(ctx, 0, 'block-id');
      const version = stringFlag(ctx, 'block-version');
      const blocks = ctx.client().blocks;
      return version === undefined
        ? await blocks.get(blockId)
        : await blocks.versions.get(blockId, version);
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: "List a data block's versions, newest first.",
  usage: 'kindgi blocks versions <block-id> [--include-unregistered] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    'include-unregistered': {
      type: 'boolean',
      description: 'Include unregistered versions (each with `unregisteredAt`).',
    },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'blocks versions', async () => {
      const blockId = requiredPositional(ctx, 0, 'block-id');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().blocks.versions.list(blockId, {
        ...(ctx.options['include-unregistered'] === true && { includeTombstoned: true }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

/** A flag's text, or a file's when it starts with `@`. */
async function textInput(spec: string): Promise<string> {
  return spec.startsWith('@') ? readFile(spec.slice(1), 'utf8') : spec;
}

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description:
    'Publish a data block version into a project: a prompt (`--prompt`), settings (`--settings`), or a full definition as JSON.',
  usage:
    "kindgi blocks publish <block-id> --block-version=<semver> --project=<id> (--prompt=<template>|@<file> | --settings=<json>|@<file> [--schema=<json>|@<file>]) [--description=<text>]\n  kindgi blocks publish --project=<id> '<json>'|@<file>",
  optionSpec: {
    'block-version': { type: 'string', description: 'The version to publish.' },
    project: { type: 'string', description: 'The project the block belongs to. Required.' },
    prompt: {
      type: 'string',
      description:
        'Instructions for an agent (a prompt block): its Liquid template, inline or `@<file>`.',
    },
    settings: {
      type: 'string',
      description: 'A settings block: its values as JSON, inline or `@<file>`.',
    },
    schema: {
      type: 'string',
      description: "A settings block's JSON Schema, inline or `@<file>`.",
    },
    description: { type: 'string', description: 'A description for the version.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'blocks publish', async () => {
      const projectId = stringFlag(ctx, 'project');
      if (projectId === undefined) throw new UsageError('--project=<id> is required');
      const prompt = stringFlag(ctx, 'prompt');
      const settings = stringFlag(ctx, 'settings');
      if (prompt === undefined && settings === undefined) {
        // The full definition, as JSON.
        const spec = requiredPositional(ctx, 0, "block definition JSON ('<json>' or @<file>)");
        const block = (await readJsonInput(spec)) as Parameters<
          ReturnType<CommandContext['client']>['blocks']['publish']
        >[0];
        return await callWaitingOutRateLimits(ctx, () =>
          ctx.client().blocks.publish(block, { projectId }),
        );
      }
      if (prompt !== undefined && settings !== undefined) {
        throw new UsageError('Give one of --prompt or --settings');
      }
      const blockId = requiredPositional(ctx, 0, 'block-id');
      const version = requiredBlockVersion(ctx);
      const description = stringFlag(ctx, 'description');
      const schema = stringFlag(ctx, 'schema');
      const content =
        prompt !== undefined
          ? { template: await textInput(prompt) }
          : {
              values: (await readJsonInput(settings as string)) as Record<string, unknown>,
              ...(schema !== undefined && {
                schema: (await readJsonInput(schema)) as Record<string, unknown>,
              }),
            };
      return await callWaitingOutRateLimits(ctx, () =>
        ctx.client().blocks.publish(
          {
            id: blockId,
            version,
            kind: prompt !== undefined ? 'prompt' : 'settings',
            content,
            ...(description !== undefined && { description }),
          },
          { projectId },
        ),
      );
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description:
    'Unregister a data block version: no range picks it any more, but the agent versions that pin it keep running it.',
  usage: 'kindgi blocks unregister <block-id> --block-version=<semver>',
  optionSpec: {
    'block-version': { type: 'string', description: 'The version to unregister. Required.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'blocks unregister', async () => {
      const blockId = requiredPositional(ctx, 0, 'block-id');
      return await ctx.client().blocks.versions.unregister(blockId, requiredBlockVersion(ctx));
    }),
};

const reinstate: LeafCommand = {
  kind: 'leaf',
  name: 'reinstate',
  description: 'Reinstate an unregistered data block version, unchanged.',
  usage: 'kindgi blocks reinstate <block-id> --block-version=<semver>',
  optionSpec: {
    'block-version': { type: 'string', description: 'The version to reinstate. Required.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'blocks reinstate', async () => {
      const blockId = requiredPositional(ctx, 0, 'block-id');
      return await ctx.client().blocks.versions.reinstate(blockId, requiredBlockVersion(ctx));
    }),
};

/** The pack's blocks, read from the files its config's `discovery.blocks` pattern matches. */
export async function packBlocksAt(
  ctx: CommandContext,
  packDir: string,
): Promise<{ readonly pattern: string; readonly blocks: readonly IndexedBlock[] }> {
  const loaded = await loadPackConfig(ctx, packDir);
  if (loaded.kind === 'missing') {
    throw new UsageError(
      `No pack config here (${loaded.message}). Run this in a pack, or pass --path=<dir>.`,
    );
  }
  if (loaded.kind === 'invalid') {
    throw new UsageError(`Couldn't read the pack config: ${loaded.message}`);
  }
  const pattern = resolveDiscovery(loaded.config.discovery as DiscoveryConfig | undefined).blocks;
  const { blocks } = await readPackBlocks(packDir, pattern);
  return { pattern, blocks };
}

/** A block file `pull` wrote: the version it held, the one it holds now, and where. */
export interface PulledBlock {
  readonly blockId: string;
  readonly from: string;
  readonly to: string;
  /** The block's file, relative to the pack root. */
  readonly file: string;
  /** The prompt's template file, when it keeps one. */
  readonly templateFile?: string;
}

/** A block file `pull` left: nothing newer than it runs (`runs`, the newest that does). */
interface UnchangedBlock {
  readonly blockId: string;
  readonly version: string;
  readonly runs?: string;
}

/** A prompt's template file, where `readPackBlocks` reads it: relative to its block's file. */
export async function templateFileOf(
  packDir: string,
  block: IndexedBlock,
): Promise<string | undefined> {
  if (block.kind !== 'prompt') return undefined;
  const raw = JSON.parse(await readFile(path.join(packDir, block.modulePath), 'utf8')) as {
    readonly content?: { readonly templateFile?: unknown };
  };
  const file = raw.content?.templateFile;
  return typeof file === 'string'
    ? path.posix.normalize(path.posix.join(path.posix.dirname(block.modulePath), file))
    : undefined;
}

/**
 * A block's file held against the version it says it is, as the runtime
 * has it. `holds`: the file holds it unedited (`holdsContent`), and
 * `content` is what a write over the file must still find there. `edited`:
 * the file holds other content at that version. `unknown`: the runtime
 * has no such version, so whether the file holds edits can't be told.
 */
export type FileVersion =
  | { readonly kind: 'holds'; readonly content: Readonly<Record<string, unknown>> }
  | { readonly kind: 'edited' | 'unknown' };

/** The block's file held against its version on the runtime; any error but `block-not-found` goes through. */
export async function fileVersionOf(
  client: KindgiClient,
  block: IndexedBlock,
): Promise<FileVersion> {
  let content: Readonly<Record<string, unknown>>;
  try {
    ({ content } = await client.blocks.versions.get(block.id, block.version));
  } catch (err) {
    const wire = extractKindgiError(err);
    if (wire !== null && 'serverCode' in wire && wire.serverCode === 'block-not-found') {
      return { kind: 'unknown' };
    }
    throw err;
  }
  return holdsContent(block.kind, block.content, content)
    ? { kind: 'holds', content }
    : { kind: 'edited' };
}

/**
 * Why a pull leaves a block's files (`files`: its file, then its template
 * file when it keeps one) as they are, when they don't hold their version:
 * writing `pulling` would drop what they hold; `undo` says what to do
 * about edits.
 */
export function notPulledLine(
  block: IndexedBlock,
  files: readonly string[],
  found: 'edited' | 'unknown',
  pulling: string,
  undo: string,
): string {
  const one = files.length === 1;
  const held = one
    ? `${block.modulePath} holds`
    : `${block.modulePath} and its template ${files[1]} hold`;
  return found === 'edited'
    ? `${held} ${block.id} ${block.version} with edits that aren't in the runtime's ${block.version}: pulling ${pulling} would drop them. ${undo}`
    : `${held} ${block.id} ${block.version}, which this runtime doesn't have, so Kindgi can't tell whether ${one ? 'it holds' : 'they hold'} edits. Deploy ${block.version} first, or bring the file back to a version the runtime has.`;
}

/** `word` as one shell word in a printed git line: as it is when it's plain, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** A block `pull` writes: the version that runs, over the content its file holds now. */
interface BlockPull {
  readonly block: IndexedBlock;
  readonly to: string;
  readonly expected: Readonly<Record<string, unknown>>;
}

/** What `pull` does with a block: writes it, leaves it, or refuses it, saying why. */
type BlockPlan =
  | { readonly kind: 'write'; readonly pull: BlockPull }
  | { readonly kind: 'leave'; readonly unchanged: UnchangedBlock }
  | { readonly kind: 'refuse'; readonly line: string };

/** Left when nothing newer runs; else held against its file's own version first. */
async function planFor(
  client: KindgiClient,
  packDir: string,
  block: IndexedBlock,
): Promise<BlockPlan> {
  const { data } = await client.blocks.runsIn(block.id);
  const runs = data.map((row) => row.blockVersion).sort(semver.rcompare)[0];
  if (runs === undefined || !semver.gt(runs, block.version)) {
    return {
      kind: 'leave',
      unchanged: { blockId: block.id, version: block.version, ...(runs !== undefined && { runs }) },
    };
  }
  const held = await fileVersionOf(client, block);
  if (held.kind === 'holds') {
    return { kind: 'write', pull: { block, to: runs, expected: held.content } };
  }
  const template = await templateFileOf(packDir, block);
  const files = template === undefined ? [block.modulePath] : [block.modulePath, template];
  return {
    kind: 'refuse',
    line: notPulledLine(
      block,
      files,
      held.kind,
      runs,
      `Give the edits a version of their own and deploy it, or undo them (\`git restore -- ${files.map(shellWord).join(' ')}\`), then pull again.`,
    ),
  };
}

/** Each block's version written into its file, in order. */
async function writePulls(
  client: KindgiClient,
  packDir: string,
  pattern: string,
  pulls: readonly BlockPull[],
): Promise<PulledBlock[]> {
  const wrote: PulledBlock[] = [];
  for (const { block, to, expected } of pulls) {
    const { content } = await client.blocks.versions.get(block.id, to);
    const outcome = await writePackBlock(packDir, pattern, {
      id: block.id,
      version: to,
      content,
      expected,
    });
    if (outcome.kind === 'err') {
      throw new Error(
        `Couldn't write ${block.id} ${to} into ${block.modulePath}: ${outcome.message}`,
      );
    }
    wrote.push({
      blockId: block.id,
      from: outcome.replaced,
      to,
      file: outcome.file,
      ...(outcome.templateFile !== undefined && { templateFile: outcome.templateFile }),
    });
  }
  return wrote;
}

const pull: LeafCommand = {
  kind: 'leaf',
  name: 'pull',
  description:
    "Write the newest version of each block that runs anywhere into the pack's block file, where it's newer than the file and the file holds its version unedited.",
  usage: 'kindgi blocks pull [<block-id>...] [--path=<dir>]',
  optionSpec: {
    path: { type: 'string', description: 'The pack directory. Default: the current one.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'blocks pull', async () => {
      const packDir = packDirOf(ctx);
      const { pattern, blocks } = await packBlocksAt(ctx, packDir);
      const named = ctx.positionals;
      const unknown = named.filter((id) => !blocks.some((b) => b.id === id));
      if (unknown.length > 0) {
        throw new UsageError(`Not among the pack's blocks (${pattern}): ${unknown.join(', ')}`);
      }
      const client = ctx.client();
      const plans: BlockPlan[] = [];
      for (const block of named.length === 0
        ? blocks
        : blocks.filter((b) => named.includes(b.id))) {
        plans.push(await planFor(client, packDir, block));
      }
      // Every block is checked before any is written: a refusal leaves the pack as it was.
      const refused = plans.flatMap((p) => (p.kind === 'refuse' ? [p.line] : []));
      if (refused.length > 0) throw new Error(refused.join('\n'));
      const pulls = plans.flatMap((p) => (p.kind === 'write' ? [p.pull] : []));
      return {
        wrote: await writePulls(client, packDir, pattern, pulls),
        unchanged: plans.flatMap((p) => (p.kind === 'leave' ? [p.unchanged] : [])),
      };
    }),
};

export const blocksCommand: Command = {
  kind: 'group',
  name: 'blocks',
  description:
    'Data blocks: versioned prompts and settings agent versions pin (list / show / versions / publish / unregister / reinstate / pull).',
  subcommands: [list, show, versions, publish, unregister, reinstate, pull],
};
