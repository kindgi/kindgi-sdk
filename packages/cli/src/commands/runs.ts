// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Run, RunPage } from '@kindgi/client';
import type { AgentId, FlowId, RunId } from '@kindgi/types';

import { renderJson } from '../output.js';
import {
  type TableSpec,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
  throwUnwired,
} from './helpers.js';
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

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List runs (paginated).',
  usage: 'kindgi runs list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
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
        const limitStr = stringFlag(ctx, 'limit');
        const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined;
        if (limit !== undefined && Number.isNaN(limit)) {
          throw new Error(`--limit must be an integer, got "${limitStr}"`);
        }
        return await ctx.client().runs.list({
          ...(cursor !== undefined && { cursor: cursor as never }),
          ...(limit !== undefined && { limit }),
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
    'Start a run for an agent or flow. Waits for it to finish; with --no-wait a flow run prints as soon as it exists and finishes in the background (follow it with `runs get` / `runs stream`). An agent run always answers when its turn ends. --dry-run runs only read-only tools.',
  usage:
    'kindgi runs start (--agent=<agent-id> | --flow=<flow-id>) --input=<json-or-@file> [--no-wait] [--dry-run] [--idempotency-key=<key>]',
  optionSpec: {
    agent: {
      type: 'string',
      description: 'The agent to run, by id (`<pack>.<agent>`). Give `--agent` or `--flow`.',
    },
    flow: {
      type: 'string',
      description: 'The flow to run, by id. Give `--flow` or `--agent`, not both.',
    },
    input: {
      type: 'string',
      description: "The run's input as JSON, or `@<file>` to read it from a file. Required.",
    },
    'idempotency-key': {
      type: 'string',
      description: 'A retry with the same key returns the run the first call started.',
    },
    'no-wait': {
      type: 'boolean',
      description:
        'Return a flow run as soon as it exists; follow it with `kindgi runs get`. An agent run still waits for its turn.',
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
      if (inputSpec === undefined) {
        throw new Error('--input=<json-or-@file> is required');
      }
      const input = await readJsonInput(inputSpec);
      const idem = stringFlag(ctx, 'idempotency-key');
      const options = {
        ...(ctx.options['no-wait'] === true && { wait: false }),
        ...(ctx.options['dry-run'] === true && { dryRun: true }),
      };
      const withOptions = Object.keys(options).length > 0 ? { options } : {};
      // The run, as `runs get` prints it: its `id` is the run id.
      const run = await (agent !== undefined
        ? ctx.client().runs.start({
            agent: agent as AgentId,
            input,
            ...withOptions,
            ...(idem !== undefined ? { idempotencyKey: idem } : {}),
          })
        : ctx.client().runs.start({
            flow: flow as FlowId,
            input,
            ...withOptions,
            ...(idem !== undefined ? { idempotencyKey: idem } : {}),
          }));
      const rendered = renderJson(run, ctx.globals.format);
      return { stdout: rendered.stdout, stderr: renderTurnWarnings(run.output) };
    }),
};

/**
 * An agent turn's warnings (`AgentTurnResult.warnings`) as stderr lines —
 * e.g. a turn a fallback provider answered because nothing else fits.
 */
function renderTurnWarnings(output: unknown): string {
  const warnings = (output as { readonly warnings?: unknown } | null | undefined)?.warnings;
  if (!Array.isArray(warnings)) return '';
  return warnings
    .map((w) => (w as { readonly message?: unknown }).message)
    .filter((m): m is string => typeof m === 'string')
    .map((m) => `⚠ ${m}\n`)
    .join('');
}

const resume: LeafCommand = {
  kind: 'leaf',
  name: 'resume',
  description: 'Resume a suspended run at a waitpoint.',
  usage: 'kindgi runs resume <run-id> --waitpoint=<id> --value=<json-or-@file>',
  optionSpec: {
    waitpoint: {
      type: 'string',
      description: 'The waitpoint to complete, by id. Required.',
    },
    value: {
      type: 'string',
      description:
        'The value to resume with, as JSON or `@<file>` to read it from a file. Required.',
    },
  },
  // Not available in this release: listed in `UNWIRED_COMMANDS`, with the
  // reason the CLI prints. The runtime refuses it too
  // (`run-resume-not-supported`).
  run: (ctx) => runSdk(ctx, 'runs resume', async () => throwUnwired('runs.resume')),
};

export const runsCommand: Command = {
  kind: 'group',
  name: 'runs',
  description: 'Manage kernel runs — the single execution primitive.',
  subcommands: [list, get, cancel, journal, stream, start, resume],
};
