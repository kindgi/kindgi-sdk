// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
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
      description: 'A prompt block: its Liquid template, inline or `@<file>`.',
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
        return await ctx.client().blocks.publish(block, { projectId });
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
      return await ctx.client().blocks.publish(
        {
          id: blockId,
          version,
          kind: prompt !== undefined ? 'prompt' : 'settings',
          content,
          ...(description !== undefined && { description }),
        },
        { projectId },
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

export const blocksCommand: Command = {
  kind: 'group',
  name: 'blocks',
  description:
    'Data blocks: versioned prompts and settings agent versions pin (list / show / versions / publish / unregister / reinstate).',
  subcommands: [list, show, versions, publish, unregister, reinstate],
};
