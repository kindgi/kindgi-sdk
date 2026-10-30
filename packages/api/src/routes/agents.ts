// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import {
  type Agent,
  type AgentId,
  type DefineAgentSpec,
  defineAgent,
  pinsDigest,
} from '@kindgi/agents';
import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, LiveScope, ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from '../agent-binding.js';
import { resolveAgentPins, toolPinLookup } from '../agent-pins.js';
import type { BlockRegistryBinding } from '../block-binding.js';
import {
  type DeriveAgentVersionOutcome,
  type PinSwaps,
  deriveAgentVersion,
  nextFreeAgentVersion,
} from '../derive-agent-version.js';
import {
  environmentTakesPromotionsResponse,
  firstEnvironmentOf,
  laterEnvironment,
} from '../environment-entry.js';
import type { EnvironmentOrderBinding } from '../environment-orders-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { IdentityDirectoryBinding } from '../identity-directory-binding.js';
import {
  type ItemCheck,
  type ItemRights,
  type ItemServing,
  itemMiddleware,
  itemPathCheck,
  liveChangeRefusal,
  readCheck,
  shownLatest,
  underItem,
} from '../item-rights.js';
import type { AgentReleaseBindings } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import type { PinnedVersionBinding } from '../pinned-version-binding.js';
import {
  type ReferenceScopeBinding,
  agentReferences,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import { refuseReadOnly, refuseWritesWhenReadOnly } from '../registry-read-only.js';
import type { ToolRegistryBinding } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { type WhatRunsInProject, whatRunsByProject } from '../what-runs.js';
import {
  type AgentReleaseGateDeps,
  actorOf,
  isLiveSet,
  isLiveUndo,
  isPromotionCheck,
  isPromotionRequest,
  isPromotionWrite,
  mountAgentReleaseRoutes,
  seenVersions,
} from './agent-releases.js';
import { isTestSetPath } from './agent-test-set.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Agents resource routes.
 *
 * Registry storage is caller-plugged via `AgentRegistryBinding`. The
 * API package does not own persistence — the binding implementation
 * supplies the store (tests wrap the in-memory `AgentRegistry` from
 * `@kindgi/agents`).
 *
 * Publish is data-as-code: the body is a full `DefineAgentSpec` (the
 * same value `defineAgent(...)` accepts).
 *
 * With `toolRegistry`, a published version is pinned: each tool range
 * resolves once, at publish, to the exact version every run of that
 * version uses (`pins`, see `resolveAgentPins`), and a range that
 * matches no published version refuses the publish. Without it,
 * versions carry no pins and resolve their ranges per run. With
 * `pinnedVersions` too, a tool pinned for the agent's project pins its
 * pinned version when that one is in the range.
 */
export function agentsRouter(
  binding: AgentRegistryBinding,
  authorizer?: Authorizer,
  toolRegistry?: ToolRegistryBinding,
  blockRegistry?: BlockRegistryBinding,
  /** Live versions per scope and promotions (evals step 4); absent → those routes aren't mounted. */
  releases?: AgentReleaseBindings,
  /** What a promotion's gate reads besides the releases (evals step 4b). */
  gateDeps?: AgentReleaseGateDeps,
  /** What the deployment can do for an agent's turns, for publish warnings. */
  capabilities: AgentPublishCapabilities = {},
  /** What an agent's project may reference (`reference-scope.ts`); absent → as named. */
  referenceScope?: ReferenceScopeBinding,
  /**
   * The tenant's environment orders: a publish, or a derived version, aimed
   * at a later environment is refused (`environment-entry.ts`). Absent: no
   * project is a later environment.
   */
  environmentOrders?: Pick<EnvironmentOrderBinding, 'orderOf'>,
  /** Rights on an agent more than one project serves (`item-rights.ts`); absent → the agent's own. */
  itemRights?: ItemRights,
  /** With no authorizer: which projects serve it, for `?projectId=` (`itemServingOf`). */
  itemServing?: ItemServing,
  /** The tools' pinned versions, read when a version is pinned; absent → each range's newest. */
  pinnedVersions?: PinnedVersionBinding,
  /** Who an owner is (`owner.name`), and that a new owner is a person of the tenant; absent → the id alone. */
  identityDirectory?: Pick<IdentityDirectoryBinding, 'getUser'>,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Every schema a publish compiles counts against its tenant's budget.
  const publishCompiles = publishCompilesMiddleware();
  // A read-only registry (under `kindgi dev`, the pack's files) refuses
  // every write before anything else runs. One that takes Improve's
  // candidates lets a promotion through (it writes the candidate where
  // the definitions come from), and refuses an undo with its own reason.
  const refuseWrites = refuseWritesWhenReadOnly(() => binding.readOnly);
  r.use('*', async (c, next) => {
    // An agent's test set is the corrections store's, not the registry's.
    if (isTestSetPath(c.req.path)) return next();
    const candidates = binding.readOnly?.takesCandidates;
    if (candidates !== undefined) {
      const { method, path } = c.req;
      if (isPromotionRequest(method, path) || isPromotionCheck(method, path)) return next();
      if (isLiveUndo(method, path)) return refuseReadOnly(c, { reason: candidates.undoReason });
    }
    return refuseWrites(c, next);
  });

  // Authorization — check the resource directly (ref('agent', businessId));
  // permissions cascade from the parent project because the
  // AgentRegistryBinding's `publish` writes the `agent:X#parent@project:Y`
  // tuple via the enqueueTuples hook (see AgentPublishInput contract).
  //
  //   POST /                                         → admin on body.projectId
  //   GET /:agentId, GET /:agentId/versions[/…]      → read on the agent
  //   POST /:agentId/versions                        → publish on the agent (derive)
  //   POST /:agentId/versions/:version/unregister    → admin on the agent
  //   POST /:agentId/versions/:version/reinstate     → admin on the agent
  //   PUT /:agentId/owner                            → admin on the agent
  //   POST /:agentId/promotions, /live/rollback, /live/unpin → promote on the agent
  //   POST /:agentId/promotions/check                → read on the agent (changes nothing)
  //   GET /:agentId/live, /live-versions, /promotions[/…]    → read on the agent
  //   GET /:agentId/projects                         → read on the agent; names
  //                                                    the projects the caller reads
  //   GET / (list)                                   → tenant-scoped fetch;
  //                                                    with a project scope
  //                                                    (?scopeKind=project&scopeId=),
  //                                                    require read on that project
  if (authorizer !== undefined) {
    r.use('/', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', async () => {
        try {
          const body = await c.req.json();
          const pid =
            body !== null && typeof body === 'object'
              ? (body as Record<string, unknown>).projectId
              : undefined;
          if (typeof pid === 'string' && pid.length > 0) return ref('project', pid);
        } catch {
          // POST handler validates + returns 400
        }
        return ref('tenant', tenantId as unknown as string);
      });
      return mw(c, next);
    });
    r.use('/', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      // A project filter needs read on that project. Parse it as the
      // handler does (`?scopeKind=project&scopeId=`).
      const s = parseScopeParams((n) => c.req.query(n), {
        tenantId: c.get('tenantId') as TenantId,
      });
      if (s.kind !== 'ok' || s.scope?.kind !== 'project') return next();
      const scopeProjectId = s.scope.projectId as unknown as string;
      const mw = authorizer.authorize('read', () => ref('project', scopeProjectId));
      return mw(c, next);
    });
    // Changing what's live is its own permission (`promote`, granted to the
    // agent's admins), checked as a deployment's promotion that makes what
    // it moved live checks it (`liveChangeRefusal`).
    r.use('/:agentId/*', async (c, next) => {
      if (!isPromotionWrite(c.req.method, c.req.path)) return next();
      const refused = await liveChangeRefusal(c, {
        authorizer,
        rights: itemRights,
        agentId: c.req.param('agentId') ?? '',
        scope: await bodyScope(c),
        setsLive: isLiveSet(c.req.method, c.req.path),
      });
      return refused ?? next();
    });
    // An agent more than one project serves is checked on those projects
    // instead (`item-rights.ts`, `agentCheck`).
    // '/:agentId/*' matches '/:agentId' too: this one gate decides both, once.
    r.use(
      '/:agentId/*',
      itemMiddleware({
        authorizer,
        rights: itemRights,
        kind: 'agent',
        id: (c) => c.req.param('agentId') ?? '',
        // Deriving a version (POST …/versions) is `publish` on the agent;
        // unregister and reinstate are `admin`. A change to what's live is
        // checked above, and the test set's routes check for themselves
        // (`agent-test-set.ts`).
        today: (c) =>
          isTestSetPath(c.req.path)
            ? undefined
            : c.req.method === 'GET' || isPromotionCheck(c.req.method, c.req.path)
              ? 'read'
              : isPromotionWrite(c.req.method, c.req.path)
                ? undefined
                : c.req.path.endsWith('/versions')
                  ? 'publish'
                  : 'admin',
        check: (c, projects) => agentCheck(c, projects),
        versionNotFound: agentVersionNotFound,
      }),
    );
  }

  /**
   * What a route under an agent more than one project serves asks
   * (`item-rights.ts`). Reads are rules 1 and 2. A derived version is
   * made in the first environment of the agent's order, so deriving is
   * `write` there (`deriveAgentVersion`). Unregistering or reinstating a
   * version is `admin` on each project it can run in; anything else, on
   * each of the agent's. A change to what's live is `liveChangeRefusal`'s.
   */
  async function agentCheck(
    c: Context<AppEnv>,
    projects: readonly ProjectId[],
  ): Promise<ItemCheck> {
    const under = underItem(c);
    if (c.req.method === 'GET') return readCheck(under);
    if (isPromotionCheck(c.req.method, c.req.path)) return { rule: 'read' };
    if (under.length === 1 && under[0] === 'versions') {
      const home = projects[0] as ProjectId;
      const tenantId = c.get('tenantId') as TenantId;
      const madeIn = (await firstEnvironmentOf(environmentOrders, tenantId, home)) ?? home;
      return { rule: 'on', action: 'write', projectId: madeIn as unknown as string };
    }
    return itemPathCheck(c);
  }

  /** A version of the agent that isn't there, or that the caller can't see: one 404 for both. */
  function agentVersionNotFound(c: Context<AppEnv>, version: string): Response {
    const agentId = c.req.param('agentId') ?? '';
    c.status(statusFor('agent-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'agent-not-found',
          message: `No agent "${agentId}" at version "${version}"`,
          agentId,
          version,
        },
        c.get('requestId'),
      ),
    );
  }

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const nameRaw = c.req.query('name');
    // `?includeRetired=true` lists retired items too (no active version),
    // each as its highest version with `unregisteredAt`. Anything else →
    // items with an active version only (the default).
    const includeRetired = c.req.query('includeRetired') === 'true';

    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(nameRaw !== undefined && nameRaw.length > 0 && { nameFilter: nameRaw }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
      ...(includeRetired && { includeRetired: true }),
    });
    // Only what the caller may read (T243 A), as `GET …/:id` asks; an
    // agent more than one project serves at its newest version the caller
    // can see (`item-rights.ts`).
    const visible =
      authorizer === undefined
        ? page.data
        : itemRights === undefined
          ? await authorizer.filterByCan(c, 'read', page.data, (a) =>
              ref('agent', a.id as unknown as string),
            )
          : await itemRights.filterItems(c, 'agent', page.data, {
              idOf: (a) => a.id as unknown as string,
              todayRef: (a) => ref('agent', a.id as unknown as string),
              versions: {
                versionOf: (a) => a.version as unknown as string,
                getVersion: (id, version) =>
                  binding.getVersion({
                    tenantId,
                    agentId: id as AgentId,
                    version: version as Semver,
                  }),
              },
              retired: (a) => a.unregisteredAt !== undefined,
            });
    return c.json({
      data: visible.map(serializeAgent),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:agentId (highest version) ----------
  r.get('/:agentId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;

    const highest = await binding.get({ tenantId, agentId });
    if (highest === null) {
      // Distinguish 410 gone (identity exists — head row present, no
      // active version) from 404 not-found (never registered).
      // Retirement is a derived state (no active
      // versions); the head row is the identity marker.
      const exists = await binding.headExists({ tenantId, agentId });
      if (exists) {
        c.status(statusFor('agent-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'agent-gone',
              message: `Agent "${agentId as unknown as string}" has no active versions; reinstate a tombstoned version or publish a new one`,
              agentId: agentId as unknown as string,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent registered with id "${agentId as unknown as string}"`,
            agentId: agentId as unknown as string,
          },
          requestId,
        ),
      );
    }
    // The newest version the caller can see, or the newest in
    // `?projectId=` (`item-rights.ts`).
    const shown = await shownLatest(
      c,
      itemRights ?? itemServing,
      'agent',
      agentId as unknown as string,
      highest,
      {
        versionOf: (a) => a.version as unknown as string,
        projectOf: (a) => a.projectId as unknown as string | undefined,
        getVersion: (version) =>
          binding.getVersion({ tenantId, agentId, version: version as Semver }),
      },
    );
    if (shown.kind === 'bad-input') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: shown.message }, requestId));
    }
    if (shown.kind === 'not-found') {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent registered with id "${agentId as unknown as string}"`,
            agentId: agentId as unknown as string,
          },
          requestId,
        ),
      );
    }
    // The owner is the agent's, not a version's: it's read off the head
    // record, whichever version is shown.
    return c.json({ ...serializeAgent(shown.row), ...(await ownerField(tenantId, highest)) });
  });

  /** `owner: { userId, name? }`, the name when the directory has one for the person. */
  async function ownerField(
    tenantId: TenantId,
    a: AgentVersionRecord,
  ): Promise<{ owner?: { userId: string; name?: string } }> {
    if (a.owner === undefined) return {};
    const user = await identityDirectory?.getUser({ tenantId, userId: a.owner.userId });
    const name = user?.displayName;
    return {
      owner: {
        userId: a.owner.userId as unknown as string,
        ...(name !== undefined && name.length > 0 && { name }),
      },
    };
  }

  // ---------- GET /:agentId/projects (the projects it runs in) ----------
  // Its own project first, then each other project a version of it can run
  // in (`ItemProjectsBinding.projectsOf`, unregistered versions included): a
  // change to the agent reaches each. Only the projects the caller reads are
  // named, its own included. With no binding, its own project alone. With
  // pins and Latest wired, each says what runs there (`whatRunsByProject`),
  // and the answer gives the highest version, which numbers the next one.
  // A version the caller can't see is left out (`seenVersions`), as
  // `GET …/live` leaves it out.
  r.get('/:agentId/projects', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const served = itemRights ?? itemServing;
    const projects =
      served !== undefined
        ? await served.projects(c, 'agent', agentId as unknown as string)
        : await ownProject(tenantId, agentId);
    if (projects === undefined) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent registered with id "${agentId as unknown as string}"`,
            agentId: agentId as unknown as string,
          },
          c.get('requestId'),
        ),
      );
    }
    const named =
      authorizer === undefined
        ? projects
        : await authorizer.filterByCan(c, 'read', projects, (p) =>
            ref('project', p as unknown as string),
          );
    if (releases === undefined) {
      return c.json({ data: named.map((projectId) => ({ projectId })) });
    }
    const [rows, highest] = await Promise.all([
      whatRunsByProject(releases, { tenantId, agentId }, named),
      binding.get({ tenantId, agentId }),
    ]);
    const visible = await seenVersions(
      itemRights,
      c,
      agentId,
      [
        ...rows.flatMap((row) => [
          ...(row.runs === null ? [] : [row.runs.version]),
          ...row.segments.map((s) => s.version),
        ]),
        ...(highest === null ? [] : [highest.version]),
      ].map(String),
    );
    const shown = (version: Semver) => visible.has(version as unknown as string);
    const data = await Promise.all(rows.map((row) => projectRow(tenantId, releases, row, shown)));
    return c.json({
      data,
      ...(highest !== null && shown(highest.version) && { highest: { version: highest.version } }),
    });
  });

  /** One project's row: what runs there and why, and the segment pins inside it. */
  async function projectRow(
    tenantId: TenantId,
    releases: AgentReleaseBindings,
    { projectId, runs, pin, segments }: WhatRunsInProject,
    shown: (version: Semver) => boolean,
  ) {
    const seen = segments.filter((s) => shown(s.version));
    const bySegment =
      seen.length === 0
        ? {}
        : {
            segments: seen.map((s) => ({
              path: s.path.map(({ key, value }) => ({ key, value })),
              version: s.version,
            })),
          };
    if (runs === null || !shown(runs.version)) return { projectId, ...bySegment };
    if (runs.follows === 'latest') {
      const { version, since, deploymentId, by } = runs;
      return {
        projectId,
        follows: 'latest',
        runs: {
          version,
          ...(since !== undefined && { since }),
          ...(deploymentId !== undefined && { deploymentId }),
          ...(by !== undefined && { by }),
        },
        ...bySegment,
      };
    }
    // A pin: when it was set, and who asked for the promotion that set it.
    const promotion =
      pin === undefined ? null : await releases.promotions.get(tenantId, pin.promotionId);
    return {
      projectId,
      follows: 'pin',
      runs: {
        version: runs.version,
        liveScope: liveScopeToWire(runs.liveScope),
        ...(pin !== undefined && { since: pin.setAt, promotionId: pin.promotionId }),
        ...(promotion !== null && { by: promotion.requestedBy }),
      },
      ...bySegment,
    };
  }

  /**
   * An agent's own project with no item-projects binding: every version
   * reads the same one (`AgentVersionRecord.projectId`), a retired agent's
   * too. `undefined`: no such agent; empty: the store records none.
   */
  async function ownProject(
    tenantId: TenantId,
    agentId: AgentId,
  ): Promise<readonly ProjectId[] | undefined> {
    if (!(await binding.headExists({ tenantId, agentId }))) return undefined;
    const page = await binding.listVersions({
      tenantId,
      agentId,
      limit: 1,
      includeTombstoned: true,
    });
    const projectId = page.data[0]?.projectId;
    return projectId !== undefined ? [projectId] : [];
  }

  // ---------- GET /:agentId/versions (list versions) ----------
  r.get('/:agentId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const refused = refuseUnissuedCursor(c, binding, 'versions', cursorRaw);
    if (refused !== undefined) return refused;
    // `?includeTombstoned=true` lists unregistered versions too, each
    // with `unregisteredAt`. Anything else → active versions only.
    const includeTombstoned = c.req.query('includeTombstoned') === 'true';

    // Confirm the id exists at all: an empty versions list from the
    // binding is ambiguous (no versions vs. unknown id). A retired agent
    // (every version unregistered) still has its head row, so it answers
    // 200, with its versions under `includeTombstoned`; a never-registered
    // id is 404. As flows, tools and policies do.
    const exists = await binding.headExists({ tenantId, agentId });
    if (!exists) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent registered with id "${agentId as unknown as string}"`,
            agentId: agentId as unknown as string,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      agentId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(includeTombstoned && { includeTombstoned: true }),
    });
    // An agent more than one project serves: only the versions the caller
    // can see (`item-rights.ts`).
    const projects = await itemRights?.multi(c, 'agent', agentId as unknown as string);
    const data =
      itemRights === undefined || projects === undefined
        ? page.data
        : await itemRights.visibleVersions(
            c,
            'agent',
            agentId as unknown as string,
            projects,
            page.data,
            (a) => a.version as unknown as string,
          );
    return c.json({
      data: data.map(serializeAgent),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:agentId/versions/:version ----------
  r.get('/:agentId/versions/:version', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const version = c.req.param('version') as Semver;

    const agent = await binding.getVersion({ tenantId, agentId, version });
    if (agent === null) return agentVersionNotFound(c, version as unknown as string);
    return c.json(serializeAgent(agent));
  });

  // ---------- POST / (publish) ----------
  r.post('/', publishCompiles, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }

    // `projectId` is REQUIRED on the POST body.
    // Missing / empty / non-string → 400 bad-input. Absent from the
    // agent-shape validator on purpose — the caller controls what
    // project the agent lands in; the agent definition itself is
    // project-agnostic.
    const bodyObj = body as Record<string, unknown>;
    const projectIdRaw = bodyObj.projectId;
    if (typeof projectIdRaw !== 'string' || projectIdRaw.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`projectId` is required' }, requestId),
      );
    }
    const projectId = projectIdRaw as ProjectId;
    const later = await laterEnvironment(environmentOrders, tenantId, projectId);
    if (later !== undefined) {
      return environmentTakesPromotionsResponse(
        c,
        requestId,
        authorizer,
        { kind: 'publish', noun: 'agent' },
        later,
      );
    }

    // Validate via defineAgent — same rules as the runtime primitive,
    // so an agent published through the API is byte-identical to one
    // constructed in-process. `defineAgent` returns a Result rather
    // than throwing. `projectId` is stripped from the spec passed to
    // `defineAgent` — the agent definition itself is project-agnostic
    // (the runtime primitive doesn't know about projects).
    const { projectId: _pid, ...specWithoutProjectId } = bodyObj;
    const defined = defineAgent(specWithoutProjectId as unknown as DefineAgentSpec);
    if (defined.kind === 'err') {
      c.status(statusFor('invalid-agent') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: defined.error.message,
            issues: defined.error.issues as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }

    // Every tool, guardrail and data block it names must be one its
    // project reaches (`reference-scope.ts`), asked before pinning.
    const outOfScope = await referencesOutOfScope(
      referenceScope,
      tenantId,
      projectId,
      agentReferences(defined.value),
    );
    if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);

    // Pin the version: every tool range resolves now, once, to the
    // version its runs use. A range nothing satisfies refuses the
    // publish rather than store a partly pinned version.
    let agent: Agent = defined.value;
    if (toolRegistry !== undefined) {
      const resolved = await resolveAgentPins(
        toolRegistry,
        tenantId,
        defined.value,
        blockRegistry,
        undefined,
        toolPinLookup(pinnedVersions, projectId),
      );
      if (resolved.kind === 'unpinnable') {
        c.status(statusFor('invalid-agent') as never);
        return c.json(
          toWireError(
            {
              code: 'validation-failed',
              message: `Agent "${defined.value.id as unknown as string}" uses tool or data-block versions it can't pin (${resolved.issues.length} issue${resolved.issues.length === 1 ? '' : 's'})`,
              issues: resolved.issues as unknown as Record<string, unknown>[],
            },
            requestId,
          ),
        );
      }
      agent = { ...agent, pins: resolved.pins, pinsDigest: pinsDigest(resolved.pins) };
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await binding.publish({
      tenantId,
      projectId,
      agent,
      // A full publish is the person's own version: Latest in its project at once.
      madeFor: 'latest',
      latestBy: actorOf(c),
      // Write the authorization tuples in the same transaction as the
      // registry row. The binding calls this with the business
      // `agentId`.
      enqueueTuples: (agentId) =>
        tuplesForCreate(
          { kind: 'agent', id: agentId as AgentId, tenantId, projectId },
          creatorUserId,
        ),
    });
    if (outcome.kind === 'already-registered') {
      return alreadyRegistered(c, binding, tenantId, outcome.agentId, outcome.version);
    }
    if (outcome.kind === 'project-mismatch') {
      return projectMismatch(c, 'agent', outcome.agentId as unknown as string, outcome.projectId);
    }
    if (outcome.kind === 'project-not-found') {
      // Caller supplied a `projectId` that does not resolve within
      // this tenant. Distinct signal from `already-registered` so the
      // client can prompt for a valid project rather than assume the
      // version was already used. Answered as `400 bad-input`; the
      // caller learns from the message which field was invalid.
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`projectId\` "${outcome.projectId as unknown as string}" does not resolve to a project in this tenant`,
          },
          requestId,
        ),
      );
    }
    const warnings = publishWarnings(defined.value, capabilities);
    c.status(201);
    return c.json({
      agentId: outcome.agentId as unknown as string,
      version: outcome.version as unknown as string,
      ...(warnings.length > 0 && { warnings }),
    });
  });

  // ---------- POST /:agentId/versions (derive a version) ----------
  r.post('/:agentId/versions', publishCompiles, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const body = await jsonObject(c);
    if (body === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: 'Request body must be a JSON object' },
          requestId,
        ),
      );
    }
    const parsed = deriveBody(body);
    if (typeof parsed === 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed }, requestId));
    }
    const principal = c.get('principal') as Principal | undefined;
    const userId = principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await deriveAgentVersion({
      agents: binding,
      blocks: blockRegistry,
      tenantId,
      agentId,
      from: parsed.from,
      swaps: parsed.pins,
      ...(parsed.label !== undefined && { label: parsed.label }),
      ...(userId !== undefined && { by: `user:${userId as unknown as string}` }),
      ...(parsed.projectId !== undefined && { projectId: parsed.projectId }),
      ...(environmentOrders !== undefined && { orders: environmentOrders }),
      tuplesFor: (projectId) => (id) =>
        tuplesForCreate({ kind: 'agent', id: id as AgentId, tenantId, projectId }, userId),
    });
    return derived(c, agentId, parsed.from, outcome, authorizer);
  });

  // ---------- POST /:agentId/versions/:version/unregister ----------
  r.post('/:agentId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const version = c.req.param('version') as Semver;

    const outcome = await binding.unregister({ tenantId, agentId, version });
    if (!outcome.unregistered && outcome.live !== undefined && outcome.live.length > 0) {
      c.status(statusFor('agent-version-live') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-version-live',
            message: `${agentId as unknown as string} ${version as unknown as string} is live in ${
              outcome.live.length === 1 ? 'a scope' : `${outcome.live.length} scopes`
            }: roll back, unpin, or promote another version there first, then unregister it.`,
            agentId: agentId as unknown as string,
            version: version as unknown as string,
            scopes: outcome.live.map(liveScopeToWire),
          },
          requestId,
        ),
      );
    }
    if (!outcome.unregistered) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent "${agentId as unknown as string}" at version "${version as unknown as string}" to unregister`,
            agentId: agentId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      agentId: agentId as unknown as string,
      version: version as unknown as string,
      unregistered: true,
    });
  });

  // ---------- POST /:agentId/versions/:version/reinstate ----------
  // Un-tombstone a specific version — clears the version's tombstone
  // and recomputes the agent's latest version across active
  // versions. Restores the manifest bytes verbatim (semver hygiene:
  // reinstate never mutates). Idempotent: reinstating an active
  // version returns `wasTombstoned: false`.
  r.post('/:agentId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const version = c.req.param('version') as Semver;

    // Reinstating makes a version's references live again, so they're
    // asked as at publish (`reference-scope.ts`): a version from before
    // the check, naming what its project doesn't reach, stays retired.
    const retired = await binding.getVersion({ tenantId, agentId, version });
    if (retired?.unregisteredAt !== undefined && retired.projectId !== undefined) {
      const outOfScope = await referencesOutOfScope(
        referenceScope,
        tenantId,
        retired.projectId,
        agentReferences(retired),
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }

    const outcome = await binding.reinstateVersion({ tenantId, agentId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent "${agentId as unknown as string}" at version "${version as unknown as string}" to reinstate`,
            agentId: agentId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      agentId: outcome.agentId as unknown as string,
      version: outcome.version as unknown as string,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  // ---------- PUT /:agentId/owner ----------
  // The person the agent's corrections go to when they need its owner. One
  // per agent; setting it again replaces the one before. With a directory,
  // the person must be one of the tenant's.
  r.put('/:agentId/owner', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;

    if (binding.setOwner === undefined) {
      c.status(statusFor('agent-owner-unsupported') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-owner-unsupported',
            message: "This runtime's agent store doesn't keep an owner.",
          },
          requestId,
        ),
      );
    }
    const userId = await ownerBody(c);
    if (userId === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: 'The body is { "userId": "<the person\'s id>" }.' },
          requestId,
        ),
      );
    }
    const user = await identityDirectory?.getUser({ tenantId, userId });
    if (identityDirectory !== undefined && (user === null || user?.unregisteredAt !== undefined)) {
      c.status(statusFor('identity-user-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'identity-user-not-found',
            message: `No person "${userId as unknown as string}" in this tenant to own the agent`,
            userId: userId as unknown as string,
          },
          requestId,
        ),
      );
    }
    const principal = c.get('principal') as Principal | undefined;
    const outcome = await binding.setOwner({
      tenantId,
      agentId,
      userId,
      ...(principal !== undefined && { setBy: principal.actor.id }),
    });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent registered with id "${agentId as unknown as string}"`,
            agentId: agentId as unknown as string,
          },
          requestId,
        ),
      );
    }
    const name = user?.displayName;
    return c.json({
      agentId: agentId as unknown as string,
      owner: {
        userId: userId as unknown as string,
        ...(name !== undefined && name.length > 0 && { name }),
      },
    });
  });

  if (releases !== undefined) {
    mountAgentReleaseRoutes(r, binding, releases, gateDeps, referenceScope, itemRights);
  }

  return r;
}

/** The owner body's `userId`: `{ "userId": "…" }` and nothing else, or undefined. */
async function ownerBody(c: Context<AppEnv>): Promise<UserId | undefined> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  const { userId } = fields;
  if (Object.keys(fields).some((k) => k !== 'userId')) return undefined;
  return typeof userId === 'string' && userId.length > 0 ? (userId as UserId) : undefined;
}

/** The scope a promotion, rollback or unpin body names; `undefined` when it names none (the route's 400). */
async function bodyScope(c: Context<AppEnv>): Promise<LiveScope | undefined> {
  try {
    const body: unknown = await c.req.json();
    if (body === null || typeof body !== 'object') return undefined;
    const scope = parseLiveScopeBody((body as Record<string, unknown>).scope);
    return scope.kind === 'ok' ? scope.scope : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The 409 for a publish whose number is taken. Versions never change, so
 * it names the next free one (an expert's derived version may hold it).
 */
async function alreadyRegistered(
  c: Context<AppEnv>,
  binding: AgentRegistryBinding,
  tenantId: TenantId,
  agentId: AgentId,
  version: Semver,
) {
  const next = await nextFreeAgentVersion(binding, tenantId, agentId, version as unknown as string);
  const suggestion = next === undefined ? '' : `; publish it as ${next}, the next free version`;
  c.status(statusFor('agent-already-registered') as never);
  return c.json(
    toWireError(
      {
        code: 'agent-already-registered',
        message: `Agent "${agentId as unknown as string}" version "${version as unknown as string}" is already registered, and versions never change${suggestion}`,
        agentId: agentId as unknown as string,
        version: version as unknown as string,
        ...(next !== undefined && { nextFreeVersion: next }),
      },
      c.get('requestId'),
    ),
  );
}

/** The request body as an object; undefined when it isn't JSON or isn't an object. */
async function jsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface DeriveBody {
  readonly from: string;
  readonly pins: PinSwaps;
  readonly label?: string;
  readonly projectId?: ProjectId;
}

/** `{ from, pins: { prompts?, settings? }, label?, projectId? }`, or what's wrong with it. */
function deriveBody(b: Record<string, unknown>): DeriveBody | string {
  if (typeof b.from !== 'string' || b.from.length === 0) {
    return '`from` (the version to derive from) is required';
  }
  const pins = pinSwapsOf(b.pins);
  if (typeof pins === 'string') return pins;
  for (const key of ['label', 'projectId'] as const) {
    if (b[key] !== undefined && typeof b[key] !== 'string') return `\`${key}\` must be a string`;
  }
  return {
    from: b.from,
    pins,
    ...(typeof b.label === 'string' && { label: b.label }),
    ...(typeof b.projectId === 'string' && { projectId: b.projectId as ProjectId }),
  };
}

