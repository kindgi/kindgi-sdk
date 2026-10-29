// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where builds and new versions enter an environment order: its first
 * environment only. A later environment takes builds by promotion from
 * the one before it, so nothing runs there that didn't pass through the
 * environments before it. A deploy, a publish through the API and a
 * derived agent version aimed at a later environment are refused with
 * `409 environment-takes-promotions`, before anything is written. A
 * project in no order, or first in its order, takes them as before.
 *
 * Eval suites aren't refused: they're test data, published in any
 * environment, and reached there and in the later ones.
 */

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectId, TenantId } from '@kindgi/types';

import type {
  EnvironmentOrderBinding,
  EnvironmentOrderLocation,
} from './environment-orders-binding.js';
import { statusFor, toWireError } from './errors.js';
import type { Authorizer } from './middleware/authorize.js';
import type { AppEnv } from './types.js';

/** A later environment of an order: where builds and new versions go instead, and its place. */
export interface LaterEnvironment {
  /** The order's first environment. */
  readonly firstProjectId: ProjectId;
  /** The project's place in the order, from 0; never 0 here. */
  readonly position: number;
}

/** What was aimed at a later environment. */
export type EnvironmentEntry =
  | { readonly kind: 'deploy' }
  | { readonly kind: 'publish'; readonly noun: string }
  | { readonly kind: 'derive' }
  /** A tool pin: it acts where agent and flow versions are made, which is the first environment. */
  | { readonly kind: 'tool-pin' };

/**
 * Where `projectId` sits when it's a later environment of its order;
 * `undefined` when it's first in its order, in no order, or there are no
 * orders (`orders` absent).
 */
export async function laterEnvironment(
  orders: Pick<EnvironmentOrderBinding, 'orderOf'> | undefined,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<LaterEnvironment | undefined> {
  if (orders === undefined) return undefined;
  const order = await orders.orderOf({ tenantId, projectId });
  const first = order?.projects[0];
  if (order === undefined || order.position === 0 || first === undefined) return undefined;
  return { firstProjectId: first, position: order.position };
}

/**
 * The first environment of `projectId`'s order, where its new versions are
 * made; `undefined` when it's in no order, or there are no orders.
 */
export async function firstEnvironmentOf(
  orders: Pick<EnvironmentOrderBinding, 'orderOf'> | undefined,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ProjectId | undefined> {
  if (orders === undefined) return undefined;
  return (await orders.orderOf({ tenantId, projectId }))?.projects[0];
}

/**
 * The environment order one of `projects` belongs to — the first such
 * project's, in the order given — or `undefined` when none is in an order
 * (or there are no orders). A live change wider than one project for an item
 * any of whose projects is in an order would span that order's environments,
 * so it's refused (the width refusal), whether one project serves the item
 * or several.
 */
export async function orderSpanning(
  orders: Pick<EnvironmentOrderBinding, 'orderOf'> | undefined,
  tenantId: TenantId,
  projects: readonly ProjectId[],
): Promise<EnvironmentOrderLocation | undefined> {
  if (orders === undefined) return undefined;
  for (const projectId of projects) {
    const order = await orders.orderOf({ tenantId, projectId });
    if (order !== undefined) return order;
  }
  return undefined;
}

/** The refusal's message: the rule, then what to do instead, then that nothing was written. */
export function environmentTakesPromotionsMessage(
  entry: EnvironmentEntry,
  later: LaterEnvironment,
): string {
  const rule = `This project is a later environment of its environment order (position ${later.position}), and a later environment takes builds only by promotion from the one before it.`;
  if (entry.kind === 'deploy') {
    return `${rule} Deploy into the order's first environment and promote the build from there. Nothing was deployed.`;
  }
  if (entry.kind === 'publish') {
    return `${rule} Publish the ${entry.noun} in the order's first environment instead: what moves between environments is builds, so a version published through the API stays in the environment it was published in. Nothing was published.`;
  }
  if (entry.kind === 'tool-pin') {
    return `${rule} A tool's pin acts when an agent or flow version is made and locks its tools, and in this order versions are made in the first environment: pin the tool there. Nothing was pinned.`;
  }
  return `${rule} A new version of an agent is made in the order's first environment, and reaches the later ones when a build of the agent is promoted. Nothing was made.`;
}

/**
 * The `environment-takes-promotions` answer (409), the same from every
 * route. `details.position` always; `details.firstProjectId` when the
 * caller may read that project, as an order's read names a project
 * (`GET /v1/environment-orders`).
 */
export async function environmentTakesPromotionsResponse(
  c: Context<AppEnv>,
  requestId: string,
  authorizer: Authorizer | undefined,
  entry: EnvironmentEntry,
  later: LaterEnvironment,
): Promise<Response> {
  const named =
    authorizer === undefined ||
    (await authorizer.can(c, 'read', ref('project', later.firstProjectId as unknown as string)));
  c.status(statusFor('environment-takes-promotions') as never);
  return c.json(
    toWireError(
      {
        code: 'environment-takes-promotions',
        message: environmentTakesPromotionsMessage(entry, later),
        ...(named && { firstProjectId: later.firstProjectId as unknown as string }),
        position: later.position,
      },
      requestId,
    ),
  );
}
