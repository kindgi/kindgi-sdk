// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { holdsSystemScope } from '../system.js';
import type { AppEnv } from '../types.js';
import { hasCapability, refused } from './denied.js';
import { parseTimeInput } from './time-input.js';

/**
 * Where the deployment's license key stands, as its startup banner says
 * it: what the console shows from 30 days before the key expires, with the
 * same way to the next key. Never the key itself.
 */
export interface LicenseStatus {
  /** `development`: `KINDGI_DEV`, no key needed (the key's fields are absent). */
  readonly mode: 'development' | 'licensed';
  /** Whose key: the name the banner prints. */
  readonly name?: string;
  readonly use?: 'production' | 'non-production';
  /** ISO 8601. */
  readonly expiresAt?: string;
  /** ISO 8601: until when the runtime starts with this key (`expiresAt` plus the 14-day grace). */
  readonly startsUntil?: string;
  /** Whole days until it expires; negative once it has. */
  readonly daysLeft?: number;
  /**
   * `expiring`: 30 days or fewer left; `grace`: expired, and the runtime
   * still starts with it; `expired`: past the grace too, so this server
   * runs on but won't start with it again.
   */
  readonly standing?: 'valid' | 'expiring' | 'grace' | 'expired';
  /**
   * Which of the banner's two ways to the next key applies: `command`, a
   * key this deployment renews itself (`kindgi license renew`); `contact`,
   * a key Kindgi issued (write to Kindgi).
   */
  readonly renewBy?: 'command' | 'contact';
  /**
   * How to get the next key, as the banner says it, with where the
   * deployment keeps its key and renewer; present from 30 days before it
   * expires. Only the deployment's own token reads it.
   */
  readonly renew?: string;
  /**
   * This build's own expiry, before Kindgi 1.0: a preview release stops
   * starting 90 days after it was released, in every mode, unless a
   * production key exempts it. Absent when nothing expires: a 1.0 or later
   * release, a build from source, or a production key.
   */
  readonly preview?: LicensePreview;
}

/** A preview build's expiry: when it was released, and the last day it starts. */
export interface LicensePreview {
  /** This build's release, `0.1.8`. */
  readonly version: string;
  /** ISO 8601: when it was released. */
  readonly releasedAt: string;
  /** ISO 8601: from then on, it no longer starts (`releasedAt` plus 90 days). */
  readonly expiresAt: string;
  /** Whole days until then; negative once it's passed. */
  readonly daysLeft: number;
  /**
   * `expiring`: 30 days or fewer left. `expired`: past it: this server runs
   * on, but won't start again; run a newer release.
   */
  readonly standing: 'valid' | 'expiring' | 'expired';
}

/**
 * How much the deployment was used in a period: what a free key's renewal
 * carries, so Kindgi can see production-like use. Counts only: no content,
 * names or ids.
 */
export interface LicenseUsage {
  /** ISO 8601: the period's start, as asked. */
  readonly since: string;
  /** ISO 8601: when they were counted. */
  readonly until: string;
  /** The runtime's version. */
  readonly runtimeVersion: string;
  /** Runs started in the period: not dry runs, replays, evals or child runs. */
  readonly runs: number;
  /**
   * Distinct people who started runs or decided approvals in the period,
   * counted in each tenant and summed: a person in two tenants counts twice.
   */
  readonly people: number;
  /** Projects in production at `until`; absent when the runtime has no such setting. */
  readonly projectsInProduction?: number;
}

/** The deployment's license status, worked out on each read (the days left move). */
export interface LicenseStatusBinding {
  status(): LicenseStatus | Promise<LicenseStatus>;
  /**
   * The deployment's use from `since` to `until`, across every tenant it
   * serves. Without it, `GET /v1/license/usage` isn't served (404).
   */
  usage?(period: { readonly since: Date; readonly until: Date }): Promise<LicenseUsage>;
  /**
   * The one tenant this deployment serves, or `null` when it serves none
   * or several: the deployment's own record of its tenants, never anything
   * a request carries. Asked on each read, so a second tenant closes the
   * tenant admins' view at once. Without it, only the deployment's own
   * token reads the license.
   */
  soleTenant?(): TenantId | null | Promise<TenantId | null>;
}

/** The refusal of a caller who may not read the license. */
export const LICENSE_OPERATOR_ONLY_MESSAGE =
  "The license is this deployment's: read it with the deployment's own token (KINDGI_API_TOKEN), or a system key holding system:license. A tenant admin reads its standing only where the deployment serves that one tenant.";

/** The refusal of a caller who may not read the deployment's use: every caller but its own token or a `system:license` key. */
export const LICENSE_USAGE_OPERATOR_ONLY_MESSAGE =
  "The deployment's use counts every tenant's: only the deployment's own token (KINDGI_API_TOKEN), or a system key holding system:license, reads it.";

/**
 * How far ahead of this runtime's clock `since` may be: a key issued
 * moments ago, by a clock a little ahead, asks from just after now.
 */
const USAGE_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * What the deployment's own token reads: every field of `LicenseStatus`,
 * named, so nothing a binding adds leaves outside the schema.
 */
