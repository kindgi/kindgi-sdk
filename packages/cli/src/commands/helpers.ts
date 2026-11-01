// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import { KindgiApiError } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError, formatThrown } from '../errors.js';
import { type Column, type Rendered, renderJson, renderTable } from '../output.js';
import type { CommandResult } from './types.js';

/**
 * The exit code of a command that ran, and whose answer is no: a release
 * gate refused a version or wants an approval, a version didn't go
 * live, a test run failed. An error is 1, a usage error 2.
 */
export const ANSWER_NO_EXIT_CODE = 3;

/**
 * How a list command's page renders under `--table`: its rows and the
 * columns to show. A command without one prints JSON under `--table`.
 */
export interface TableSpec<Page, Row> {
  readonly rows: (page: Page) => readonly Row[];
  readonly columns: readonly Column<Row>[];
}

/**
 * Wrap an SDK call so any thrown value maps to a `CommandResult`. Any
 * `KindgiApiError` — including the preview `not-implemented-in-preview`
 * stub — is rendered via `formatThrown`. With `table`, `--table` renders
 * the page as a table.
 */
export async function runSdk<T, Row = never>(
  ctx: CommandContext,
  commandLabel: string,
  fn: () => Promise<T>,
  table?: TableSpec<T, Row>,
): Promise<CommandResult> {
  try {
    const value = await fn();
    if (table !== undefined && ctx.globals.format === 'table') {
      return { kind: 'ok', rendered: renderPageTable(value, table) };
    }
    return { kind: 'ok', rendered: renderJson(value, ctx.globals.format) };
  } catch (err) {
    return commandResultFromThrown(err, ctx, commandLabel);
  }
}

/** A page as a table; the next page's `--cursor`, which the table has no room for, on stderr. */
function renderPageTable<T, Row>(page: T, table: TableSpec<T, Row>): Rendered {
  const rendered = renderTable(table.rows(page), table.columns);
  const next = (page as { readonly nextCursor?: unknown }).nextCursor;
  return typeof next === 'string' && next !== ''
    ? { ...rendered, stderr: `Next page: --cursor=${next}\n` }
    : rendered;
}

/**
 * A list asked for with `--<flag>` whose page doesn't say it was filtered:
 * a runtime from before the filter ignored it and listed them all. The
 * command stops instead of printing that list as the filtered one.
 */
export function filterIgnored(flag: string, since: string): Error {
  return new Error(`--${flag} needs a runtime on Kindgi ${since} or later.`);
}

/** `text` cut to `max` characters, ending in `…` when cut — for a table cell. */
export function truncateCell(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Call a leaf that has already produced a `Rendered` (custom formatting
 * such as tables), still routing any thrown value through the standard
 * error formatter. An `exitCode` with it is the command's own (e.g. a run
 * that failed: its output is still printed, and the exit code says so).
 * A thrown refusal `answeredNo` picks out is printed as any error is, and
 * exits `ANSWER_NO_EXIT_CODE`.
 */
export async function runSdkRendered(
  ctx: CommandContext,
  commandLabel: string,
  fn: () => Promise<Rendered & { readonly exitCode?: number }>,
  answeredNo?: (err: unknown) => boolean,
): Promise<CommandResult> {
  try {
    const { stdout, stderr, exitCode } = await fn();
    return {
      kind: 'ok',
      rendered: { stdout, stderr },
      ...(exitCode !== undefined && { exitCode }),
    };
  } catch (err) {
    const result = commandResultFromThrown(err, ctx, commandLabel);
    // A refusal that is the command's answer (`answeredNo`): said as any
    // error is, with the exit code that says the answer is no.
    if (result.kind === 'error' && answeredNo?.(err) === true) {
      return { ...result, exitCode: ANSWER_NO_EXIT_CODE };
    }
    return result;
  }
}

export function commandResultFromThrown(
  err: unknown,
  ctx: CommandContext,
  commandLabel: string,
): CommandResult {
  const cliErr = formatThrown(err, { commandLabel, verbose: ctx.globals.verbose });
  return { kind: 'error', stderr: cliErr.stderr, exitCode: cliErr.exitCode };
}

