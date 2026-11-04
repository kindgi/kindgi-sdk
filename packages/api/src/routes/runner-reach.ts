// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { type Action, type ResourceRef, ref } from '@kindgi/authz';

import { actsForOf } from '../caller.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';

//
// What `run` on a project reaches besides starting runs there.
//
// `run` is held by the project's runners and up, and by everyone in its
// workspace when the project lets everyone run. That last grant reads
// nothing by itself: no project, agent, flow or run. So a route that asks
// `read` refuses such a person, except where it names `run` as enough:
//   - their own runs (`isOwnRun`): reading, following and stopping them;
//   - what they open or keep for themselves: their conversations, their
//     own schedules;
//   - what they may run: the project, and its agents and flows with their
//     versions; an agent's page names its owner by id alone
//     (`wasReadItself`).
// Each route says which. `run` is asked only when the route's own check
// refuses, and only for what it lets through.
//

/**
 * Whether the run is the caller's own: its `actsFor` is theirs
 * (`actsForOf`), as for one they started or their own schedule fired. A run
 * that acts for a service account, for the project, or for no one is never
 * a person's own.
 */
export function isOwnRun(c: Context<AppEnv>, run: { readonly actsFor?: string }): boolean {
  return run.actsFor !== undefined && run.actsFor === actsForOf(c);
}

/**
 * Nothing when the caller may take `action` on `resource`, or when
 * `runIn` names a project they may `run`; else `action`'s refusal, the
 * authorizer's own 403, to return as is. `runIn` `undefined`: `action`
 * alone.
 */
export async function actionOrRunRefusal(
  authorizer: Authorizer | undefined,
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
  runIn: string | undefined,
): Promise<Response | undefined> {
  const refused = await deniedBy(authorizer, c, action, resource);
  if (refused === undefined || authorizer === undefined || runIn === undefined) return refused;
  return (await authorizer.can(c, 'run', ref('project', runIn))) ? undefined : refused;
}

/**
 * A list page's rows the caller may `read` (on `readOn(row)`), and those
 * whose `runIn` project the caller may `run`, in the page's order. `runIn`
 * `undefined` for a row: `read` alone. The page's cursor stays the
 * store's, so a page this leaves short, or empty, still says where the next
 * one starts.
 */
export async function readableOrRun<T>(
  authorizer: Authorizer,
  c: Context<AppEnv>,
  rows: readonly T[],
  readOn: (row: T) => ResourceRef,
  runIn: (row: T) => string | undefined,
): Promise<T[]> {
  const readable = new Set(await authorizer.filterByCan(c, 'read', rows, readOn));
  const rest = rows.filter((row) => !readable.has(row) && runIn(row) !== undefined);
  const runnable = new Set(
    rest.length === 0
      ? []
      : await authorizer.filterByCan(c, 'run', rest, (row) => ref('project', runIn(row) as string)),
  );
  return rows.filter((row) => readable.has(row) || runnable.has(row));
}

/** The requests whose item the caller reads on `read` itself (`noteReadItself`). */
const readItself = new WeakSet<Request>();

/**
 * Notes that the caller may `read` what this request reads, not only `run`
 * in its project. The item's gate calls it when `read` passes.
 */
export function noteReadItself(c: Context<AppEnv>): void {
  readItself.add(c.req.raw);
}

/**
 * Whether the item's gate let the caller through on `read` itself. `false`
 * where `run` alone let them through: the answer then leaves out what
 * names a person.
 */
export function wasReadItself(c: Context<AppEnv>): boolean {
  return readItself.has(c.req.raw);
}