export function operatorLicenseView(status: LicenseStatus): LicenseStatus {
  const { name, use, renew } = status;
  return {
    ...tenantAdminLicenseView(status),
    ...(name !== undefined && { name }),
    ...(use !== undefined && { use }),
    ...(renew !== undefined && { renew }),
  };
}

/** The usage the deployment's own token reads: every field named, so nothing a binding adds leaves. */
export function operatorUsageView(usage: LicenseUsage): LicenseUsage {
  const { since, until, runtimeVersion, runs, people, projectsInProduction } = usage;
  return {
    since,
    until,
    runtimeVersion,
    runs,
    people,
    ...(projectsInProduction !== undefined && { projectsInProduction }),
  };
}

/**
 * What a tenant admin reads: the countdown and which way to the next key,
 * and the build's own expiry, never whose key it is or where the
 * deployment keeps it. Named field by field, so a field added to
 * `LicenseStatus` stays the operator's until it's named here.
 */
export function tenantAdminLicenseView(status: LicenseStatus): LicenseStatus {
  const { mode, standing, expiresAt, startsUntil, daysLeft, renewBy, preview } = status;
  return {
    mode,
    ...(standing !== undefined && { standing }),
    ...(expiresAt !== undefined && { expiresAt }),
    ...(startsUntil !== undefined && { startsUntil }),
    ...(daysLeft !== undefined && { daysLeft }),
    ...(renewBy !== undefined && { renewBy }),
    ...(preview !== undefined && { preview: previewView(preview) }),
  };
}

/** A preview's fields, named, so nothing a binding adds leaves outside the schema. */
function previewView(preview: LicensePreview): LicensePreview {
  const { version, releasedAt, expiresAt, daysLeft, standing } = preview;
  return { version, releasedAt, expiresAt, daysLeft, standing };
}

/**
 * Whether the caller reads the license as the operator does: the
 * deployment's own token (`kindgi:system`), or a system key holding
 * `system:license` (the renewal job's). A tenant's key never gets that
 * scope.
 */
function readsAsOperator(c: Context<AppEnv>): boolean {
  if (hasCapability(c, 'kindgi:system')) return true;
  if (c.get('systemPrincipal') === undefined) return false;
  if (!holdsSystemScope(c.get('capabilities'), 'system:license')) return false;
  c.set('systemScopeUsed', 'system:license');
  return true;
}

/**
 * `GET /v1/license`: where the deployment's license key stands. The
 * license is the deployment's, not a tenant's:
 * - the deployment's own token (`kindgi:system`), or a system key holding
 *   `system:license`, reads all of it, `renew` with the secret references
 *   included;
 * - on a deployment serving exactly one tenant, that tenant's admins read
 *   the countdown (`tenantAdminLicenseView`), for the console's warning;
 * - anyone else, and every tenant of a deployment serving several, is
 *   refused (`403 license-operator-only`, recorded).
 *
 * With an authorizer, "tenant admin" is its `admin` on the tenant; without
 * one, any caller of the tenant, as for every tenant setting there.
 */
export function licenseRouter(
  binding: LicenseStatusBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', async (c) => {
    if (readsAsOperator(c)) {
      return c.json(operatorLicenseView(await binding.status()));
    }
    const tenantId = c.get('tenantId') as unknown as string;
    const sole = binding.soleTenant === undefined ? null : await binding.soleTenant();
    const onlyThisTenant = sole !== null && (sole as unknown as string) === tenantId;
    if (
      onlyThisTenant &&
      (authorizer === undefined || (await authorizer.can(c, 'admin', ref('tenant', tenantId))))
    ) {
      return c.json(tenantAdminLicenseView(await binding.status()));
    }
    return refused(c, authorizer, {
      action: 'read',
      resource: ref('tenant', tenantId),
      message: LICENSE_OPERATOR_ONLY_MESSAGE,
      // Who the caller is, in a tenant whose admins may read it; else what
      // the deployment allows.
      failing: onlyThisTenant ? 'actor' : 'scope',
      code: 'license-operator-only',
    });
  });
  const usage = binding.usage?.bind(binding);
  if (usage !== undefined) {
    // `GET /v1/license/usage`: the deployment's use since a time, for its
    // key's renewal (`kindgi license renew --runtime`). Only as the operator
    // reads the license (its own token, or a system key holding
    // `system:license`): it's every tenant's.
    r.get('/usage', async (c) => {
      if (!readsAsOperator(c)) {
        return refused(c, authorizer, {
          action: 'read',
          resource: ref('tenant', c.get('tenantId') as unknown as string),
          message: LICENSE_USAGE_OPERATOR_ONLY_MESSAGE,
          failing: 'scope',
          code: 'license-operator-only',
        });
      }
      const until = new Date();
      const since = parseTimeInput(c.req.query('since'));
      if (since === null || since.getTime() > until.getTime() + USAGE_CLOCK_SKEW_MS) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message:
                "`since` is required: an ISO 8601 time with a zone, no more than five minutes ahead of the runtime's clock.",
            },
            c.get('requestId'),
          ),
        );
      }
      // Ahead within the skew: an empty period, from now.
      const from = since.getTime() > until.getTime() ? until : since;
      return c.json(operatorUsageView(await usage({ since: from, until })));
    });
  }
  return r;
}
