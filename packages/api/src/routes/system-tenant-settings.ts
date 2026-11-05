// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { TenantLimits } from '@kindgi/platform';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { type SystemTenantDirectory, withSystemTenantContext } from '../middleware/system.js';
import type { AppEnv } from '../types.js';

/**
 * Where a runtime keeps the settings the control plane sets on a tenant:
 * whether it may put projects in production, its limits, and the plan it's
 * on. Each write answers what's stored now.
 */
export interface SystemTenantSettingsBinding {
  /** Allow the tenant production (`true`), or stop it (`false`). */
  setProductionAllowed(
    tenantId: TenantId,
    allowed: boolean,
  ): Promise<{ readonly productionAllowed: boolean }>;
  /** The tenant's limits as stored: one that isn't set is absent. */
  limits(tenantId: TenantId): Promise<TenantLimits>;
  /** Replace the tenant's limits with exactly these: one left out isn't set. */
  setLimits(tenantId: TenantId, limits: TenantLimits): Promise<TenantLimits>;
  /**
   * Optional. How much of each counted limit the tenant uses now, read
   * when its limits are: `GET …/limits` answers it as `inUse`.
   */
  inUse?(tenantId: TenantId): Promise<TenantLimitsInUse>;
  /**
   * Optional. The id of the plan the control plane put the tenant on, or
   * null while it hasn't: `GET …/limits` answers it as `plan`, and leaves
   * `plan` out without this.
   */
  plan?(tenantId: TenantId): Promise<string | null>;
  /**
   * Optional. Set the tenant's plan id, or clear it with null; a limit is
   * left as it is. Without it, `PUT …/plan` answers `501
   * tenant-plan-unsupported`.
   */
  setPlan?(tenantId: TenantId, plan: string | null): Promise<string | null>;
}

/**
 * How much of a limit that counts something the tenant uses now, whether
 * the limit is set or not. A limit can be lowered below it: nothing is
 * taken back, and the next one waits until the count is under the limit.
 */
export interface TenantLimitsInUse {
  /** The tenant's projects in production. */
  readonly projectsInProduction: number;
  /** The tenant's flows in production, each counted once. From a runtime that counts it. */
  readonly flowsInProduction?: number;
  /** The tenant's agents in production, each counted once. From a runtime that counts it. */
  readonly agentsInProduction?: number;
}

/**
 * A plan's id, as `PUT …/plan` takes it: a lowercase letter, then up to 31
 * lowercase letters, digits and hyphens.
 */
export const TENANT_PLAN_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The limits `PUT …/limits` takes: each a whole number from 1 to this. */
export const TENANT_LIMIT_MAX = 1_000_000;

/** Every limit a tenant can have, in the order the API documents them. */
export const TENANT_LIMIT_NAMES = [
  'apiRequestsPerMinute',
  'webhookReceivesPerMinute',
  'runsAtOnce',
  'runsPending',
  'toolCallsInFlight',
  'approvalsPending',
  'projectsInProduction',
  'flowsInProduction',
  'agentsInProduction',
] as const satisfies readonly (keyof TenantLimits)[];

/**
 * The control plane's settings on a tenant, under `/v1/system/tenants`:
 *
 * - **`PUT /:tenantId/production-allowed`** `{ allowed }`
 *   (`system:tenants:production`): whether the tenant may put projects in
 *   production, the switch the production gate reads. Answers
 *   `{ tenantId, productionAllowed }`.
 * - **`GET /:tenantId/limits`** (`system:tenants:limits`): the tenant's
 *   limits as stored, `{ tenantId, limits }`, the shape `PUT` takes, so a
 *   change of one is read, changed and put back. A limit not set is
 *   absent. With a runtime that counts it, `inUse` says how much of each
 *   counted limit the tenant uses now (`projectsInProduction`, and
 *   `flowsInProduction` and `agentsInProduction`). With a runtime that
 *   keeps it, `plan` is the tenant's plan id, or null while none is set.
 * - **`PUT /:tenantId/limits`** `{ apiRequestsPerMinute?, … }`
 *   (`system:tenants:limits`): replaces the tenant's limits with exactly
 *   these. A limit left out isn't set, and isn't enforced; the plan id is
 *   left as it is. Answers `{ tenantId, limits }`.
 * - **`PUT /:tenantId/plan`** `{ plan }` (`system:tenants:limits`): sets
 *   the tenant's plan id (`TENANT_PLAN_PATTERN`), or clears it with null.
 *   It's only shown: the limits are what's enforced. Answers
 *   `{ tenantId, plan }`, or `501 tenant-plan-unsupported` from a runtime
 *   that doesn't keep it.
 *
 * Each acts through `withSystemTenantContext`: an unknown or purged tenant
 * is `404 tenant-not-found`. A closing tenant is frozen, so the writes
 * answer it `409 tenant-closing`; its limits can still be read.
 */
