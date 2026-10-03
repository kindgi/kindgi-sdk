// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import { KindgiApiError } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { formatThrown } from '../errors.js';
import { type Rendered, renderJson } from '../output.js';
import type { CommandResult } from './types.js';

/**
 * Wrap an SDK call so any thrown value maps to a `CommandResult`. Any
 * `KindgiApiError` — including the preview `not-implemented-in-preview`
 * stub — is rendered via `formatThrown`.
 */
export async function runSdk<T>(
  ctx: CommandContext,
  commandLabel: string,
  fn: () => Promise<T>,
): Promise<CommandResult> {
  try {
    const value = await fn();
    return { kind: 'ok', rendered: renderJson(value, ctx.globals.format) };
  } catch (err) {
    return commandResultFromThrown(err, ctx, commandLabel);
  }
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

/**
 * The project a command writes into: `--project=<id>`, or the tenant's
 * Default project when the flag is absent.
 */
export async function projectIdFlag(ctx: CommandContext): Promise<string> {
  return stringFlag(ctx, 'project') ?? (await ctx.client().projects.getDefault()).id;
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
