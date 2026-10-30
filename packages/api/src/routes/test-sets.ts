// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';
import { routePath } from 'hono/route';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import {
  type ItemRights,
  type ItemServing,
  itemMiddleware,
  itemPathCheck,
  shownLatest,
} from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  LISTED_EVAL_KINDS,
  TEST_SET_KINDS,
  type TestSet,
  type TestSetKind,
  type TestSetRecord,
  type TestSetRegistryBinding,
  agentTestSetIdReserved,
  isAgentTestSetId,
} from '../test-set-binding.js';
import type { AppEnv } from '../types.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Evaluation-test set resource routes — part of the admin control plane.
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
 * Registry-only. Actual test runs (dispatch to eval-judge adapters,
 * HITL delegation for `human-review`, custom-handler dispatch via
 * handler-as-code) live in the test-runs surface — the same
 * discipline that split policies (registry) from policy enforcement
 * (consumer).
 */
export function testSetsRouter(
  binding: TestSetRegistryBinding,
  authorizer?: Authorizer,
  /** Rights on a test set more than one project serves (`item-rights.ts`); absent → the test set's own. */
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
    // A test set more than one project serves is checked on those projects
    // instead (`item-rights.ts`).
    // '/:testSetId/*' matches '/:testSetId' too: this one gate decides both, once.
    r.use(
      '/:testSetId/*',
      itemMiddleware({
        authorizer,
        rights: itemRights,
        kind: 'test_set',
        id: (c) => c.req.param('testSetId') ?? '',
        today(c) {
          // Starting a run (`POST /:testSetId/runs`, exactly) doesn't change the
          // test set, and the start route checks it all itself: `execute` on the
          // test set, `write` on the project and `execute` on the agent or flow.
          const under = c.req.path.split('/').slice(routePath(c).split('/').length - 1);
          if (c.req.method === 'POST' && under.length === 1 && under[0] === 'runs') {
            return undefined;
          }
          return c.req.method === 'GET' ? 'read' : 'admin';
        },
        check: itemPathCheck,
        versionNotFound: testSetVersionNotFound,
      }),
    );
  }

  /** A version of the test set that isn't there, or that the caller can't see: one 404 for both. */
  function testSetVersionNotFound(c: Context<AppEnv>, version: string): Response {
    const testSetId = c.req.param('testSetId') ?? '';
    c.status(statusFor('test-set-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'test-set-not-found',
          message: `No test set "${testSetId}" at version "${version}"`,
          testSetId,
          version,
        },
        c.get('requestId'),
      ),
    );
  }

  /**
   * The rows of a list the caller may read (T243 A), as `GET …/:id` asks:
   * a test set more than one project serves, at its newest version they see.
   */
  async function readable(
    c: Context<AppEnv>,
    tenantId: TenantId,
    rows: readonly TestSetRecord[],
  ): Promise<readonly TestSetRecord[]> {
    if (authorizer === undefined) return rows;
    if (itemRights === undefined) {
      return authorizer.filterByCan(c, 'read', rows, (a) =>
        ref('test_set', a.id as unknown as string),
      );
    }
    return itemRights.filterItems(c, 'test_set', rows, {
      idOf: (a) => a.id as unknown as string,
      todayRef: (a) => ref('test_set', a.id as unknown as string),
      versions: {
        versionOf: (a) => a.version as unknown as string,
        getVersion: (id, version) => binding.getVersion({ tenantId, testSetId: id, version }),
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
    // `?includeRetired=true` lists retired items too (no active version),
    // each as its highest version with `unregisteredAt`. Anything else →
    // items with an active version only (the default).
    const includeRetired = c.req.query('includeRetired') === 'true';

    const askedKind = kindRaw !== undefined && kindRaw.length > 0 ? kindRaw : undefined;
    if (askedKind !== undefined && !(TEST_SET_KINDS as readonly string[]).includes(askedKind)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Unknown eval kind "${askedKind}". Expected one of: ${TEST_SET_KINDS.join(', ')}.`,
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
      ...(askedKind !== undefined && { evalKind: askedKind as TestSetKind }),
      ...(nameRaw !== undefined && nameRaw.length > 0 && { nameFilter: nameRaw }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
      ...(includeRetired && { includeRetired: true }),
    });
    // Asked by kind, the list holds that kind, `corrections` too.
    const visible = await readable(
      c,
      tenantId,
      askedKind !== undefined
        ? page.data
        : page.data.filter((s) => LISTED_EVAL_KINDS.includes(s.kind)),
    );
    return c.json({
      data: visible.map(serializeTestSet),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:testSetId (latest version) ----------
  r.get('/:testSetId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testSetId = c.req.param('testSetId');

    const latest = await binding.get({ tenantId, testSetId });
    if (latest === null) {
      // 410 gone (head exists, no active version) vs 404 not-found.
      const exists = await binding.headExists({ tenantId, testSetId });
      if (exists) {
        c.status(statusFor('test-set-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'test-set-gone',
              message: `Test set "${testSetId}" has no active versions; reinstate a tombstoned version or publish a new one`,
              testSetId,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('test-set-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'test-set-not-found',
            message: `No test set registered with id "${testSetId}"`,
            testSetId,
          },
          requestId,
        ),
      );
    }
    // The newest version the caller can see, or the newest in
    // `?projectId=` (`item-rights.ts`).
    const shown = await shownLatest(c, itemRights ?? itemServing, 'test_set', testSetId, latest, {
      versionOf: (s) => s.version as unknown as string,
      projectOf: (s) => s.projectId as unknown as string | undefined,
      getVersion: (version) => binding.getVersion({ tenantId, testSetId, version }),
    });
    if (shown.kind === 'bad-input') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: shown.message }, requestId));
    }
    if (shown.kind === 'not-found') {
      c.status(statusFor('test-set-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'test-set-not-found',
            message: `No test set registered with id "${testSetId}"`,
            testSetId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeTestSet(shown.row));
  });

  // ---------- GET /:testSetId/versions (list versions) ----------
  r.get('/:testSetId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testSetId = c.req.param('testSetId');
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
    const exists = await binding.headExists({ tenantId, testSetId });
    if (!exists) {
      c.status(statusFor('test-set-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'test-set-not-found',
            message: `No test set registered with id "${testSetId}"`,
            testSetId,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      testSetId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(includeTombstoned && { includeTombstoned: true }),
    });
    // A test set more than one project serves: only the versions the caller
    // can see (`item-rights.ts`).
    const projects = await itemRights?.multi(c, 'test_set', testSetId);
    const data =
      itemRights === undefined || projects === undefined
        ? page.data
        : await itemRights.visibleVersions(
            c,
            'test_set',
            testSetId,
            projects,
            page.data,
            (s) => s.version as unknown as string,
          );
    return c.json({
      data: data.map(serializeTestSet),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:testSetId/versions/:version ----------
  r.get('/:testSetId/versions/:version', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const testSetId = c.req.param('testSetId');
    const version = c.req.param('version');

    const testSet = await binding.getVersion({ tenantId, testSetId, version });
    if (testSet === null) return testSetVersionNotFound(c, version);
    return c.json(serializeTestSet(testSet));
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
    // test-set-shape validator on purpose — the caller controls what
    // project the test set lands in; the test set definition itself is
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
    // is stripped before validation — the test set definition itself is
    // project-agnostic.
    const { projectId: _pid, ...bodyWithoutProjectId } = bodyObj;
    const validation = validateTestSet(bodyWithoutProjectId, tenantId);
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

    if (isAgentTestSetId(validation.value.id)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: agentTestSetIdReserved(validation.value.id) },
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
      testSet: validation.value,
      enqueueTuples: (testSetId) =>
        tuplesForCreate({ kind: 'test_set', id: testSetId, tenantId, projectId }, creatorUserId),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('test-set-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'test-set-already-registered',
            message: `Test set "${outcome.testSetId}" version "${outcome.version}" is already registered`,
            testSetId: outcome.testSetId,
            version: outcome.version,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-mismatch') {
      return projectMismatch(c, 'test-set', outcome.testSetId, outcome.projectId);
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
    return c.json({ testSetId: outcome.testSetId, version: outcome.version });
  });

  // ---------- POST /:testSetId/versions/:version/unregister ----------
  r.post('/:testSetId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testSetId = c.req.param('testSetId');
    const version = c.req.param('version');

    const outcome = await binding.unregister({ tenantId, testSetId, version });
    if (!outcome.unregistered) {
      c.status(statusFor('test-set-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'test-set-not-found',
            message: `No test set "${testSetId}" at version "${version}" to unregister`,
            testSetId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({ testSetId, version, unregistered: true });
  });

  // ---------- POST /:testSetId/versions/:version/reinstate ----------
  r.post('/:testSetId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testSetId = c.req.param('testSetId');
    const version = c.req.param('version');
    const outcome = await binding.reinstateVersion({ tenantId, testSetId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('test-set-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'test-set-not-found',
            message: `No test set "${testSetId}" at version "${version}" to reinstate`,
            testSetId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({
      testSetId: outcome.testSetId,
      version: outcome.version,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  return r;
}

function serializeTestSet(s: TestSetRecord): Record<string, unknown> {
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

function isTestSetKind(value: string): value is TestSetKind {
  return (TEST_SET_KINDS as readonly string[]).includes(value);
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Wire-shape validator for `TestSet`. Confirms the top-level fields
 * the registry needs (id, tenantId, semver version, kind ∈ closed enum,
 * spec is an object). Deeper validation of `spec` is the runtime
 * consumer's responsibility per eval kind.
 */
function validateTestSet(
  body: unknown,
  tenantId: TenantId,
):
  | { kind: 'ok'; value: TestSet }
  | {
      kind: 'err';
      error: { message: string; issues: readonly { path: string; message: string }[] };
    } {
  const b = body as Partial<TestSet> & Record<string, unknown>;
  const issues: { path: string; message: string }[] = [];

  if (typeof b.id !== 'string' || b.id.length === 0) {
    issues.push({ path: 'id', message: 'testSet.id must be a non-empty string' });
  }
  if (typeof b.version !== 'string' || !SEMVER_RE.test(b.version)) {
    issues.push({
      path: 'version',
      message: 'testSet.version must be a semver string (e.g. "1.0.0")',
    });
  }
  if (typeof b.kind !== 'string' || !isTestSetKind(b.kind)) {
    issues.push({
      path: 'kind',
      message: `testSet.kind must be one of: ${TEST_SET_KINDS.join(', ')}`,
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
        message: 'testSet.tenantId must match the caller tenant',
      });
    }
  }
  if (
    b.spec === undefined ||
    b.spec === null ||
    typeof b.spec !== 'object' ||
    Array.isArray(b.spec)
  ) {
    issues.push({ path: 'spec', message: 'testSet.spec must be an object' });
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    issues.push({ path: 'description', message: 'testSet.description must be a string' });
  }

  if (issues.length > 0) {
    return {
      kind: 'err',
      error: { message: issues[0]?.message ?? 'testSet validation failed', issues },
    };
  }

  const value: TestSet = {
    id: b.id as string,
    tenantId,
    version: b.version as string,
    kind: b.kind as TestSetKind,
    ...(typeof b.description === 'string' && { description: b.description }),
    spec: b.spec as Readonly<Record<string, unknown>>,
  };
  return { kind: 'ok', value };
}
