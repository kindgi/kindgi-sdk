// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Run, RunPage } from '@kindgi/client';
import type { AgentId, FlowId, RunId } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import { renderJson } from '../output.js';
import { followRun, runsGetHint } from '../runs/follow.js';
import {
  type TableSpec,
  commandResultFromThrown,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  segmentsFlag,
  stringFlag,
} from './helpers.js';
import {
  RESUME_EXIT_CODES,
  type WaitingApproval,
  runWaitAnswer,
  runWaitText,
} from './run-waits.js';
import type { Command, LeafCommand } from './types.js';

/** `runs list --table`. */
const RUNS_TABLE: TableSpec<RunPage, Run> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (run) => String(run.id) },
    { header: 'STATUS', get: (run) => run.status },
    { header: 'FLOW', get: (run) => run.flowId },
    { header: 'CREATED', get: (run) => String(run.createdAt) },
  ],
};

const REPLAYS = ['exclude', 'include', 'only'] as const;

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List runs (paginated).',
  usage:
    'kindgi runs list [--agent=<agent-id>] [--replays=exclude|include|only] [--eval-run=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    agent: {
      type: 'string',
      description:
        "Only this agent's turns, at any version: its own runs and the turns its steps start inside flows. Turns from before Kindgi 0.1.3 don't name their agent and aren't listed.",
    },
    replays: {
      type: 'string',
      description:
        'Replay runs (an eval run re-running a past run): `exclude` (the default) leaves them out, `include` lists them too, `only` lists just them.',
    },
    'eval-run': {
      type: 'string',
      description: "Only this eval run's replay runs.",
    },
    limit: {
      type: 'string',
      description: 'The most runs to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'runs list',
      async () => {
        const cursor = stringFlag(ctx, 'cursor');
        const replays = stringFlag(ctx, 'replays');
        if (replays !== undefined && !REPLAYS.includes(replays as (typeof REPLAYS)[number])) {
          throw new Error(`--replays must be one of ${REPLAYS.join(', ')}, got "${replays}"`);
        }
        const evalRunId = stringFlag(ctx, 'eval-run');
        const agentId = stringFlag(ctx, 'agent');
        const limitStr = stringFlag(ctx, 'limit');
        const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined;
        if (limit !== undefined && Number.isNaN(limit)) {
          throw new Error(`--limit must be an integer, got "${limitStr}"`);
        }
        return await ctx.client().runs.list({
          ...(cursor !== undefined && { cursor: cursor as never }),
          ...(limit !== undefined && { limit }),
          ...(replays !== undefined && { replays: replays as (typeof REPLAYS)[number] }),
          ...(evalRunId !== undefined && { evalRunId }),
          ...(agentId !== undefined && { agentId }),
        });
      },
      RUNS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a run snapshot by id.',
  usage: 'kindgi runs get <run-id>',
  run: (ctx) =>
    runSdk(ctx, 'runs get', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id') as RunId;
      return ctx.client().runs.get(runId);
    }),
};

const cancel: LeafCommand = {
  kind: 'leaf',
  name: 'cancel',
  description: 'Request cancellation of a run.',
  usage: 'kindgi runs cancel <run-id>',
  run: (ctx) =>
    runSdk(ctx, 'runs cancel', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id') as RunId;
      await ctx.client().runs.cancel(runId);
      return { ok: true, runId };
    }),
};

const journal: LeafCommand = {
  kind: 'leaf',
  name: 'journal',
  description: 'Read the durable journal for a run.',
  usage: 'kindgi runs journal <run-id> [--since=<seq>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    since: {
      type: 'string',
      description: 'Only the entries after this sequence number.',
    },
    limit: {
      type: 'string',
      description:
        'The most entries to return. Not applied yet: the API returns the whole journal.',
    },
    cursor: {
      type: 'string',
      description: 'Resume after this cursor. Not applied yet: the API returns the whole journal.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'runs journal', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id') as RunId;
      const since = stringFlag(ctx, 'since');
      const cursor = stringFlag(ctx, 'cursor');
      const limitStr = stringFlag(ctx, 'limit');
      const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined;
      if (limit !== undefined && Number.isNaN(limit)) {
        throw new Error(`--limit must be an integer, got "${limitStr}"`);
      }
      return await ctx.client().runs.journal(runId, {
        ...(since !== undefined && { since: since as never }),
        ...(cursor !== undefined && { cursor: cursor as never }),
        ...(limit !== undefined && { limit }),
      });
    }),
};

