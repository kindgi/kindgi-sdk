// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi usage`: your tenant's usage, aggregated (`client.usage.read`,
 * `GET /v1/usage`), over the projects you may read. One page of groups:
 * a month (`--month=YYYY-MM`, UTC; the current one by default) or a
 * window (`--from`, `--to`), grouped and filtered as the API takes them.
 * `--table` prints the groups, and on stderr the watermark and the next
 * page's `--cursor`.
 */

import type { UsageGroup, UsageGroupKey, UsagePage, UsageQuery } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type Column, renderJson, renderTable } from '../output.js';
import { integerFlag, runSdkRendered, stringFlag, timeFlag } from './helpers.js';
import type { LeafCommand } from './types.js';

const GROUP_KEYS: readonly UsageGroupKey[] = ['project', 'agent', 'kind', 'class', 'state', 'day'];
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The window: `--month`, `--from` and `--to`, or the current UTC month. */
function window(ctx: CommandContext): { readonly from: string; readonly to: string } {
  const month = stringFlag(ctx, 'month');
  const from = timeFlag(ctx, 'from');
  const to = timeFlag(ctx, 'to');
  if (month !== undefined && (from !== undefined || to !== undefined)) {
    throw new UsageError('Give --month, or --from and --to, not both.');
  }
  if (month === undefined && (from !== undefined || to !== undefined)) {
    if (from === undefined || to === undefined) {
      throw new UsageError('--from and --to go together: the window is from one to the other.');
    }
    return { from, to };
  }
  let year: number;
  let index: number;
  if (month === undefined) {
    const now = new Date();
    year = now.getUTCFullYear();
    index = now.getUTCMonth();
  } else {
    const m = MONTH.exec(month);
    if (m === null) {
      throw new UsageError(`--month must be YYYY-MM, such as 2026-11; got "${month}"`);
    }
    year = Number(m[1]);
    index = Number(m[2]) - 1;
  }
  return {
    from: new Date(Date.UTC(year, index, 1)).toISOString(),
    to: new Date(Date.UTC(year, index + 1, 1)).toISOString(),
  };
}

/** A comma-separated flag as a list; `undefined` when absent. */
function commaFlag(ctx: CommandContext, name: string): string[] | undefined {
  const raw = stringFlag(ctx, name);
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function groupByFlag(ctx: CommandContext): UsageGroupKey[] | undefined {
  const keys = commaFlag(ctx, 'group-by');
  if (keys === undefined) return undefined;
  const unknown = keys.filter((k) => !(GROUP_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new UsageError(`--group-by takes ${GROUP_KEYS.join(', ')}; got ${unknown.join(', ')}`);
  }
  return keys as UsageGroupKey[];
}

/** The columns for the dimensions grouped by, then the counts. */
function columnsFor(groupBy: readonly UsageGroupKey[]): Column<UsageGroup>[] {
  const dimension: Record<UsageGroupKey, Column<UsageGroup>> = {
    project: { header: 'PROJECT', get: (g) => g.projectId ?? '(none)' },
    agent: { header: 'AGENT', get: (g) => g.agentId ?? '(none)' },
    kind: { header: 'KIND', get: (g) => g.kind ?? '' },
    class: { header: 'CLASS', get: (g) => g.class ?? '' },
    state: { header: 'STATE', get: (g) => g.state ?? '' },
    day: { header: 'DAY', get: (g) => g.day ?? '' },
  };
  return [
    ...groupBy.map((k) => dimension[k]),
    { header: 'COUNT', get: (g) => String(g.count) },
    { header: 'QUANTITY', get: (g) => String(g.quantity) },
    { header: 'FIRST', get: (g) => g.firstAt },
    { header: 'LAST', get: (g) => g.lastAt },
  ];
}

export const usageCommand: LeafCommand = {
  kind: 'leaf',
  name: 'usage',
  description:
    "Your workspace's usage, aggregated, over the projects you may read: a month's (or a window's) counts and sums by project, agent, kind, class, state or day.",
  usage:
    'kindgi usage [--month=<YYYY-MM> | --from=<time> --to=<time>] [--project=<id>] [--group-by=<keys>] [--kind=<kinds>] [--class=<classes>] [--state=<states>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    month: {
      type: 'string',
      description: 'A calendar month in UTC, YYYY-MM (default: the current one).',
    },
    from: {
      type: 'string',
      description: "The window's start: a time with a zone, or a date (UTC). With --to.",
    },
    to: {
      type: 'string',
      description: "The window's end, not included; at most 92 days after --from.",
    },
    project: {
      type: 'string',
      description: "Only this project's usage. One you can't read gives no groups.",
    },
    'group-by': {
      type: 'string',
      description: `Comma-separated, from ${GROUP_KEYS.join(', ')} (default project,kind).`,
    },
    kind: {
      type: 'string',
      description: 'Only these kinds, comma-separated (run.started, run.ended, llm.inference, …).',
    },
    class: {
      type: 'string',
      description:
        'Only these run classes, comma-separated (production, staging, dry-run, replay, eval, child).',
    },
    state: {
      type: 'string',
      description: 'Only these states, comma-separated (completed, failed, approved, on, …).',
    },
    limit: { type: 'string', description: 'Groups a page: 1 to 10000 (default 1000).' },
    cursor: {
      type: 'string',
      description: "The previous page's `nextCursor`, from the same query.",
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'usage', async () => {
      const groupBy = groupByFlag(ctx);
      const kind = commaFlag(ctx, 'kind');
      const cls = commaFlag(ctx, 'class');
      const state = commaFlag(ctx, 'state');
      const project = stringFlag(ctx, 'project');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      const query: UsageQuery = {
        ...window(ctx),
        ...(groupBy !== undefined && { groupBy }),
        ...(kind !== undefined && { kind }),
        ...(cls !== undefined && { class: cls }),
        ...(state !== undefined && { state }),
        ...(project !== undefined && { projectId: project }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      };
      const page: UsagePage = await ctx.client().usage.read(query);
      if (ctx.globals.format !== 'table') return renderJson(page, ctx.globals.format);
      const table = renderTable(page.data, columnsFor(groupBy ?? ['project', 'kind']));
      const notes = [
        `Every record at or before ${page.watermark} is counted.`,
        ...(page.nextCursor !== undefined ? [`Next page: --cursor=${page.nextCursor}`] : []),
      ];
      return { stdout: table.stdout, stderr: `${notes.join('\n')}\n` };
    }),
};
