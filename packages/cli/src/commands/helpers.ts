// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import { KindgiApiError } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { formatThrown } from '../errors.js';
import { type Column, type Rendered, renderJson, renderTable } from '../output.js';
import type { CommandResult } from './types.js';

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

/** `text` cut to `max` characters, ending in `…` when cut — for a table cell. */
export function truncateCell(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Call a leaf that has already produced a `Rendered` (custom formatting
 * such as tables), still routing any thrown value through the standard
 * error formatter.
 */
export async function runSdkRendered(
  ctx: CommandContext,
  commandLabel: string,
  fn: () => Promise<Rendered>,
): Promise<CommandResult> {
  try {
    const rendered = await fn();
    return { kind: 'ok', rendered };
  } catch (err) {
    return commandResultFromThrown(err, ctx, commandLabel);
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
    throw new Error(`Malformed JSON input: ${(err as Error).message}`);
  }
}

/** Extract a required positional arg from `ctx.positionals`. */
export function requiredPositional(ctx: CommandContext, index: number, label: string): string {
  const value = ctx.positionals[index];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing required argument: ${label}`);
  }
  return value;
}

/** Extract an optional string flag. */
export function stringFlag(ctx: CommandContext, name: string): string | undefined {
  const raw = ctx.options[name];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** Every value of a repeatable string flag (`--segment=a --segment=b`), in order. */
export function stringListFlag(ctx: CommandContext, name: string): readonly string[] {
  const raw = ctx.options[name];
  if (typeof raw === 'string') return raw === '' ? [] : [raw];
  if (Array.isArray(raw)) return raw.filter((v: string) => v !== '');
  return [];
}

/**
 * The project a command writes into: `--project=<id>`, or the tenant's
 * Default project when the flag is absent.
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

/** Extract an optional integer flag; throws on non-integer values. */
export function integerFlag(ctx: CommandContext, name: string): number | undefined {
  const raw = ctx.options[name];
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`--${name} must be an integer, got '${raw}'`);
  }
  return n;
}
