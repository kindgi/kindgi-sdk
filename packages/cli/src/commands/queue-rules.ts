// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { QueueRulePatch, QueueRuleSpec, QueueRuleWhen } from '@kindgi/client';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  integerFlag,
  listFlag,
  projectIdFlag,
  requiredPositional,
  runSdk,
  stringFlag,
  timeFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

/** The run outcome `--status` matches; a rule takes `completed` only. */
const RUN_STATUSES = ['completed'] as const;

const PROJECT_OPTION: Readonly<Record<string, ParseArgsOption>> = {
  project: {
    type: 'string',
    description: "The project the rule is in. Without it, the tenant's default project.",
  },
};

/** The flags that say which runs a rule matches, shared by create, update and preview. */
const WHEN_OPTIONS: Readonly<Record<string, ParseArgsOption>> = {
  agent: { type: 'string', multiple: true, description: 'Match runs of this agent (repeatable).' },
  flow: { type: 'string', multiple: true, description: 'Match runs of this flow (repeatable).' },
  'agent-version': {
    type: 'string',
    multiple: true,
    description:
      "Match runs of this agent version exactly, or `pinned` for runs that got the agent's pinned version (repeatable).",
  },
  status: {
    type: 'string',
    multiple: true,
    description:
      'Match runs by how they ended. Only `completed` is accepted — a correction needs a completed run, so `failed` and `cancelled` are refused.',
  },
  'include-dry-runs': {
    type: 'boolean',
    description: 'Also match dry runs; off by default. Replays never match.',
  },
};

/** The share `--sample`, a number greater than 0 and at most 1. */
function sampleFlag(ctx: CommandContext): number | undefined {
  const raw = stringFlag(ctx, 'sample');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new UsageError(`--sample must be a share greater than 0 and at most 1, got "${raw}"`);
  }
  return n;
}

/** Whether any match flag is given, so an `update` replaces the rule's `when` whole. */
function hasWhenFlags(ctx: CommandContext): boolean {
  return (
    listFlag(ctx, 'agent').length > 0 ||
    listFlag(ctx, 'flow').length > 0 ||
    listFlag(ctx, 'agent-version').length > 0 ||
    listFlag(ctx, 'status').length > 0 ||
    ctx.options['include-dry-runs'] === true
  );
}

