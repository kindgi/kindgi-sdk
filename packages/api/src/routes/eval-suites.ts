// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';
import { routePath } from 'hono/route';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import {
  EVAL_KINDS,
  type EvalKind,
  type EvalSuite,
  type EvalSuiteRecord,
  type EvalSuiteRegistryBinding,
} from '../eval-suite-binding.js';
import {
  type ItemCheck,
  type ItemRights,
  type ItemServing,
  itemMiddleware,
  itemPathCheck,
  shownLatest,
} from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { includeRetiredOf } from './include-retired.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';
import { UUID_RE } from './uuid-param.js';

/**
 * Evaluation-suite resource routes — part of the admin control plane.
 * Full versioned CRUD, mirroring
 * `policies` 1:1.
 *
 * The registry is intentionally kind-neutral: the wire body carries a
 * `kind` discriminator and a `spec` object whose shape is dictated by
 * that kind. The route validates the top-level shape (id, tenantId,
 * semver version, kind ∈ closed enum, spec is an object) — deeper
 * validation of `spec` is the runtime consumer's responsibility (they
 * own the semantics for their kind).
 *
 * Registry-only. Actual eval runs (dispatch to eval-judge adapters,
 * HITL delegation for `human-review`, custom-handler dispatch via
 * handler-as-code) live in the eval-runs surface — the same
 * discipline that split policies (registry) from policy enforcement
 * (consumer).
 */