const stream: LeafCommand = {
  kind: 'leaf',
  name: 'stream',
  description: 'Subscribe to a run event stream (SSE).',
  usage: 'kindgi runs stream <run-id>',
  run: (ctx) =>
    runSdkRendered(ctx, 'runs stream', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id') as RunId;
      const iterable = ctx.client().runs.stream(runId);
      const lines: string[] = [];
      for await (const event of iterable) {
        lines.push(JSON.stringify(event));
      }
      return { stdout: lines.length === 0 ? '' : `${lines.join('\n')}\n`, stderr: '' };
    }),
};

const start: LeafCommand = {
  kind: 'leaf',
  name: 'start',
  description:
    'Start a run for an agent or flow. Waits until it finishes or waits on an approval; if the wait is stopped (Ctrl+C), the run goes on and its id is printed. A run that fails is still printed, its error goes to stderr (`Error [<code>]: …`), and the command exits 1. With --no-wait it prints as soon as the run exists (follow it with `runs get` / `runs stream`). --dry-run runs only read-only tools.',
  usage:
    'kindgi runs start (--agent=<agent-id> [--agent-version=<v>] | --flow=<flow-id> [--flow-version=<v>]) --input=<json-or-@file> [--project=<project-id>] [--segment=<key:value>]… [--no-wait] [--dry-run] [--idempotency-key=<key>]',
  optionSpec: {
    agent: {
      type: 'string',
      description: 'The agent to run, by id (`<pack>.<agent>`). Give `--agent` or `--flow`.',
    },
    'agent-version': {
      type: 'string',
      description:
        "The agent's version to run (default: its latest). A turn in a conversation needs the version the conversation was opened with.",
    },
    flow: {
      type: 'string',
      description: 'The flow to run, by id. Give `--flow` or `--agent`, not both.',
    },
    'flow-version': {
      type: 'string',
      description: "The flow's version to run (default: its latest).",
    },
    input: {
      type: 'string',
      description: "The run's input as JSON, or `@<file>` to read it from a file. Required.",
    },
    project: {
      type: 'string',
      description:
        "The project to run in (`kindgi projects list`). Default: the tenant's Default project.",
    },
    segment: {
      type: 'string',
      multiple: true,
      description:
        "One step of the run's segment path, `key:value` (e.g. `company:acme`); repeat it in order, coarse to fine. It picks the agent's live version.",
    },
    'idempotency-key': {
      type: 'string',
      description: 'A retry with the same key returns the run the first call started.',
    },
    'no-wait': {
      type: 'boolean',
      description:
        'Return the run as soon as it exists, agent or flow; follow it with `kindgi runs stream` or `kindgi runs get`.',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'Run only the tools declared read-only (`mutating: false`); an agent turn skips its model call.',
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'runs start', async () => {
      const agent = stringFlag(ctx, 'agent');
      const flow = stringFlag(ctx, 'flow');
      const inputSpec = stringFlag(ctx, 'input');
      if (agent === undefined && flow === undefined) {
        throw new Error('--agent=<id> or --flow=<id> is required');
      }
      if (agent !== undefined && flow !== undefined) {
        throw new Error('--agent and --flow are mutually exclusive');
      }
      const projectId = stringFlag(ctx, 'project');
      const agentVersion = stringFlag(ctx, 'agent-version');
      const flowVersion = stringFlag(ctx, 'flow-version');
      if (agentVersion !== undefined && agent === undefined) {
        throw new Error('--agent-version goes with --agent=<agent-id>');
      }
      if (flowVersion !== undefined && flow === undefined) {
        throw new Error('--flow-version goes with --flow=<flow-id>');
      }
      if (inputSpec === undefined) {
        throw new Error('--input=<json-or-@file> is required');
      }
      const input = await readJsonInput(inputSpec);
      const idem = stringFlag(ctx, 'idempotency-key');
      // Always started in the background, so the run's id is known at once;
      // without --no-wait the CLI then follows it (`runs/follow.ts`).
      const options = {
        wait: false,
        ...(ctx.options['dry-run'] === true && { dryRun: true }),
      };
      const segments = segmentsFlag(ctx);
      const where = {
        ...(projectId !== undefined && { projectId }),
        ...(segments.length > 0 && { segments }),
      };
      const started = await (agent !== undefined
        ? ctx.client().runs.start({
            agent: agent as AgentId,
            ...(agentVersion !== undefined && { agentVersion }),
            ...where,
            input,
            options,
            ...(idem !== undefined ? { idempotencyKey: idem } : {}),
          })
        : ctx.client().runs.start({
            flow: flow as FlowId,
            ...(flowVersion !== undefined && { flowVersion }),
            ...where,
            input,
            options,
            ...(idem !== undefined ? { idempotencyKey: idem } : {}),
          }));
      // The run, as `runs get` prints it: its `id` is the run id.
      const run =
        ctx.options['no-wait'] === true ? started : await followUntilSettled(ctx, started);
      const rendered = renderJson(run, ctx.globals.format);
      const warnings = renderTurnWarnings(run.output);
      if (run.status !== 'failed') return { stdout: rendered.stdout, stderr: warnings };
      // A run that failed still prints, so its id and failure are at hand;
      // the exit code says it failed, for scripts.
      return {
        stdout: rendered.stdout,
        stderr: ctx.globals.format === 'quiet' ? '' : `${warnings}${await runFailedLine(run)}`,
        exitCode: 1,
      };
    }),
};

/**
 * The stderr line for a run that ended `failed`. An agent turn's failure
 * reads back as its typed error, as the SDK's `invokeAgent` reads it
 * (`parseFailureMessage`); any other shows the run's failure message.
 */
async function runFailedLine(run: Run): Promise<string> {
  // Loaded only for a failed run: it brings in the whole agent loop.
  const { parseFailureMessage } = await import('@kindgi/agents');
  const error = parseFailureMessage(run.failureMessage);
  if (error !== undefined) return `Error [${error.code}]: ${error.message}\n`;
  const message =
    run.failureMessage !== undefined && run.failureMessage !== ''
      ? run.failureMessage
      : `Run ${run.id} failed`;
  return `Error [run-failed]: ${message}\n`;
}

/**
 * Follow a started run until it settles. Ctrl+C stops the wait, not the
 * run: it says which run goes on, and exits 130.
 */
async function followUntilSettled(ctx: CommandContext, started: Run): Promise<Run> {
  const interrupted = (): void => {
    process.stderr.write(
      `\nStopped waiting. Run ${started.id} goes on: ${runsGetHint(started.id)}\n`,
    );
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  try {
    return await followRun(started, { get: (id) => ctx.client().runs.get(id as RunId) });
  } finally {
    process.removeListener('SIGINT', interrupted);
  }
}

/**
 * An agent turn's warnings (`AgentTurnResult.warnings`) as stderr lines —
 * e.g. a turn a fallback provider answered because nothing else fits.
 */
function renderTurnWarnings(output: unknown): string {
  const warnings = (output as { readonly warnings?: unknown } | null | undefined)?.warnings;
  if (!Array.isArray(warnings)) return '';
  const codes = new Set(warnings.map((w) => (w as { readonly code?: unknown }).code));
  return (
    warnings
      // dev-echo's own warning says more than "a fallback provider answered".
      .filter(
        (w) =>
          !(
            (w as { readonly code?: unknown }).code === 'fallback-provider' &&
            codes.has('dev-echo-not-a-model')
          ),
      )
      .map((w) => (w as { readonly message?: unknown }).message)
      .filter((m): m is string => typeof m === 'string')
      .map((m) => `⚠ ${m}\n`)
      .join('')
  );
}

const resume: LeafCommand = {
  kind: 'leaf',
  name: 'resume',
  description:
    'Say what a run waits for before it resumes: an approval (named, with the command that decides it), the runtime (a queued start, a child run, a retry, a lease, a timeout), or nothing. Exit 0: not waiting; 3: waits for an approval; 4: waits on the runtime. (5 is reserved for a held run.)',
  usage: 'kindgi runs resume <run-id>',
  run: async (ctx) => {
    try {
      const runId = requiredPositional(ctx, 0, 'run-id');
      const client = ctx.client();
      const answer = await runWaitAnswer(
        {
          getRun: async (id) => await client.runs.get(id as RunId),
          journalPage: async (id, since) =>
            await client.runs.journal(id as RunId, since !== undefined ? { since } : undefined),
          approvalsFor: async (tokenIds) => {
            const page = await client.approvals.list({ waitTokenIds: tokenIds, limit: 100 });
            return page.data.flatMap((a): WaitingApproval[] =>
              typeof a.waitTokenId === 'string'
                ? [
                    {
                      id: a.id as unknown as string,
                      ...(typeof a.title === 'string' && { title: a.title }),
                      requiredRole: a.requiredRole,
                      status: a.status,
                      waitTokenId: a.waitTokenId,
                    },
                  ]
                : [],
            );
          },
        },
        runId,
      );
      const json = renderJson(answer, ctx.globals.format);
      const quiet = ctx.globals.format === 'quiet';
      return {
        kind: 'ok',
        rendered: { stdout: json.stdout, stderr: quiet ? '' : runWaitText(answer) },
        exitCode: RESUME_EXIT_CODES[answer.kind],
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'runs resume');
    }
  },
};

export const runsCommand: Command = {
  kind: 'group',
  name: 'runs',
  description: 'Manage kernel runs — the single execution primitive.',
  subcommands: [list, get, cancel, journal, stream, start, resume],
};