/**
 * Ensure a stubbed SDK method surfaces the same "not wired yet" error
 * shape as the SDK itself throws when the method exists but the
 * transport body is a stub. Used for CLI commands that map to routes
 * whose SDK method is missing entirely today.
 */
export function throwUnwired(methodName: string): never {
  throw new KindgiApiError({
    code: 'not-implemented-in-preview',
    message: `${methodName}: transport not implemented — SDK method not yet exposed in this preview release`,
    method: methodName,
  });
}

/** Read a JSON value from either a file path (with `@` prefix) or an inline string. */
export async function readJsonInput(spec: string): Promise<unknown> {
  const raw = spec.startsWith('@') ? await readFile(spec.slice(1), 'utf8') : spec;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`Malformed JSON input: ${(err as Error).message}`);
  }
}

/** Extract a required positional arg from `ctx.positionals`. */
export function requiredPositional(ctx: CommandContext, index: number, label: string): string {
  const value = ctx.positionals[index];
  if (typeof value !== 'string' || value === '') {
    throw new UsageError(`Missing required argument: ${label}`);
  }
  return value;
}

/**
 * A trigger's version, the optional argument at `index`: its number, a
 * whole number from 1, as `…/versions/{version}` takes it. Undefined when
 * it isn't given.
 */
export function triggerVersionPositional(ctx: CommandContext, index: number): number | undefined {
  const raw = ctx.positionals[index];
  if (raw === undefined) return undefined;
  const version = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw new UsageError(`<version> must be a whole number from 1, got "${raw}"`);
  }
  return version;
}

/** A trigger's version as each kind's `versions` page holds it, for its table. */
interface TriggerVersionRow {
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy?: string | undefined;
  readonly cause: string;
}

/**
 * `schedules versions`, `webhooks versions` and `mail-triggers versions`
 * under `--table`: each version's number, when it was made, by whom
 * (`Kindgi` for one the runtime made itself, which names no one) and why.
 */
export const TRIGGER_VERSIONS_TABLE: TableSpec<
  { readonly data: readonly TriggerVersionRow[] },
  TriggerVersionRow
> = {
  rows: (p) => p.data,
  columns: [
    { header: 'VERSION', get: (v) => String(v.version) },
    { header: 'CREATED', get: (v) => v.createdAt },
    { header: 'BY', get: (v) => v.createdBy ?? 'Kindgi' },
    { header: 'CAUSE', get: (v) => v.cause },
  ],
};