export function evalSuitesRouter(
  binding: EvalSuiteRegistryBinding,
  authorizer?: Authorizer,
  /** Rights on a suite more than one project serves (`item-rights.ts`); absent → the suite's own. */
  itemRights?: ItemRights,
  /** With no authorizer: which projects serve it, for `?projectId=` (`itemServingOf`). */
  itemServing?: ItemServing,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Authorization — same checks as the agents routes.
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
    // A suite more than one project serves is checked on those projects
    // instead (`item-rights.ts`).
    // '/:suiteId/*' matches '/:suiteId' too: this one gate decides both, once.
    r.use(
      '/:suiteId/*',
      itemMiddleware({
        authorizer,
        rights: itemRights,
        kind: 'eval_suite',
        id: (c) => c.req.param('suiteId') ?? '',
        async today(c) {
          const suiteId = c.req.param('suiteId') ?? '';
          // Starting a run (`POST /:suiteId/runs`, exactly) doesn't change the
          // suite, and the start route checks it all itself: `execute` on the
          // suite, `write` on the project and `execute` on the agent or flow.
          const under = c.req.path.split('/').slice(routePath(c).split('/').length - 1);
          if (c.req.method === 'POST' && under.length === 1 && under[0] === 'runs') {
            return undefined;
          }
          // A test set built from judgments under a suite id never registered
          // (no head row) has no suite to check yet: the build checks `admin`
          // on the project it names, the project the new suite belongs to. A
          // tombstoned suite keeps its head row, so it's checked as an existing
          // one. Anything else under a suite id, and a build under an existing
          // suite, checks the suite.
          if (
            c.req.method === 'POST' &&
            c.req.path.endsWith('/versions/from-judgments') &&
            !(await binding.headExists({ tenantId: c.get('tenantId') as TenantId, suiteId }))
          ) {
            return undefined;
          }
          return c.req.method === 'GET' ? 'read' : 'admin';
        },
        check: suiteCheck,
        versionNotFound: suiteVersionNotFound,
      }),
    );
  }

  /** A version of the suite that isn't there, or that the caller can't see: one 404 for both. */
  function suiteVersionNotFound(c: Context<AppEnv>, version: string): Response {
    const suiteId = c.req.param('suiteId') ?? '';
    c.status(statusFor('eval-suite-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'eval-suite-not-found',
          message: `No eval suite "${suiteId}" at version "${version}"`,
          suiteId,
          version,
        },
        c.get('requestId'),
      ),
    );
  }

  /**
   * The rows of a list the caller may read (T243 A), as `GET …/:id` asks:
   * a suite more than one project serves, at its newest version they see.
   */
  async function readable(
    c: Context<AppEnv>,
    tenantId: TenantId,
    rows: readonly EvalSuiteRecord[],
  ): Promise<readonly EvalSuiteRecord[]> {
    if (authorizer === undefined) return rows;
    if (itemRights === undefined) {
      return authorizer.filterByCan(c, 'read', rows, (a) =>
        ref('eval_suite', a.id as unknown as string),
      );
    }
    return itemRights.filterItems(c, 'eval_suite', rows, {
      idOf: (a) => a.id as unknown as string,
      todayRef: (a) => ref('eval_suite', a.id as unknown as string),
      versions: {
        versionOf: (a) => a.version as unknown as string,
        getVersion: (id, version) => binding.getVersion({ tenantId, suiteId: id, version }),
      },
      retired: (a) => a.unregisteredAt !== undefined,
    });
  }

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const kindRaw = c.req.query('kind');
    const nameRaw = c.req.query('name');

    if (kindRaw !== undefined && kindRaw.length > 0 && !isEvalKind(kindRaw)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Unknown eval kind "${kindRaw}". Expected one of: ${EVAL_KINDS.join(', ')}.`,
          },
          requestId,
        ),
      );
    }

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
      ...(kindRaw !== undefined && kindRaw.length > 0 && { evalKind: kindRaw as EvalKind }),
      ...(nameRaw !== undefined && nameRaw.length > 0 && { nameFilter: nameRaw }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
      ...includeRetiredOf(c),
    });
    const visible = await readable(c, tenantId, page.data);
    return c.json({
      data: visible.map(serializeEvalSuite),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:suiteId (latest version) ----------
  r.get('/:suiteId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');

    const latest = await binding.get({ tenantId, suiteId });
    if (latest === null) {
      // 410 gone (head exists, no active version) vs 404 not-found.
      const exists = await binding.headExists({ tenantId, suiteId });
      if (exists) {
        c.status(statusFor('eval-suite-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'eval-suite-gone',
              message: `Eval suite "${suiteId}" has no active versions; reinstate a tombstoned version or publish a new one`,
              suiteId,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite registered with id "${suiteId}"`,
            suiteId,
          },
          requestId,
        ),
      );
    }
    // The newest version the caller can see, or the newest in
    // `?projectId=` (`item-rights.ts`).
    const shown = await shownLatest(c, itemRights ?? itemServing, 'eval_suite', suiteId, latest, {
      versionOf: (s) => s.version as unknown as string,
      projectOf: (s) => s.projectId as unknown as string | undefined,
      getVersion: (version) => binding.getVersion({ tenantId, suiteId, version }),
    });
    if (shown.kind === 'bad-input') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: shown.message }, requestId));
    }
    if (shown.kind === 'not-found') {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite registered with id "${suiteId}"`,
            suiteId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeEvalSuite(shown.row));
  });

  // ---------- GET /:suiteId/versions (list versions) ----------
  r.get('/:suiteId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const refused = refuseUnissuedCursor(c, binding, 'versions', cursorRaw);
    if (refused !== undefined) return refused;
    // `?includeTombstoned=true` lists unregistered versions too, each
    // with `unregisteredAt`. Anything else → active versions only.
    const includeTombstoned = c.req.query('includeTombstoned') === 'true';

    // Confirm the id exists at all: an empty versions list from the
    // binding is ambiguous (no versions vs. unknown id). A retired test set
    // (every version unregistered) still has its head row, so it answers
    // 200, with its versions under `includeTombstoned`; a never-registered
    // id is 404. As flows, tools and policies do.
    const exists = await binding.headExists({ tenantId, suiteId });
    if (!exists) {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite registered with id "${suiteId}"`,
            suiteId,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      suiteId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(includeTombstoned && { includeTombstoned: true }),
    });
    // A suite more than one project serves: only the versions the caller
    // can see (`item-rights.ts`).
    const projects = await itemRights?.multi(c, 'eval_suite', suiteId);
    const data =
      itemRights === undefined || projects === undefined
        ? page.data
        : await itemRights.visibleVersions(
            c,
            'eval_suite',
            suiteId,
            projects,
            page.data,
            (s) => s.version as unknown as string,
          );
    return c.json({
      data: data.map(serializeEvalSuite),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:suiteId/versions/:version ----------
  r.get('/:suiteId/versions/:version', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const version = c.req.param('version');

    const suite = await binding.getVersion({ tenantId, suiteId, version });
    if (suite === null) return suiteVersionNotFound(c, version);
    return c.json(serializeEvalSuite(suite));
  });

  // ---------- POST / (publish) ----------
  r.post('/', async (c) => {
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
    // eval-suite-shape validator on purpose — the caller controls what
    // project the suite lands in; the suite definition itself is
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

    // Validate the wire shape. Deeper `spec` validation is the runtime
    // consumer's responsibility (each eval kind has its own contract);
    // the registry only guarantees the top-level shape. `projectId`
    // is stripped before validation — the suite definition itself is
    // project-agnostic.
    const { projectId: _pid, ...bodyWithoutProjectId } = bodyObj;
    const validation = validateEvalSuite(bodyWithoutProjectId, tenantId);
    if (validation.kind === 'err') {
      c.status(statusFor('validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: validation.error.message,
            issues: validation.error.issues as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await binding.publish({
      tenantId,
      projectId,
      suite: validation.value,
      enqueueTuples: (suiteId) =>
        tuplesForCreate({ kind: 'eval_suite', id: suiteId, tenantId, projectId }, creatorUserId),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('eval-suite-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-already-registered',
            message: `Eval suite "${outcome.suiteId}" version "${outcome.version}" is already registered`,
            suiteId: outcome.suiteId,
            version: outcome.version,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-mismatch') {
      return projectMismatch(c, 'eval-suite', outcome.suiteId, outcome.projectId);
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
    c.status(201);
    return c.json({ suiteId: outcome.suiteId, version: outcome.version });
  });

  // ---------- POST /:suiteId/versions/:version/unregister ----------
  r.post('/:suiteId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const version = c.req.param('version');

    const outcome = await binding.unregister({ tenantId, suiteId, version });
    if (!outcome.unregistered) {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite "${suiteId}" at version "${version}" to unregister`,
            suiteId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({ suiteId, version, unregistered: true });
  });

  // ---------- POST /:suiteId/versions/:version/reinstate ----------
  r.post('/:suiteId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const version = c.req.param('version');
    const outcome = await binding.reinstateVersion({ tenantId, suiteId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite "${suiteId}" at version "${version}" to reinstate`,
            suiteId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({
      suiteId: outcome.suiteId,
      version: outcome.version,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  return r;
}

/**
 * What a route under a suite more than one project serves asks
 * (`itemPathCheck`), but for a test set built from judgments: `admin` in
 * the one project whose judged runs it takes, where the new version is
 * made, as an eval run follows its own project (rule 3). A body naming
 * none of the suite's projects is checked on every project, and the
 * route answers what's wrong with it.
 */
async function suiteCheck(c: Context<AppEnv>, projects: readonly ProjectId[]): Promise<ItemCheck> {
  if (c.req.method === 'POST' && c.req.path.endsWith('/versions/from-judgments')) {
    const body = (await c.req.json().catch(() => null)) as { projectId?: unknown } | null;
    const projectId = body?.projectId;
    if (
      typeof projectId === 'string' &&
      UUID_RE.test(projectId) &&
      projects.includes(projectId as ProjectId)
    ) {
      return { rule: 'on', action: 'admin', projectId };
    }
  }
  return itemPathCheck(c);
}

function serializeEvalSuite(s: EvalSuiteRecord): Record<string, unknown> {
  return {
    id: s.id,
    tenantId: s.tenantId as unknown as string,
    ...(s.projectId !== undefined && { projectId: s.projectId as unknown as string }),
    version: s.version,
    kind: s.kind,
    ...(s.description !== undefined && { description: s.description }),
    spec: s.spec,
    ...(s.unregisteredAt !== undefined && { unregisteredAt: s.unregisteredAt }),
  };
}

function isEvalKind(value: string): value is EvalKind {
  return (EVAL_KINDS as readonly string[]).includes(value);
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Wire-shape validator for `EvalSuite`. Confirms the top-level fields
 * the registry needs (id, tenantId, semver version, kind ∈ closed enum,
 * spec is an object). Deeper validation of `spec` is the runtime
 * consumer's responsibility per eval kind.
 */
function validateEvalSuite(
  body: unknown,
  tenantId: TenantId,
):
  | { kind: 'ok'; value: EvalSuite }
  | {
      kind: 'err';
      error: { message: string; issues: readonly { path: string; message: string }[] };
    } {
  const b = body as Partial<EvalSuite> & Record<string, unknown>;
  const issues: { path: string; message: string }[] = [];

  if (typeof b.id !== 'string' || b.id.length === 0) {
    issues.push({ path: 'id', message: 'evalSuite.id must be a non-empty string' });
  }
  if (typeof b.version !== 'string' || !SEMVER_RE.test(b.version)) {
    issues.push({
      path: 'version',
      message: 'evalSuite.version must be a semver string (e.g. "1.0.0")',
    });
  }
  if (typeof b.kind !== 'string' || !isEvalKind(b.kind)) {
    issues.push({
      path: 'kind',
      message: `evalSuite.kind must be one of: ${EVAL_KINDS.join(', ')}`,
    });
  }
  // tenantId is optional on the wire — when present, it must match the
  // caller's tenant (server-derived from the token). Cross-tenant
  // publish is not allowed.
  if (b.tenantId !== undefined) {
    if (
      typeof b.tenantId !== 'string' ||
      (b.tenantId as unknown as string) !== (tenantId as unknown as string)
    ) {
      issues.push({
        path: 'tenantId',
        message: 'evalSuite.tenantId must match the caller tenant',
      });
    }
  }
  if (
    b.spec === undefined ||
    b.spec === null ||
    typeof b.spec !== 'object' ||
    Array.isArray(b.spec)
  ) {
    issues.push({ path: 'spec', message: 'evalSuite.spec must be an object' });
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    issues.push({ path: 'description', message: 'evalSuite.description must be a string' });
  }

  if (issues.length > 0) {
    return {
      kind: 'err',
      error: { message: issues[0]?.message ?? 'evalSuite validation failed', issues },
    };
  }

  const value: EvalSuite = {
    id: b.id as string,
    tenantId,
    version: b.version as string,
    kind: b.kind as EvalKind,
    ...(typeof b.description === 'string' && { description: b.description }),
    spec: b.spec as Readonly<Record<string, unknown>>,
  };
  return { kind: 'ok', value };
}
