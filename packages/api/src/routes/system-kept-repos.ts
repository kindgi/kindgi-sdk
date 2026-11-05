// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type SystemTenantDirectory,
  requireSystemScope,
  systemReadAcrossTenants,
  withSystemTenantContext,
} from '../middleware/system.js';
import type { AppEnv } from '../types.js';
import { UUID_RE } from './uuid-param.js';

/** The most ids one rulings request takes. */
export const KEPT_REPO_RULINGS_MAX = 500;

/** The most open erasures one page answers, and how many when `limit` isn't given. */
export const KEPT_REPO_ERASURES_PAGE_MAX = 500;

/** A project's kept repo, by its tenant and project ids. */
export interface KeptRepoId {
  readonly tenantId: TenantId;
  readonly projectId: string;
}

/** Why a kept repo is purged. */
export const KEPT_REPO_PURGE_REASONS = [
  'erasure',
  'retention',
  'tenant-purged',
  'no-record',
] as const;
export type KeptRepoPurgeReason = (typeof KEPT_REPO_PURGE_REASONS)[number];

/**
 * What the store does with a kept repo it holds:
 * - `keep` it, with its mark: `none` (its project is live), `deleted` or
 *   `moved` (its project was deleted, or its repo moved to GitHub, at
 *   `since`, within the kept window), or `held` (it's due a purge, and
 *   something holds it; `since` is when its window began);
 * - or `purge` it, for `reason`.
 */
export type KeptRepoRuling =
  | { readonly ruling: 'keep'; readonly mark: 'none' }
  | {
      readonly ruling: 'keep';
      readonly mark: 'deleted' | 'moved' | 'held';
      readonly since: string;
    }
  | {
      readonly ruling: 'purge';
      readonly reason: KeptRepoPurgeReason;
      /**
       * `true` when the runtime holds this ruling's own report already (for
       * `erasure`, the repo's erasure done; for `retention`, its purge when
       * its kept window ended), so a store that finds the repo purged has
       * nothing to sweep or report. Never for `tenant-purged` or
       * `no-record`.
       */
      readonly recorded?: true;
    };

/** A kept repo's state, as the runtime records it. */
export const KEPT_REPO_STATES = [
  'live',
  'deleted',
  'moved',
  'held',
  'erasure-requested',
  'purged',
] as const;
export type KeptRepoStateName = (typeof KEPT_REPO_STATES)[number];

export interface KeptRepoState {
  readonly state: KeptRepoStateName;
  /** When it came to be in that state. */
  readonly since: string;
}

/** An unfinished erasure of a project's kept repo. */
export interface KeptRepoOpenErasure extends KeptRepoId {
  /** When it was requested. */
  readonly since: string;
}

/** What an erasure request of a kept repo came to. */
export type KeptRepoErasureOutcome =
  /** The erasure is requested (now, or by an earlier request still unfinished), since `since`. */
  | { readonly kind: 'requested'; readonly since: string }
  /**
   * The repo's erasure is done already, at `since`: nothing was requested.
   * A repo purged when its kept window ended is requested still, so its
   * erasure is recorded too.
   */
  | { readonly kind: 'purged'; readonly since: string }
  /** Something holds the repo (a legal hold): nothing was requested. */
  | { readonly kind: 'refused'; readonly message: string }
  /** The runtime has no record of the project: nothing was requested. */
  | { readonly kind: 'not-found' }
  /** The runtime isn't keeping repos for projects without a GitHub repo now: nothing was requested. */
  | { readonly kind: 'off' };

/**
 * Where a runtime keeps its record of projects' kept repos: the repos a
 * store keeps for the runtime's projects without a GitHub repo. The
 * runtime rules on each one and records each purge; the store does the
 * purge.
 */