/** `pins`: prompt and settings pins only, each block id → exact version; or what's wrong with it. */
function pinSwapsOf(pins: unknown): PinSwaps | string {
  if (pins === null || typeof pins !== 'object' || Array.isArray(pins)) {
    return '`pins` must be { prompts?, settings? }';
  }
  for (const [kind, map] of Object.entries(pins)) {
    if (kind !== 'prompts' && kind !== 'settings') {
      return `\`pins.${kind}\` can't be swapped: only prompt and settings pins (tool pins come from code)`;
    }
    if (!isStringMap(map)) return `\`pins.${kind}\` must map block ids to exact versions`;
  }
  return pins as PinSwaps;
}

function isStringMap(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/** The response to a derive. */
function derived(
  c: Context<AppEnv>,
  agentId: AgentId,
  from: string,
  outcome: DeriveAgentVersionOutcome,
  authorizer: Authorizer | undefined,
) {
  const requestId = c.get('requestId');
  const fail = (
    status: string,
    error: { code: string; message: string } & Record<string, unknown>,
  ) => {
    c.status(statusFor(status) as never);
    return c.json(toWireError(error, requestId));
  };
  switch (outcome.kind) {
    case 'ok':
      c.status(201);
      return c.json(serializeAgent(outcome.agent));
    case 'reused':
      return c.json(serializeAgent(outcome.agent));
    case 'not-found':
      return fail('agent-not-found', {
        code: 'agent-not-found',
        message: `No agent "${agentId as unknown as string}" at version "${from}"`,
      });
    case 'unpinned':
      return fail('validation-failed', {
        code: 'validation-failed',
        message: `Agent "${agentId as unknown as string}" version ${from} has no pins (it was published before pins); publish it again to pin it, then derive`,
      });
    case 'invalid':
      return fail('validation-failed', {
        code: 'validation-failed',
        message: `Can't derive from version ${from} (${outcome.issues.length} issue${outcome.issues.length === 1 ? '' : 's'})`,
        issues: outcome.issues as unknown as Record<string, unknown>[],
      });
    case 'no-project':
      return fail('bad-input', {
        code: 'bad-input',
        message: "`projectId` is required: this runtime doesn't record the version's project",
      });
    case 'project-not-found':
      return fail('bad-input', {
        code: 'bad-input',
        message: `\`projectId\` "${outcome.projectId as unknown as string}" does not resolve to a project in this tenant`,
      });
    case 'project-mismatch':
      return projectMismatch(c, 'agent', agentId as unknown as string, outcome.projectId, 'derive');
    case 'environment-takes-promotions':
      return environmentTakesPromotionsResponse(
        c,
        requestId,
        authorizer,
        { kind: 'derive' },
        outcome.later,
      );
  }
}

/** What the deployment can do for an agent's turns, for publish warnings. */
export interface AgentPublishCapabilities {
  /** Whether memory can search by meaning (embeddings are on). Absent: unknown, no warning. */
  readonly semanticSearch?: boolean;
  /** Whether agents can remember (`memory.remember`). Absent: unknown, no warning. */
  readonly remember?: boolean;
  /** Whether agent turns can recall earlier conversations. Absent: unknown, no warning. */
  readonly conversationRecall?: boolean;
}

/**
 * What a published agent should know about this deployment before its
 * first turn: an intent that searches by meaning on a runtime without
 * embeddings fails its turns (`semantic`) or searches by keyword only
 * (`both`); an agent that remembers on a runtime that can't store what
 * it remembers gets "not remembered" from every call.
 */
function publishWarnings(
  agent: Agent,
  capabilities: AgentPublishCapabilities,
): { readonly code: string; readonly message: string }[] {
  return [
    ...(capabilities.semanticSearch === false ? semanticWarnings(agent) : []),
    ...(capabilities.remember === false && agent.memory?.remember !== undefined
      ? [
          {
            code: 'remember-unavailable',
            message:
              'The agent declares memory.remember, and this runtime cannot store agent memories: each remember call answers that nothing was remembered.',
          },
        ]
      : []),
    ...recallWarnings(agent, capabilities),
  ];
}

/**
 * Intents over conversations: `same-segment` and `same-project` quote other
 * people's conversations (always said); on a runtime that can't recall,
 * every such intent recalls nothing.
 */
function recallWarnings(
  agent: Agent,
  capabilities: AgentPublishCapabilities,
): { readonly code: string; readonly message: string }[] {
  const answers = agent.retrieval.findIndex(
    (intent) => intent.source === 'conversations' && intent.roles?.includes('agent') === true,
  );
  const answersWarning =
    answers >= 0 && capabilities.conversationRecall !== false
      ? [
          {
            code: 'recall-agent-answers',
            message: `Retrieval intent ${answers} recalls the agent's own earlier answers: they can carry its earlier mistakes. They are quoted as "earlier answer by the agent, not verified"; recall only the people's own words (the default) to leave them out.`,
          },
        ]
      : [];
  return [...answersWarning, ...perIntentRecallWarnings(agent, capabilities)];
}

function perIntentRecallWarnings(
  agent: Agent,
  capabilities: AgentPublishCapabilities,
): { readonly code: string; readonly message: string }[] {
  return agent.retrieval.flatMap((intent, i) => {
    if (intent.source !== 'conversations') return [];
    if (capabilities.conversationRecall === false) {
      return [
        {
          code: 'recall-unavailable',
          message: `Retrieval intent ${i} recalls earlier conversations, and this runtime can't: it recalls nothing, and each turn's journal says so (no-recall).`,
        },
      ];
    }
    if (intent.scope === 'same-segment' || intent.scope === 'same-project') {
      const where = intent.scope === 'same-segment' ? "the run's segment" : "the run's project";
      return [
        {
          code: 'recall-other-people',
          message: `Retrieval intent ${i} recalls conversations in ${where}, whoever had them: this agent can quote other users' conversations in ${where}. Their messages are marked as another person's, without saying whose.`,
        },
      ];
    }
    return [];
  });
}

function semanticWarnings(agent: Agent): { readonly code: string; readonly message: string }[] {
  return agent.retrieval.flatMap((intent, i) => {
    if (intent.mode === 'semantic') {
      return [
        {
          code: 'semantic-unavailable',
          message: `Retrieval intent ${i} searches by meaning (mode "semantic"), and this runtime has no embeddings: its turns fail with semantic-unavailable until an operator turns them on (KINDGI_MEMORY_EMBEDDINGS).`,
        },
      ];
    }
    if (intent.mode === 'both') {
      return [
        {
          code: 'semantic-unavailable',
          message: `Retrieval intent ${i} (mode "both") runs only its keyword search: this runtime has no embeddings (KINDGI_MEMORY_EMBEDDINGS).`,
        },
      ];
    }
    return [];
  });
}

/**
 * A conversation policy as an answer carries it: without
 * `autoCloseAfterInactiveSeconds`, which an agent stored before the setting
 * was taken out may still have. The stored agent is left as it is.
 */
function answeredPolicy(
  policy: NonNullable<AgentVersionRecord['conversationPolicy']>,
): NonNullable<AgentVersionRecord['conversationPolicy']> {
  const { autoCloseAfterInactiveSeconds: _gone, ...rest } = policy as typeof policy & {
    readonly autoCloseAfterInactiveSeconds?: unknown;
  };
  return rest;
}

function serializeAgent(a: AgentVersionRecord): Record<string, unknown> {
  return {
    id: a.id as unknown as string,
    version: a.version as unknown as string,
    ...(a.projectId !== undefined && { projectId: a.projectId as unknown as string }),
    name: a.name,
    ...(a.description !== undefined && { description: a.description }),
    instructions: a.instructions,
    ...(a.parameters !== undefined && { parameters: a.parameters }),
    ...(a.settings !== undefined && { settings: a.settings }),
    ...(a.modelSettings !== undefined && { modelSettings: a.modelSettings }),
    capabilities: a.capabilities,
    tools: a.tools,
    retrieval: a.retrieval,
    ...(a.memory !== undefined && { memory: a.memory }),
    guardrails: a.guardrails,
    ...(a.conversationPolicy !== undefined && {
      conversationPolicy: answeredPolicy(a.conversationPolicy),
    }),
    ...(a.budget !== undefined && { budget: a.budget }),
    ...(a.tags !== undefined && { tags: a.tags }),
    ...(a.output !== undefined && { output: a.output }),
    ...(a.toolErrors !== undefined && { toolErrors: a.toolErrors }),
    ...(a.preferredProvider !== undefined && { preferredProvider: a.preferredProvider }),
    ...(a.preferredModel !== undefined && { preferredModel: a.preferredModel }),
    ...(a.parallelToolCalls !== undefined && { parallelToolCalls: a.parallelToolCalls }),
    ...(a.pins !== undefined && { pins: a.pins }),
    ...(a.pinsDigest !== undefined && { pinsDigest: a.pinsDigest }),
    ...(a.derivedFrom !== undefined && { derivedFrom: a.derivedFrom }),
    ...(a.unregisteredAt !== undefined && { unregisteredAt: a.unregisteredAt }),
  };
}
