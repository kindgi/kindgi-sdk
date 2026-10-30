// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  integerFlag,
  listFlag,
  requiredPositional,
  runSdk,
  segmentsFlag,
  stringFlag,
  timeFlag,
} from './helpers.js';
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

/** The string flags given, under their request field names (`{ agent: 'agentId' }`). */
function givenFlags<F extends string>(
  ctx: CommandContext,
  fields: Readonly<Record<string, F>>,
): Partial<Record<F, string>> {
  const out: Partial<Record<F, string>> = {};
  for (const [flag, field] of Object.entries(fields)) {
    const value = stringFlag(ctx, flag);
    if (value !== undefined) out[field] = value;
  }
  return out;
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
    project: { type: 'string', description: 'Only testSets in this project.' },
    kind: { type: 'string', description: `Only this kind: ${KINDS.join(', ')}.` },
    'include-retired': {
      type: 'boolean',
      description:
        'Include retired testSets (every version unregistered), each as its highest version with `unregisteredAt`.',
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
  description: 'Show an test set: its latest version, or the one named by `--test-set-version`.',
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

const fromCorrections: LeafCommand = {
  kind: 'leaf',
  name: 'from-corrections',
  description:
    "Build test cases: publish a `corrections` test set version whose cases are copies of an agent's or flow's corrected runs, with each item's corrections summed up.",
  usage:
    'kindgi test-sets from-corrections <test-set-id> --test-set-version=<semver> --project=<id> (--agent=<id> [--agent-version=<v>] | --flow=<id>) [--since=<iso>] [--until=<iso>] [--group=<corrector-group-id> ...] [--min-corrections=<n>] [--segment=<key:value> ...] [--description=<text>]',
  optionSpec: {
    'test-set-version': { type: 'string', description: 'The version to publish. Required.' },
    project: { type: 'string', description: 'The project whose corrected runs to use. Required.' },
    agent: { type: 'string', description: 'Use corrected runs of this agent.' },
    'agent-version': {
      type: 'string',
      description: 'Only runs of this agent version. Needs `--agent`.',
    },
    flow: { type: 'string', description: 'Use corrected runs of this flow.' },
    since: {
      type: 'string',
      description:
        'Only runs first corrected at or after this time: an ISO 8601 time with a zone, or a date (its start, UTC).',
    },
    until: {
      type: 'string',
      description:
        'Only runs first corrected before this time: an ISO 8601 time with a zone, or a date (its start, UTC).',
    },
    group: {
      type: 'string',
      multiple: true,
      description:
        'Count only corrections under this corrector group id. Repeat the flag for several groups.',
    },
    'min-corrections': {
      type: 'string',
      description: 'Leave out runs with fewer counted corrections (default 1).',
    },
    segment: {
      type: 'string',
      multiple: true,
      description:
        'Only runs started in this segment or below it, as key:value; repeat it for a path, coarse to fine (`--segment=company:acme --segment=role:cfo`).',
    },
    description: { type: 'string', description: 'A description for the test set version.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'test-sets from-corrections', async () => {
      const testSetId = requiredPositional(ctx, 0, 'test-set-id');
      const version = requiredTestSetVersion(ctx);
      const projectId = stringFlag(ctx, 'project');
      if (projectId === undefined) throw new UsageError('--project=<id> is required');
      const agent = stringFlag(ctx, 'agent');
      const flow = stringFlag(ctx, 'flow');
      if ((agent === undefined) === (flow === undefined)) {
        throw new UsageError('Give exactly one of --agent=<id> or --flow=<id>');
      }
      if (stringFlag(ctx, 'agent-version') !== undefined && agent === undefined) {
        throw new UsageError('--agent-version needs --agent');
      }
      const minCorrections = integerFlag(ctx, 'min-corrections');
      if (minCorrections !== undefined && minCorrections < 1) {
        throw new UsageError('--min-corrections must be 1 or more');
      }
      const groups = listFlag(ctx, 'group');
      const segments = segmentsFlag(ctx);
      const since = timeFlag(ctx, 'since');
      const until = timeFlag(ctx, 'until');
      return await ctx.client().testSets.buildFromCorrections(testSetId, {
        version,
        projectId,
        ...givenFlags(ctx, {
          agent: 'agentId',
          'agent-version': 'agentVersion',
          flow: 'flowId',
          description: 'description',
        }),
        ...(since !== undefined && { since }),
        ...(until !== undefined && { until }),
        ...(groups.length > 0 && { correctorGroupIds: groups }),
        ...(minCorrections !== undefined && { minCorrections }),
        ...(segments.length > 0 && { segments: [...segments] }),
      });
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
    'Test sets and test cases built from corrections (list / show / from-corrections / cases).',
  subcommands: [list, show, fromCorrections, cases],
};