/** The `when` a rule matches, built from the match flags. Absent fields don't narrow. */
function whenFromFlags(ctx: CommandContext): QueueRuleWhen {
  const agentIds = listFlag(ctx, 'agent');
  const flowIds = listFlag(ctx, 'flow');
  const versions = listFlag(ctx, 'agent-version');
  const status = listFlag(ctx, 'status');
  for (const s of status) {
    if (!(RUN_STATUSES as readonly string[]).includes(s)) {
      throw new UsageError(
        `--status takes only 'completed' (a correction needs a completed run), got "${s}"`,
      );
    }
  }
  return {
    ...(agentIds.length > 0 && { agentIds }),
    ...(flowIds.length > 0 && { flowIds }),
    ...(versions.length > 0 && { versions }),
    ...(status.length > 0 && { status: status as NonNullable<QueueRuleWhen['status']> }),
    ...(ctx.options['include-dry-runs'] === true && { includeDryRuns: true }),
  };
}

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    'Create a queue rule: which of the project’s finished runs a person is asked to correct, and how many to queue.',
  usage:
    'kindgi queue-rules create --name=<name> [--project=<id>] [--agent=<id>] [--flow=<id>] [--agent-version=<v>] [--status=completed] [--include-dry-runs] [--sample=<0-1>] [--max-open=<n>] [--group=<corrector-group-id>] [--disabled] [--queue-last=<n>] [--queue-since=<time>]',
  optionSpec: {
    ...PROJECT_OPTION,
    name: { type: 'string', description: 'A name for the rule. Required.' },
    ...WHEN_OPTIONS,
    sample: {
      type: 'string',
      description:
        'The share of matching runs to queue, greater than 0 and at most 1 (default 1). The same runs every time, by run and rule id.',
    },
    'max-open': {
      type: 'string',
      description: 'Add nothing while this rule has this many open items. Without it, no cap.',
    },
    group: {
      type: 'string',
      description:
        'The corrector group whose correction closes an item. Without it, any correction closes it.',
    },
    disabled: { type: 'boolean', description: 'Create the rule disabled (it matches nothing).' },
    'queue-last': {
      type: 'string',
      description:
        "Also queue the rule's matches among the last N finished runs, right after creating it (1 to 1000).",
    },
    'queue-since': {
      type: 'string',
      description:
        'Also queue the rule’s matches among runs finished at or after this time (an ISO 8601 time with a zone, or a date).',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules create', async () => {
      const name = stringFlag(ctx, 'name');
      if (name === undefined) throw new UsageError('--name=<name> is required');
      const projectId = await projectIdFlag(ctx);
      const sample = sampleFlag(ctx);
      const maxOpen = integerFlag(ctx, 'max-open');
      const correctorGroupId = stringFlag(ctx, 'group');
      const spec: QueueRuleSpec = {
        name,
        when: whenFromFlags(ctx),
        ...(sample !== undefined && { sample }),
        ...(maxOpen !== undefined && { maxOpen }),
        ...(correctorGroupId !== undefined && { correctorGroupId }),
        ...(ctx.options.disabled === true && { enabled: false }),
      };
      const rule = await ctx.client().projects.queueRules.create(projectId, spec);
      const last = integerFlag(ctx, 'queue-last');
      const since = timeFlag(ctx, 'queue-since');
      if (last === undefined && since === undefined) return rule;
      const queued = await ctx.client().projects.queueRules.queueRecent(projectId, rule.ruleId, {
        ...(last !== undefined && { last }),
        ...(since !== undefined && { since }),
      });
      return { rule, queued };
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List the project’s live queue rules (their latest versions), oldest first.',
  usage: 'kindgi queue-rules list [--project=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    ...PROJECT_OPTION,
    limit: { type: 'string', description: 'The most rules to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules list', async () => {
      const projectId = await projectIdFlag(ctx);
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().projects.queueRules.list(projectId, {
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description: 'Show a queue rule’s latest version.',
  usage: 'kindgi queue-rules show <rule-id> [--project=<id>]',
  optionSpec: { ...PROJECT_OPTION },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules show', async () => {
      const ruleId = requiredPositional(ctx, 0, 'rule-id');
      const projectId = await projectIdFlag(ctx);
      return await ctx.client().projects.queueRules.get(projectId, ruleId);
    }),
};

/** Refuse the `update` flag pairs that contradict each other. */
function refuseConflictingUpdateFlags(ctx: CommandContext): void {
  if (integerFlag(ctx, 'max-open') !== undefined && ctx.options['clear-max-open'] === true) {
    throw new UsageError('Give --max-open or --clear-max-open, not both');
  }
  if (stringFlag(ctx, 'group') !== undefined && ctx.options['clear-group'] === true) {
    throw new UsageError('Give --group or --clear-group, not both');
  }
  if (ctx.options.enable === true && ctx.options.disable === true) {
    throw new UsageError('Give --enable or --disable, not both');
  }
}

/** The patch an `update` sends: the given fields replaced, `when` whole. Refuses an empty change. */
function patchFromFlags(ctx: CommandContext): QueueRulePatch {
  refuseConflictingUpdateFlags(ctx);
  const name = stringFlag(ctx, 'name');
  const sample = sampleFlag(ctx);
  const maxOpen = integerFlag(ctx, 'max-open');
  const correctorGroupId = stringFlag(ctx, 'group');
  const patch: QueueRulePatch = {
    ...(name !== undefined && { name }),
    ...(hasWhenFlags(ctx) && { when: whenFromFlags(ctx) }),
    ...(sample !== undefined && { sample }),
    ...(maxOpen !== undefined && { maxOpen }),
    ...(ctx.options['clear-max-open'] === true && { maxOpen: null }),
    ...(correctorGroupId !== undefined && { correctorGroupId }),
    ...(ctx.options['clear-group'] === true && { correctorGroupId: null }),
    ...(ctx.options.enable === true && { enabled: true }),
    ...(ctx.options.disable === true && { enabled: false }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      'Give at least one change: --name, a match flag, --sample, --max-open/--clear-max-open, --group/--clear-group, or --enable/--disable',
    );
  }
  return patch;
}

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description:
    'Change a queue rule: a new version with the given fields replaced. The match flags replace the rule’s `when` whole.',
  usage:
    'kindgi queue-rules update <rule-id> [--project=<id>] [--name=<name>] [--agent=<id>] [--flow=<id>] [--agent-version=<v>] [--status=completed] [--include-dry-runs] [--sample=<0-1>] [--max-open=<n> | --clear-max-open] [--group=<id> | --clear-group] [--enable | --disable]',
  optionSpec: {
    ...PROJECT_OPTION,
    name: { type: 'string', description: 'A new name for the rule.' },
    ...WHEN_OPTIONS,
    sample: { type: 'string', description: 'A new sample share, greater than 0 and at most 1.' },
    'max-open': { type: 'string', description: 'A new open-items cap.' },
    'clear-max-open': { type: 'boolean', description: 'Remove the open-items cap.' },
    group: {
      type: 'string',
      description: 'A new corrector group whose correction closes an item.',
    },
    'clear-group': {
      type: 'boolean',
      description: 'Remove the corrector group; any correction closes an item.',
    },
    enable: { type: 'boolean', description: 'Enable the rule.' },
    disable: { type: 'boolean', description: 'Disable the rule.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules update', async () => {
      const ruleId = requiredPositional(ctx, 0, 'rule-id');
      const projectId = await projectIdFlag(ctx);
      const patch = patchFromFlags(ctx);
      return await ctx.client().projects.queueRules.update(projectId, ruleId, patch);
    }),
};

const remove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description: 'Unregister a queue rule, so it queues nothing more. Its queued items stay.',
  usage: 'kindgi queue-rules remove <rule-id> [--project=<id>]',
  optionSpec: { ...PROJECT_OPTION },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules remove', async () => {
      const ruleId = requiredPositional(ctx, 0, 'rule-id');
      const projectId = await projectIdFlag(ctx);
      return await ctx.client().projects.queueRules.unregister(projectId, ruleId);
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: 'List every version of a queue rule, newest first.',
  usage: 'kindgi queue-rules versions <rule-id> [--project=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    ...PROJECT_OPTION,
    limit: { type: 'string', description: 'The most versions to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules versions', async () => {
      const ruleId = requiredPositional(ctx, 0, 'rule-id');
      const projectId = await projectIdFlag(ctx);
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().projects.queueRules.versions(projectId, ruleId, {
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const results: LeafCommand = {
  kind: 'leaf',
  name: 'results',
  description:
    'A queue rule’s results since a time, by the rule’s version and the agent’s, never pooled.',
  usage: 'kindgi queue-rules results <rule-id> [--project=<id>] [--since=<time>]',
  optionSpec: {
    ...PROJECT_OPTION,
    since: {
      type: 'string',
      description:
        'Only runs queued (or skipped by the cap) at or after this time (an ISO 8601 time with a zone, or a date).',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules results', async () => {
      const ruleId = requiredPositional(ctx, 0, 'rule-id');
      const projectId = await projectIdFlag(ctx);
      const since = timeFlag(ctx, 'since');
      return await ctx.client().projects.queueRules.results(projectId, ruleId, since);
    }),
};

const preview: LeafCommand = {
  kind: 'leaf',
  name: 'preview',
  description:
    'What a rule would queue among the project’s recent runs, without queueing anything.',
  usage:
    'kindgi queue-rules preview [--project=<id>] [--agent=<id>] [--flow=<id>] [--agent-version=<v>] [--status=completed] [--include-dry-runs] [--sample=<0-1>] [--last=<n>] [--rule=<rule-id>]',
  optionSpec: {
    ...PROJECT_OPTION,
    ...WHEN_OPTIONS,
    sample: {
      type: 'string',
      description: 'The sample share to preview with, greater than 0 and at most 1.',
    },
    last: {
      type: 'string',
      description: 'How many recent runs to look at, 1 to 500 (default 100).',
    },
    rule: {
      type: 'string',
      description:
        "An existing rule's id: sample as it does, so the count is exactly what it would take.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules preview', async () => {
      const projectId = await projectIdFlag(ctx);
      const sample = sampleFlag(ctx);
      const last = integerFlag(ctx, 'last');
      const ruleId = stringFlag(ctx, 'rule');
      return await ctx.client().projects.queueRules.preview(projectId, {
        ...whenFromFlags(ctx),
        ...(sample !== undefined && { sample }),
        ...(last !== undefined && { last }),
        ...(ruleId !== undefined && { ruleId }),
      });
    }),
};

const queueRecent: LeafCommand = {
  kind: 'leaf',
  name: 'queue-recent',
  description:
    'Queue the rule’s matches among recent runs, to catch it up on runs that ended before it was there. The open-items cap is not applied.',
  usage: 'kindgi queue-rules queue-recent <rule-id> [--project=<id>] [--last=<n>] [--since=<time>]',
  optionSpec: {
    ...PROJECT_OPTION,
    last: {
      type: 'string',
      description:
        "This many of the project's most recent finished runs, 1 to 1000 (newest first).",
    },
    since: {
      type: 'string',
      description:
        'Runs finished at or after this time (an ISO 8601 time with a zone, or a date). Give --last and/or --since.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'queue-rules queue-recent', async () => {
      const ruleId = requiredPositional(ctx, 0, 'rule-id');
      const projectId = await projectIdFlag(ctx);
      const last = integerFlag(ctx, 'last');
      const since = timeFlag(ctx, 'since');
      if (last === undefined && since === undefined) {
        throw new UsageError('Give --last=<n> and/or --since=<time>');
      }
      return await ctx.client().projects.queueRules.queueRecent(projectId, ruleId, {
        ...(last !== undefined && { last }),
        ...(since !== undefined && { since }),
      });
    }),
};

export const queueRulesCommand: Command = {
  kind: 'group',
  name: 'queue-rules',
  description:
    "A project's queue rules — which finished runs a person is asked to correct (create / list / show / update / remove / versions / results / preview / queue-recent).",
  subcommands: [create, list, show, update, remove, versions, results, preview, queueRecent],
};