/** Extract an optional string flag. */
export function stringFlag(ctx: CommandContext, name: string): string | undefined {
  const raw = ctx.options[name];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * A flag's value, trimmed, or `undefined` when it isn't given. Given empty
 * (`--org=$ORG` with `ORG` unset) is a usage error, never the same as not
 * given: a project in no org, or a slug nobody chose, would be made.
 */
export function givenFlag(ctx: CommandContext, name: string): string | undefined {
  const raw = ctx.options[name];
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw new UsageError(`--${name} takes a value`);
  return value;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONED_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Year, month and day name a real date (and, when given, a real time of day). */
function isCalendarTime(parts: RegExpExecArray): boolean {
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts.slice(1).map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  return (
    (year as number) >= 1000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month as number) - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

/**
 * A time given to `--<name>`, as the API takes a time (`toISOString()`):
 * an ISO 8601 time with a zone (`2026-10-09T12:00:00Z`,
 * `2026-10-09T14:00:00+02:00`), or a date (`2026-10-09`), read as the
 * start of that day in UTC. Anything else is a usage error here, rather
 * than the API's `400` for a time that isn't a `date-time`.
 */
export function timeFlagValue(raw: string, name: string): string {
  const date = DATE_ONLY.exec(raw);
  if (date !== null && isCalendarTime(date)) return `${raw}T00:00:00.000Z`;
  const time = ZONED_TIME.exec(raw);
  if (time !== null && isCalendarTime(time)) return new Date(raw).toISOString();
  throw new UsageError(
    `--${name} must be an ISO 8601 time with a zone (2026-10-09T12:00:00Z) or a date (2026-10-09); got "${raw}"`,
  );
}

/** An optional time flag, as `timeFlagValue` reads it. */
export function timeFlag(ctx: CommandContext, name: string): string | undefined {
  const raw = stringFlag(ctx, name);
  return raw === undefined ? undefined : timeFlagValue(raw, name);
}

/**
 * A repeatable `--<name>=key:value` flag (default `--segment`): a segment
 * path, in order (coarse to fine).
 */
export function segmentsFlag(
  ctx: CommandContext,
  name = 'segment',
): readonly { readonly key: string; readonly value: string }[] {
  return listFlag(ctx, name).map((raw) => {
    const at = raw.indexOf(':');
    if (at <= 0 || at === raw.length - 1) {
      throw new UsageError(`--${name} must be key:value, got "${raw}"`);
    }
    return { key: raw.slice(0, at), value: raw.slice(at + 1) };
  });
}

/**
 * The project a command writes into: `--project=<id>`, or the tenant's
 * default project when the flag is absent.
 */
export async function projectIdFlag(ctx: CommandContext): Promise<string> {
  return stringFlag(ctx, 'project') ?? (await ctx.client().projects.getDefault()).id;
}

/** The values of a repeatable flag (`multiple: true`), in the order given. */
export function listFlag(ctx: CommandContext, name: string): string[] {
  const raw: unknown = ctx.options[name];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * `--allow-unattended=<tool-id>` (repeatable) as a webhook's or a schedule's
 * `toolsAllowedUnattended`: the tools whose calls in its runs needn't wait
 * for a person's yes. On update, `none` clears the list; left out, the body
 * doesn't name it, so the trigger keeps its list.
 */
export function allowUnattendedField(
  ctx: CommandContext,
  on: 'register' | 'update',
): { toolsAllowedUnattended?: string[] } {
  const ids = listFlag(ctx, 'allow-unattended');
  if (ids.length === 0) return {};
  if (!ids.includes('none')) return { toolsAllowedUnattended: ids };
  if (on === 'register') {
    throw new UsageError('--allow-unattended=none clears the list on update: leave it out here');
  }
  if (ids.length > 1) {
    throw new UsageError('--allow-unattended=none clears the list: not with tool ids');
  }
  return { toolsAllowedUnattended: [] };
}

/**
 * A schedule's, a webhook trigger's or a mail trigger's `RUNS AS` cell: its
 * owner's name (else id), and whether that makes it personal (a person) or
 * shared (a service account). One run as its project's own account says
 * "this project". A trigger with no owner (the server's
 * `{service, 'unknown'}`) is neither: it starts nothing until an admin takes
 * it over. Empty when the server names no owner at all.
 */
export function runsAsCell(
  owner:
    | {
        readonly kind: string;
        readonly id: string;
        readonly displayName?: string;
        readonly isProjectAccount?: boolean;
      }
    | undefined,
): string {
  if (owner === undefined) return '';
  if (owner.kind === 'service' && owner.id === 'unknown') {
    return 'no owner (an admin can take it over)';
  }
  if (owner.isProjectAccount === true) return 'this project (shared)';
  return `${owner.displayName ?? owner.id} (${owner.kind === 'user' ? 'personal' : 'shared'})`;
}

/**
 * The owner `--run-as` names, as a register or take-over body says it:
 * `project` is the trigger's project's own account (`runAsProject`), and
 * anything else a service account's id. A runtime's account ids are UUIDs,
 * so the word can't be one. Nothing when the flag is absent.
 */
export function runAsFields(runAs: string | undefined): {
  readonly runAsProject?: true;
  readonly runAsServiceAccountId?: string;
} {
  if (runAs === undefined) return {};
  return runAs === 'project' ? { runAsProject: true } : { runAsServiceAccountId: runAs };
}

/** Extract an optional integer flag; throws on non-integer values. */
export function integerFlag(ctx: CommandContext, name: string): number | undefined {
  const raw = ctx.options[name];
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new UsageError(`--${name} must be an integer, got '${raw}'`);
  }
  return n;
}
