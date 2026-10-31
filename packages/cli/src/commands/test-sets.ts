// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const KINDS = [
  'accuracy',
  'pairwise',
  'regression',
  'human-review',
  'benchmark',
  'custom',
  'corrections',
] as const;
type Kind = (typeof KINDS)[number];

/**
 * The version flag is `--test-set-version`: the global `--version` flag
 * would swallow `--version` before a command saw it.
 */
function testSetVersion(ctx: CommandContext): string | undefined {
  return stringFlag(ctx, 'test-set-version');
}

function requiredTestSetVersion(ctx: CommandContext): string {
  const version = testSetVersion(ctx);
  if (version === undefined) throw new UsageError('--test-set-version=<semver> is required');
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
  description: 'List test sets (the latest version of each).',
  usage: `kindgi test-sets list [--project=<id>] [--kind=${KINDS.join('|')}] [--include-retired] [--limit=<n>] [--cursor=<c>]`,
  optionSpec: {
    project: { type: 'string', description: 'Only test sets in this project.' },
    kind: {
      type: 'string',
      description: `Only this kind: ${KINDS.join(', ')}. \`corrections\` lists agents' own test sets, which the list leaves out otherwise.`,
    },
    'include-retired': {
      type: 'boolean',
      description:
        'Include retired test sets (every version unregistered), each as its highest version with `unregisteredAt`.',
    },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'test-sets list', async () => {
      const kind = stringFlag(ctx, 'kind');
      if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
        throw new UsageError(`--kind must be one of ${KINDS.join(', ')}, got "${kind}"`);
      }
      const projectId = stringFlag(ctx, 'project');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().testSets.list({
        ...(kind !== undefined && { kind: kind as Kind }),
        ...(projectId !== undefined && { scopeKind: 'project' as const, scopeId: projectId }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
        ...(ctx.options['include-retired'] === true && { includeRetired: true }),
      });
    }),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description: 'Show a test set: its latest version, or the one named by `--test-set-version`.',
  usage: 'kindgi test-sets show <test-set-id> [--test-set-version=<semver>]',
  optionSpec: {
    'test-set-version': {
      type: 'string',
      description: 'The version to show. Default: the latest.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'test-sets show', async () => {
      const testSetId = requiredPositional(ctx, 0, 'test-set-id');
      const version = testSetVersion(ctx);
      const testSets = ctx.client().testSets;
      return version === undefined
        ? await testSets.get(testSetId)
        : await testSets.versions.get(testSetId, version);
    }),
};

const cases: LeafCommand = {
  kind: 'leaf',
  name: 'cases',
  description: 'List the cases of a corrections test set version.',
  usage:
    'kindgi test-sets cases <test-set-id> --test-set-version=<semver> [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    'test-set-version': { type: 'string', description: 'The test set version. Required.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'test-sets cases', async () => {
      const testSetId = requiredPositional(ctx, 0, 'test-set-id');
      const version = requiredTestSetVersion(ctx);
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().testSets.listCases(testSetId, version, {
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

export const testSetsCommand: Command = {
  kind: 'group',
  name: 'test-sets',
  description:
    "Test sets (list / show / cases). An agent's corrections are its test set: `kindgi agents` has no command for it yet.",
  subcommands: [list, show, cases],
};
