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
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const KINDS = [
  'accuracy',
  'pairwise',
  'regression',
  'human-review',
  'benchmark',
  'custom',
  'judged',
] as const;
type Kind = (typeof KINDS)[number];

/**
 * The version flag is `--suite-version`: the global `--version` flag
 * would swallow `--version` before a command saw it.
 */
function suiteVersion(ctx: CommandContext): string | undefined {
  return stringFlag(ctx, 'suite-version');
}

function requiredSuiteVersion(ctx: CommandContext): string {
  const version = suiteVersion(ctx);
  if (version === undefined) throw new UsageError('--suite-version=<semver> is required');
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
  description: 'List eval suites (the latest version of each).',
  usage: `kindgi eval-suites list [--project=<id>] [--kind=${KINDS.join('|')}] [--limit=<n>] [--cursor=<c>]`,
  optionSpec: {
    project: { type: 'string', description: 'Only suites in this project.' },
    kind: { type: 'string', description: `Only this kind: ${KINDS.join(', ')}.` },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'eval-suites list', async () => {
      const kind = stringFlag(ctx, 'kind');
      if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
        throw new UsageError(`--kind must be one of ${KINDS.join(', ')}, got "${kind}"`);
      }
      const projectId = stringFlag(ctx, 'project');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().evalSuites.list({
        ...(kind !== undefined && { kind: kind as Kind }),
        ...(projectId !== undefined && { scopeKind: 'project' as const, scopeId: projectId }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description: 'Show an eval suite: its latest version, or the one named by `--suite-version`.',
  usage: 'kindgi eval-suites show <suite-id> [--suite-version=<semver>]',
  optionSpec: {
    'suite-version': { type: 'string', description: 'The version to show. Default: the latest.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'eval-suites show', async () => {
      const suiteId = requiredPositional(ctx, 0, 'suite-id');
      const version = suiteVersion(ctx);
      const suites = ctx.client().evalSuites;
      return version === undefined
        ? await suites.get(suiteId)
        : await suites.versions.get(suiteId, version);
    }),
};

const fromJudgments: LeafCommand = {
  kind: 'leaf',
  name: 'from-judgments',
  description:
    "Build a test set: publish a `judged` suite version whose cases are copies of an agent's or flow's judged runs, with each item's judgments summed up.",
  usage:
    'kindgi eval-suites from-judgments <suite-id> --suite-version=<semver> --project=<id> (--agent=<id> [--agent-version=<v>] | --flow=<id>) [--since=<iso>] [--until=<iso>] [--class=<judge-class-id> ...] [--min-judgments=<n>] [--segment=<key:value> ...] [--description=<text>]',
  optionSpec: {
    'suite-version': { type: 'string', description: 'The version to publish. Required.' },
    project: { type: 'string', description: 'The project whose judged runs to use. Required.' },
    agent: { type: 'string', description: 'Use judged runs of this agent.' },
    'agent-version': {
      type: 'string',
      description: 'Only runs of this agent version. Needs `--agent`.',
    },
    flow: { type: 'string', description: 'Use judged runs of this flow.' },
    since: {
      type: 'string',
      description: 'Only runs first judged at or after this ISO 8601 time.',
    },
    until: { type: 'string', description: 'Only runs first judged before this ISO 8601 time.' },
    class: {
      type: 'string',
      multiple: true,
      description:
        'Count only judgments under this judge class id. Repeat the flag for several classes.',
    },
    'min-judgments': {
      type: 'string',
      description: 'Leave out runs with fewer counted judgments (default 1).',
    },
    segment: {
      type: 'string',
      multiple: true,
      description:
        'Only runs started in this segment or below it, as key:value; repeat it for a path, coarse to fine (`--segment=company:acme --segment=role:cfo`).',
    },
    description: { type: 'string', description: 'A description for the suite version.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'eval-suites from-judgments', async () => {
      const suiteId = requiredPositional(ctx, 0, 'suite-id');
      const version = requiredSuiteVersion(ctx);
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
      const minJudgments = integerFlag(ctx, 'min-judgments');
      if (minJudgments !== undefined && minJudgments < 1) {
        throw new UsageError('--min-judgments must be 1 or more');
      }
      const classes = listFlag(ctx, 'class');
      const segments = segmentsFlag(ctx);
      return await ctx.client().evalSuites.buildFromJudgments(suiteId, {
        version,
        projectId,
        ...givenFlags(ctx, {
          agent: 'agentId',
          'agent-version': 'agentVersion',
          flow: 'flowId',
          since: 'since',
          until: 'until',
          description: 'description',
        }),
        ...(classes.length > 0 && { judgeClassIds: classes }),
        ...(minJudgments !== undefined && { minJudgments }),
        ...(segments.length > 0 && { segments: [...segments] }),
      });
    }),
};

const cases: LeafCommand = {
  kind: 'leaf',
  name: 'cases',
  description: 'List the cases of a judged suite version.',
  usage:
    'kindgi eval-suites cases <suite-id> --suite-version=<semver> [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    'suite-version': { type: 'string', description: 'The suite version. Required.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'eval-suites cases', async () => {
      const suiteId = requiredPositional(ctx, 0, 'suite-id');
      const version = requiredSuiteVersion(ctx);
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().evalSuites.listCases(suiteId, version, {
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

export const evalSuitesCommand: Command = {
  kind: 'group',
  name: 'eval-suites',
  description:
    'Eval suites and test sets built from judgments (list / show / from-judgments / cases).',
  subcommands: [list, show, fromJudgments, cases],
};
