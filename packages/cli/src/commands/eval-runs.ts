// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type FlowRefs, type FlowVersionOverrides, overridableRefs } from '@kindgi/flow';
import type { FlowId } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import { integerFlag, listFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

const READS = ['recorded', 'live'] as const;
const CLASS_WEIGHTS = ['as-recorded', 'restricted-only'] as const;

/** A flag that takes one of `values`; `undefined` when absent. */
function oneOfFlag<T extends string>(
  ctx: CommandContext,
  name: string,
  values: readonly T[],
): T | undefined {
  const raw = stringFlag(ctx, name);
  if (raw !== undefined && !(values as readonly string[]).includes(raw)) {
    throw new Error(`--${name} must be one of ${values.join(', ')}, got "${raw}"`);
  }
  return raw as T | undefined;
}

/** Statuses `start --wait` waits through. */
const IN_PROGRESS: ReadonlySet<string> = new Set(['pending', 'running']);

export interface FollowEvalRunOptions<T> {
  /** Read the eval run by id (the client's `evalRuns.get`). */
  readonly get: (runId: string) => Promise<T>;
  /** The pause between reads (default 1 s). */
  readonly pollMs?: number;
  /** The longest it waits (default 30 minutes), counted in pauses. */
  readonly maxMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The eval run as it is when it stops being in progress (`start --wait`).
 * Throws when it's still running after `maxMs`, naming the command that
 * shows it.
 */
export async function followEvalRun<T extends { readonly status: string }>(
  runId: string,
  options: FollowEvalRunOptions<T>,
): Promise<T> {
  const pollMs = options.pollMs ?? 1_000;
  const maxMs = options.maxMs ?? 30 * 60 * 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; ) {
    await sleep(pollMs);
    waited += pollMs;
    const run = await options.get(runId);
    if (!IN_PROGRESS.has(run.status)) return run;
    if (waited >= maxMs) {
      throw new Error(
        `Still running after ${Math.round(maxMs / 60_000)} minutes: kindgi eval-runs show ${runId}`,
      );
    }
  }
}

type Baseline =
  | 'recorded'
  | { agentId: string; version: string }
  | { live: { projectId?: string; segments?: Record<string, string> } };

/** `--baseline=live` with `--baseline-project` and `--baseline-segment`. */
function liveBaseline(project: string | undefined, segmentFlags: readonly string[]): Baseline {
  const segments: Record<string, string> = {};
  for (const entry of segmentFlags) {
    const at = entry.indexOf('=');
    if (at < 1 || at === entry.length - 1) {
      throw new Error(`--baseline-segment must be <key>=<value>, got "${entry}"`);
    }
    segments[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return {
    live: {
      ...(project !== undefined && { projectId: project }),
      ...(segmentFlags.length > 0 && { segments }),
    },
  };
}

/** `--baseline` with `--baseline-project` and `--baseline-segment`, as the request's `baseline`. */
function baselineFrom(ctx: CommandContext): Baseline | undefined {
  const baseline = stringFlag(ctx, 'baseline');
  const project = stringFlag(ctx, 'baseline-project');
  const segmentFlags = listFlag(ctx, 'baseline-segment');
  if (baseline !== 'live' && (project !== undefined || segmentFlags.length > 0)) {
    throw new Error('--baseline-project and --baseline-segment need --baseline=live');
  }
  if (baseline === undefined || baseline === 'recorded') return baseline;
  if (baseline === 'live') return liveBaseline(project, segmentFlags);
  const at = baseline.lastIndexOf('@');
  if (at < 1 || at === baseline.length - 1) {
    throw new Error(`--baseline must be recorded, live or <agentId>@<version>, got "${baseline}"`);
  }
  return { agentId: baseline.slice(0, at), version: baseline.slice(at + 1) };
}

/** `--agent` / `--flow` with their versions, as the request's `agentRef` or `flowRef`. */
function targetFrom(ctx: CommandContext) {
  const agent = stringFlag(ctx, 'agent');
  const flow = stringFlag(ctx, 'flow');
  if ((agent === undefined) === (flow === undefined)) {
    throw new Error('Give exactly one of --agent=<id> or --flow=<id>');
  }
  const agentVersion = stringFlag(ctx, 'agent-version');
  const flowVersion = stringFlag(ctx, 'flow-version');
  if (agentVersion !== undefined && agent === undefined) {
    throw new Error('--agent-version needs --agent');
  }
  if (flowVersion !== undefined && flow === undefined) {
    throw new Error('--flow-version needs --flow');
  }
  return agent !== undefined
    ? { agentRef: { agentId: agent, ...(agentVersion !== undefined && { version: agentVersion }) } }
    : {
        flowRef: {
          flowId: flow as string,
          ...(flowVersion !== undefined && { version: flowVersion }),
        },
      };
}

/** `<id>@<version>`, split on the last `@`. */
function idAtVersion(entry: string): { readonly id: string; readonly version: string } {
  const at = entry.lastIndexOf('@');
  if (at < 1 || at === entry.length - 1) {
    throw new Error(`--with must be <id>@<version>, got "${entry}"`);
  }
  return { id: entry.slice(0, at), version: entry.slice(at + 1) };
}

/** Each `--with` id as an agent or a tool, by which of the flow's refs it is. */
function splitVersions(
  entries: readonly { readonly id: string; readonly version: string }[],
  refs: FlowRefs,
  label: string,
): FlowVersionOverrides {
  const agents: Record<string, string> = {};
  const tools: Record<string, string> = {};
  for (const { id, version } of entries) {
    if (id in agents || id in tools) throw new Error(`--with names ${id} twice`);
    const agent = refs.agents.includes(id);
    const tool = refs.tools.includes(id);
    if (agent && tool) throw new Error(`${id} is both an agent and a tool in flow ${label}`);
    if (!agent && !tool) throw new Error(`flow ${label} doesn't use ${id}`);
    (agent ? agents : tools)[id] = version;
  }
  return {
    ...(Object.keys(agents).length > 0 && { agents }),
    ...(Object.keys(tools).length > 0 && { tools }),
  };
}

/**
 * `--with <id>@<version> ...` as the request's `versions`: each id is an
 * agent or a tool of the flow version, told apart by what the flow uses.
 */
async function versionsFrom(
  ctx: CommandContext,
  target: ReturnType<typeof targetFrom>,
): Promise<FlowVersionOverrides | undefined> {
  const entries = listFlag(ctx, 'with').map(idAtVersion);
  if (entries.length === 0) return undefined;
  if (!('flowRef' in target) || target.flowRef.version === undefined) {
    throw new Error(
      '--with needs --flow and --flow-version: it swaps versions into one flow version',
    );
  }
  const { flowId, version } = target.flowRef;
  const flow = await ctx.client().flows.versions.get(flowId as FlowId, version);
  return splitVersions(entries, overridableRefs(flow), `${flowId} ${version}`);
}

const PAGE_FLAGS = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
} as const;

const start: LeafCommand = {
  kind: 'leaf',
  name: 'start',
  description:
    "Start an eval run. On a test set (a `judged` suite), the run compares a version (`--agent` with `--agent-version`, or `--flow` with `--flow-version`) with the recorded runs: each case is replayed without doing anything the past run didn't, and the result's summary has the metrics.",
  usage:
    'kindgi eval-runs start <suite-id> --project=<id> (--agent=<id> [--agent-version=<v>] | --flow=<id> [--flow-version=<v>] [--with=<id>@<version> ...]) [--baseline=recorded|<agentId>@<version>|live] [--baseline-project=<id>] [--baseline-segment=<key>=<value> ...] [--reads=recorded|live] [--repetitions=<n>] [--k=<n>] [--class-weights=as-recorded|restricted-only] [--dry-run] [--wait]',
  optionSpec: {
    project: { type: 'string', description: 'The project the run belongs to. Required.' },
    agent: { type: 'string', description: 'Run this agent.' },
    'agent-version': {
      type: 'string',
      description: 'The agent version to run. Needs `--agent`. Default: the latest.',
    },
    flow: { type: 'string', description: 'Run this flow.' },
    'flow-version': {
      type: 'string',
      description: 'The flow version to run. Needs `--flow`. Default: the latest.',
    },
    with: {
      type: 'string',
      multiple: true,
      description:
        "With `--flow` and `--flow-version`: run one of the flow's agents or tools at another version, as `<id>@<version>`, without publishing a new flow version. Repeat the flag for several.",
    },
    baseline: {
      type: 'string',
      description:
        "What a test set's run compares the agent version with: `recorded` (the default: each case's output as it was judged), `<agentId>@<version>` (another version, replayed the same way) or `live` (the version live in a project or segment). Only `recorded` runs today.",
    },
    'baseline-project': {
      type: 'string',
      description: 'With `--baseline=live`: the project whose live version to compare with.',
    },
    'baseline-segment': {
      type: 'string',
      multiple: true,
      description:
        'With `--baseline=live`: the version live for this segment, as `<key>=<value>`. Repeat the flag for several.',
    },
    reads: {
      type: 'string',
      description:
        "Whether replayed reads use the past run's results when it has them (`recorded`, the default) or run live.",
    },
    repetitions: {
      type: 'string',
      description:
        'Run each case this many times (1 to 10, default 1); the summary shows the spread.',
    },
    k: {
      type: 'string',
      description: 'How many ranked items weighted precision@k looks at (1 to 100, default 10).',
    },
    'class-weights': {
      type: 'string',
      description:
        "Which judgments count: `as-recorded` (the default: each at its judge class's weight) or `restricted-only` (only judgments of classes restricted to some judges; a gate policy with `onlyRestrictedClasses` needs it).",
    },
    'dry-run': { type: 'boolean', description: 'Check the request without running anything.' },
    wait: {
      type: 'boolean',
      description: 'Wait until the run is done (at most 30 minutes), then print it.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'eval-runs start', async () => {
      const suiteId = requiredPositional(ctx, 0, 'suite-id');
      const projectId = stringFlag(ctx, 'project');
      if (projectId === undefined) throw new Error('--project=<id> is required');
      const target = targetFrom(ctx);
      const reads = oneOfFlag(ctx, 'reads', READS);
      const classWeights = oneOfFlag(ctx, 'class-weights', CLASS_WEIGHTS);
      const baseline = baselineFrom(ctx);
      const repetitions = integerFlag(ctx, 'repetitions');
      const k = integerFlag(ctx, 'k');
      const versions = await versionsFrom(ctx, target);
      const input = {
        ...target,
        ...(versions !== undefined && { versions }),
        ...(baseline !== undefined && { baseline }),
        ...(reads !== undefined && { reads }),
        ...(repetitions !== undefined && { repetitions }),
        ...(k !== undefined && { k }),
        ...(classWeights !== undefined && { classWeights }),
        ...(ctx.options['dry-run'] === true && { dryRun: true }),
      };
      const evalRuns = ctx.client().evalRuns;
      const started = await evalRuns.start(suiteId, input, { projectId });
      if (ctx.options.wait !== true) return started;

      return await followEvalRun(started.runId, { get: (id) => evalRuns.get(id) });
    }),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description: 'Show an eval run: its status and, once done, its summary.',
  usage: 'kindgi eval-runs show <run-id>',
  optionSpec: {},
  run: (ctx) =>
    runSdk(ctx, 'eval-runs show', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id');
      return await ctx.client().evalRuns.get(runId);
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List eval runs, newest first.',
  usage: `kindgi eval-runs list [--suite=<id>] [--status=${STATUSES.join('|')}] [--agent=<id>] [--limit=<n>] [--cursor=<c>]`,
  optionSpec: {
    suite: { type: 'string', description: 'Only runs of this suite.' },
    status: { type: 'string', description: `Only this status: ${STATUSES.join(', ')}.` },
    agent: { type: 'string', description: 'Only runs of this agent.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'eval-runs list', async () => {
      const status = stringFlag(ctx, 'status');
      if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
        throw new Error(`--status must be one of ${STATUSES.join(', ')}, got "${status}"`);
      }
      const suiteId = stringFlag(ctx, 'suite');
      const agentId = stringFlag(ctx, 'agent');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().evalRuns.list({
        ...(suiteId !== undefined && { suiteId }),
        ...(status !== undefined && { status: status as Status }),
        ...(agentId !== undefined && { agentId }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const cancel: LeafCommand = {
  kind: 'leaf',
  name: 'cancel',
  description: 'Cancel an eval run that is pending or running.',
  usage: 'kindgi eval-runs cancel <run-id>',
  optionSpec: {},
  run: (ctx) =>
    runSdk(ctx, 'eval-runs cancel', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id');
      return await ctx.client().evalRuns.cancel(runId);
    }),
};

export const evalRunsCommand: Command = {
  kind: 'group',
  name: 'eval-runs',
  description:
    'Eval runs: run an eval suite, or compare an agent version on a test set (start / show / list / cancel).',
  subcommands: [start, show, list, cancel],
};