export function systemTenantSettingsRouter(options: {
  readonly settings: SystemTenantSettingsBinding;
  readonly directory: SystemTenantDirectory;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { settings, directory, authorizer } = options;
  const r = new Hono<AppEnv>();

  r.put('/:tenantId/production-allowed', async (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      {
        scope: 'system:tenants:production',
        refuse: ['closing'],
        ...(authorizer !== undefined && { authorizer }),
      },
      async (tenant) => {
        const body = await readJsonObject(c);
        if (typeof body === 'string') return badInput(c, body);
        const allowed = body.allowed;
        if (typeof allowed !== 'boolean' || Object.keys(body).length !== 1) {
          return badInput(c, 'The body is `{ "allowed": true }` or `false`');
        }
        const stored = await settings.setProductionAllowed(tenant.id, allowed);
        return c.json({
          tenantId: tenant.id as unknown as string,
          productionAllowed: stored.productionAllowed,
        });
      },
    ),
  );

  r.get('/:tenantId/limits', async (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      { scope: 'system:tenants:limits', ...(authorizer !== undefined && { authorizer }) },
      async (tenant) => {
        const [limits, inUse, plan] = await Promise.all([
          settings.limits(tenant.id),
          settings.inUse?.(tenant.id),
          settings.plan?.(tenant.id),
        ]);
        return c.json({
          tenantId: tenant.id as unknown as string,
          limits,
          ...(inUse !== undefined && { inUse }),
          ...(plan !== undefined && { plan }),
        });
      },
    ),
  );

  r.put('/:tenantId/limits', async (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      {
        scope: 'system:tenants:limits',
        refuse: ['closing'],
        ...(authorizer !== undefined && { authorizer }),
      },
      async (tenant) => {
        const body = await readJsonObject(c);
        if (typeof body === 'string') return badInput(c, body);
        const limits = parseLimits(body);
        if (typeof limits === 'string') return badInput(c, limits);
        const stored = await settings.setLimits(tenant.id, limits);
        return c.json({ tenantId: tenant.id as unknown as string, limits: stored });
      },
    ),
  );

  r.put('/:tenantId/plan', async (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      {
        scope: 'system:tenants:limits',
        refuse: ['closing'],
        ...(authorizer !== undefined && { authorizer }),
      },
      async (tenant) => {
        if (settings.setPlan === undefined) {
          c.status(statusFor('tenant-plan-unsupported') as never);
          return c.json(
            toWireError(
              {
                code: 'tenant-plan-unsupported',
                message: "This runtime doesn't keep a tenant's plan.",
              },
              c.get('requestId'),
            ),
          );
        }
        const body = await readJsonObject(c);
        if (typeof body === 'string') return badInput(c, body);
        const plan = body.plan;
        const valid = plan === null || (typeof plan === 'string' && TENANT_PLAN_PATTERN.test(plan));
        if (!valid || Object.keys(body).length !== 1) {
          return badInput(
            c,
            'The body is `{ "plan": "<id>" }`, an id of a lowercase letter then up to 31 lowercase letters, digits and hyphens, or `{ "plan": null }` to clear it',
          );
        }
        const stored = await settings.setPlan(tenant.id, plan);
        return c.json({ tenantId: tenant.id as unknown as string, plan: stored });
      },
    ),
  );

  return r;
}

/** The limits a body names, or why it doesn't: only known names, each a whole number in range. */
function parseLimits(body: Readonly<Record<string, unknown>>): TenantLimits | string {
  const known = new Set<string>(TENANT_LIMIT_NAMES);
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return `Unknown limit ${unknown.map((k) => `\`${k}\``).join(', ')}: the limits are ${TENANT_LIMIT_NAMES.join(', ')}`;
  }
  const out: Record<string, number> = {};
  for (const name of TENANT_LIMIT_NAMES) {
    const value = body[name];
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > TENANT_LIMIT_MAX
    ) {
      return `\`${name}\` must be a whole number from 1 to ${TENANT_LIMIT_MAX}; leave it out to set none`;
    }
    out[name] = value;
  }
  return out as TenantLimits;
}

/** The body as an object, or why it isn't one. */
async function readJsonObject(
  c: Context<AppEnv>,
): Promise<Readonly<Record<string, unknown>> | string> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return 'Request body must be valid JSON';
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be an object';
  }
  return body as Readonly<Record<string, unknown>>;
}

function badInput(c: Context<AppEnv>, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, c.get('requestId')));
}