export interface SystemKeptReposBinding {
  /** One ruling for each id, in the order given. Ids may span tenants, and repeat. */
  rulings(ids: readonly KeptRepoId[]): Promise<readonly KeptRepoRuling[]>;
  /**
   * Record the store's purge of a kept repo, done for `reason`. A second
   * report of one changes nothing. `tenant` is the tenant's state in the
   * directory: a purged tenant's, or an unknown one's (a restore older
   * than the tenant), records the report alone, in the system tenant.
   * It throws when the purge can't be recorded (its record unwritten).
   */
  reportPurged(input: {
    readonly tenantId: TenantId;
    readonly projectId: string;
    readonly reason: KeptRepoPurgeReason;
    readonly tenant: 'served' | 'purged' | 'unknown';
    /** The reporting system key's id. */
    readonly reportedBy: string;
  }): Promise<void>;
  /** A kept repo's state; `undefined` for a project the runtime has no record of. */
  state(tenantId: TenantId, projectId: string): Promise<KeptRepoState | undefined>;
  /**
   * Request the erasure of a project's kept repo. A second request while
   * one is unfinished answers that one. `not-found` exactly when `state`
   * answers `undefined`.
   */
  requestErasure(input: {
    readonly tenantId: TenantId;
    readonly projectId: string;
    /** The requesting system key's id. */
    readonly requestedBy: string;
  }): Promise<KeptRepoErasureOutcome>;
  /**
   * The unfinished erasures across tenants, ordered by tenant id then
   * project id; `undefined` for a cursor this runtime didn't issue.
   */
  openErasures(page: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<
    { readonly data: readonly KeptRepoOpenErasure[]; readonly nextCursor?: string } | undefined
  >;
}

/**
 * Kept repos, under `/v1/system`: the repos a store keeps for the
 * runtime's projects without a GitHub repo. The store's reconcile calls
 * three routes, with `system:kept-repos`:
 *
 * - **`POST /kept-repos/rulings`** `{ ids: [{ tenantId, projectId }] }`, up
 *   to 500: one ruling for each, in order, `{ rulings: [{ tenantId,
 *   projectId, ruling, mark?, since?, reason?, recorded? }] }`. An id not
 *   in form, or
 *   more than 500, refuses the whole request (`400 bad-input`).
 * - **`GET /kept-repos/erasures`** `?limit=&cursor=`: the unfinished
 *   erasures of kept repos, `{ data: [{ tenantId, projectId, since }],
 *   nextCursor? }`, by tenant id then project id. The store purges each,
 *   whether or not it holds the repo, and reports it.
 * - **`POST /tenants/:tenantId/projects/:projectId/kept-repo/purged`**
 *   `{ reason }`: the store's purge is done. `204`, whatever the tenant's
 *   state: a purged tenant's report, or one for a tenant the runtime
 *   doesn't know, is recorded in the system tenant alone. So this route
 *   looks the tenant up itself rather than refusing it as
 *   `withSystemTenantContext` would.
 *
 * Two act in one tenant, with `system:kept-repos:erase`, through
 * `withSystemTenantContext` (an unknown or purged tenant is `404
 * tenant-not-found`):
 *
 * - **`GET /tenants/:tenantId/projects/:projectId/kept-repo`**: the repo's
 *   state, `{ state, since }`; `404 project-not-found` for a project the
 *   runtime has no record of.
 * - **`POST /tenants/:tenantId/projects/:projectId/kept-repo/erasure`**:
 *   requests the repo's erasure. `202 { state: 'erasure-requested', since }`
 *   for a new request or the unfinished one; `200 { state: 'purged', since }`
 *   when its erasure is done already; `404 project-not-found` exactly
 *   when the state read answers it; `409 legal-hold` when something holds
 *   it; `501 kept-repos-off` when the runtime isn't keeping repos for
 *   projects without a GitHub repo now. A refusal requests nothing.
 */
export function systemKeptReposRouter(options: {
  readonly keptRepos: SystemKeptReposBinding;
  readonly directory: SystemTenantDirectory;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { keptRepos, directory, authorizer } = options;
  const r = new Hono<AppEnv>();

  r.post('/kept-repos/rulings', async (c) => {
    const denied = systemReadAcrossTenants(c, 'system:kept-repos', authorizer);
    if (denied !== undefined) return denied;
    const body = await readJsonObject(c);
    if (typeof body === 'string') return badInput(c, body);
    const ids = parseIds(body);
    if (typeof ids === 'string') return badInput(c, ids);
    const rulings = await keptRepos.rulings(ids);
    if (rulings.length !== ids.length) {
      throw new Error(`kept repos: ${rulings.length} rulings for ${ids.length} ids`);
    }
    return c.json({
      rulings: ids.map((id, i) => ({
        tenantId: id.tenantId as unknown as string,
        projectId: id.projectId,
        ...(rulings[i] as KeptRepoRuling),
      })),
    });
  });

  r.get('/kept-repos/erasures', async (c) => {
    const denied = systemReadAcrossTenants(c, 'system:kept-repos', authorizer);
    if (denied !== undefined) return denied;
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? KEPT_REPO_ERASURES_PAGE_MAX : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > KEPT_REPO_ERASURES_PAGE_MAX) {
      return badInput(
        c,
        `\`limit\` must be a whole number from 1 to ${KEPT_REPO_ERASURES_PAGE_MAX}`,
      );
    }
    const cursor = c.req.query('cursor');
    const page = await keptRepos.openErasures({ limit, ...(cursor !== undefined && { cursor }) });
    if (page === undefined) {
      return badInput(c, "`cursor` isn't one this runtime gave: start again without it");
    }
    return c.json({
      data: page.data.map((e) => ({
        tenantId: e.tenantId as unknown as string,
        projectId: e.projectId,
        since: e.since,
      })),
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
    });
  });

  r.post(
    '/tenants/:tenantId/projects/:projectId/kept-repo/purged',
    requireSystemScope('system:kept-repos', authorizer),
    async (c) => {
      const tenantId = c.req.param('tenantId');
      const projectId = c.req.param('projectId');
      if (!UUID_RE.test(tenantId) || !UUID_RE.test(projectId)) {
        return badInput(c, '`tenantId` and `projectId` must each be an id (a UUID)');
      }
      c.set('systemTargetTenant', tenantId.toLowerCase());
      const body = await readJsonObject(c);
      if (typeof body === 'string') return badInput(c, body);
      const reason = body.reason;
      if (
        typeof reason !== 'string' ||
        !(KEPT_REPO_PURGE_REASONS as readonly string[]).includes(reason) ||
        Object.keys(body).length !== 1
      ) {
        return badInput(
          c,
          `The body is \`{ "reason": … }\`, one of ${KEPT_REPO_PURGE_REASONS.join(', ')}`,
        );
      }
      const found = await directory.get(tenantId.toLowerCase() as TenantId);
      await keptRepos.reportPurged({
        tenantId: tenantId.toLowerCase() as TenantId,
        projectId: projectId.toLowerCase(),
        reason: reason as KeptRepoPurgeReason,
        tenant: found === null ? 'unknown' : found.state === 'purged' ? 'purged' : 'served',
        reportedBy: c.get('systemPrincipal')?.keyId ?? '',
      });
      return c.body(null, 204);
    },
  );

  r.get('/tenants/:tenantId/projects/:projectId/kept-repo', async (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      { scope: 'system:kept-repos:erase', ...(authorizer !== undefined && { authorizer }) },
      async (tenant) => {
        const projectId = c.req.param('projectId');
        const found = UUID_RE.test(projectId)
          ? await keptRepos.state(tenant.id, projectId.toLowerCase())
          : undefined;
        if (found === undefined) return projectNotFound(c, projectId);
        return c.json({ state: found.state, since: found.since });
      },
    ),
  );

  r.post('/tenants/:tenantId/projects/:projectId/kept-repo/erasure', async (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      { scope: 'system:kept-repos:erase', ...(authorizer !== undefined && { authorizer }) },
      async (tenant) => {
        const projectId = c.req.param('projectId');
        if (!UUID_RE.test(projectId)) return projectNotFound(c, projectId);
        const outcome = await keptRepos.requestErasure({
          tenantId: tenant.id,
          projectId: projectId.toLowerCase(),
          requestedBy: c.get('systemPrincipal')?.keyId ?? '',
        });
        switch (outcome.kind) {
          case 'off':
            return answer(
              c,
              'kept-repos-off',
              "This runtime isn't keeping repos for projects without a GitHub repo now, so it can't take an erasure for one.",
            );
          case 'not-found':
            return projectNotFound(c, projectId);
          case 'refused':
            return answer(c, 'legal-hold', outcome.message, { projectId: projectId.toLowerCase() });
          case 'purged':
            return c.json({ state: 'purged', since: outcome.since }, 200);
          case 'requested':
            return c.json({ state: 'erasure-requested', since: outcome.since }, 202);
        }
      },
    ),
  );

  return r;
}

/** The ids a rulings body names, or why it doesn't name them. */
function parseIds(body: Readonly<Record<string, unknown>>): KeptRepoId[] | string {
  const shape = `The body is \`{ "ids": [{ "tenantId": …, "projectId": … }] }\`, up to ${KEPT_REPO_RULINGS_MAX} ids`;
  const ids = body.ids;
  if (!Array.isArray(ids) || Object.keys(body).length !== 1) return shape;
  if (ids.length > KEPT_REPO_RULINGS_MAX) {
    return `At most ${KEPT_REPO_RULINGS_MAX} ids a request; this one has ${ids.length}`;
  }
  const out: KeptRepoId[] = [];
  for (const [i, id] of ids.entries()) {
    const v = id as Record<string, unknown> | null;
    if (
      v === null ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      Object.keys(v).length !== 2 ||
      typeof v.tenantId !== 'string' ||
      typeof v.projectId !== 'string' ||
      !UUID_RE.test(v.tenantId) ||
      !UUID_RE.test(v.projectId)
    ) {
      return `\`ids[${i}]\` isn't \`{ "tenantId": …, "projectId": … }\`, each an id (a UUID)`;
    }
    out.push({
      tenantId: v.tenantId.toLowerCase() as TenantId,
      projectId: v.projectId.toLowerCase(),
    });
  }
  return out;
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

function answer(
  c: Context<AppEnv>,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Response {
  c.status(statusFor(code) as never);
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(toWireError({ code, message, ...details }, c.get('requestId')));
}

function badInput(c: Context<AppEnv>, message: string): Response {
  return answer(c, 'bad-input', message);
}

function projectNotFound(c: Context<AppEnv>, projectId: string): Response {
  return answer(c, 'project-not-found', `No project with id "${projectId}".`, { projectId });
}
