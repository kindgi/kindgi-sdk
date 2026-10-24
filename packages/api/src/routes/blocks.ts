// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { BLOCK_KINDS, type BlockKind, validateBlock } from '@kindgi/agents';
import { ref } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { BlockPublishOutcome, BlockRecord, BlockRegistryBinding } from '../block-binding.js';
import { continuityIssues, withCarriedSchema } from '../block-publish.js';
import { environmentTakesPromotionsResponse, laterEnvironment } from '../environment-entry.js';
import type { EnvironmentOrderBinding } from '../environment-orders-binding.js';
import { statusFor, toWireError } from '../errors.js';
import { type ItemRights, type ItemServing, shownLatest } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import { refuseWritesWhenReadOnly } from '../registry-read-only.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';
import { isRegistryVersionsCursor } from './versions-cursor.js';

/**
 * Data blocks: versioned prompts and settings that agent versions pin
 * (`/v1/blocks`).
 *
 * A block belongs to one project and is authorized through it: reading
 * is `read` on the project, publishing, unregistering and reinstating
 * are `write` on it. A block the caller can't read answers 404, as one
 * that doesn't exist.
 *
 * A block more than one project serves (an environment order carries it
 * to later environments) is read through any of them, each version where
 * it can run; unregistering or reinstating a version is `write` on every
 * project it can run in (`item-rights.ts`).
 *
 * A version never changes, nor does a block's kind. A settings block's
 * values must satisfy the latest version's schema as well as their
 * own, so whatever reads them sees a stable shape.
 */
export function blocksRouter(
  binding: BlockRegistryBinding,
  authorizer?: Authorizer,
  /**
   * The tenant's environment orders: a publish into a later environment is
   * refused (`environment-entry.ts`). Absent: no project is a later
   * environment.
   */
  environmentOrders?: Pick<EnvironmentOrderBinding, 'orderOf'>,
  /** Rights on a block more than one project serves. Absent: every block has one project. */
  itemRights?: ItemRights,
  /** With no authorizer: which projects serve it, for `?projectId=` (`itemServingOf`). */
  itemServing?: ItemServing,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Every schema a publish compiles counts against its tenant's budget.
  const publishCompiles = publishCompilesMiddleware();
  // A read-only registry (under `kindgi dev`, the pack's files) refuses
  // every write before anything else runs.
  r.use(
    '*',
    refuseWritesWhenReadOnly(() => binding.readOnly),
  );

  async function canProject(
    c: Context<AppEnv>,
    action: 'read' | 'write',
    projectId: ProjectId,
  ): Promise<boolean> {
    return authorizer === undefined || authorizer.can(c, action, ref('project', projectId));
  }

  /**
   * A block more than one project serves: the rights and its projects,
   * or `'hidden'` when the caller reads none of them (rule 1), answered
   * as a missing block. `undefined`: one project, checked as before.
   */
  async function served(
    c: Context<AppEnv>,
    blockId: string,
  ): Promise<{ rights: ItemRights; projects: readonly ProjectId[] } | 'hidden' | undefined> {
    const projects = await itemRights?.multi(c, 'block', blockId);
    if (itemRights === undefined || projects === undefined) return undefined;
    return (await itemRights.read(c, 'block', blockId, projects)) === undefined
      ? { rights: itemRights, projects }
      : 'hidden';
  }

  function notFound(c: Context<AppEnv>, blockId: string, version?: string) {
    c.status(statusFor('block-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'block-not-found',
          message: `No block "${blockId}"${version !== undefined ? ` at version "${version}"` : ''}`,
          blockId,
          ...(version !== undefined && { version }),
        },
        c.get('requestId'),
      ),
    );
  }

  function badInput(c: Context<AppEnv>, message: string) {
    c.status(statusFor('bad-input') as never);
    return c.json(toWireError({ code: 'bad-input', message }, c.get('requestId')));
  }

  // ---------- GET / (each block's latest version) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const kind = c.req.query('kind');
    if (kind !== undefined && kind.length > 0 && !isBlockKind(kind)) {
      return badInput(
        c,
        `Unknown block kind "${kind}". Expected one of: ${BLOCK_KINDS.join(', ')}.`,
      );
    }
    const scope = parseScopeParams(c.req.query(), { tenantId });
    if (scope.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scope.message }, c.get('requestId')),
      );
    }
    const cursor = c.req.query('cursor');
    const name = c.req.query('name');
    const page = await binding.list({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
      ...(kind !== undefined && kind.length > 0 && { blockKind: kind as BlockKind }),
      ...(name !== undefined && name.length > 0 && { nameFilter: name }),
      ...(scope.scope !== undefined && { scope: scope.scope }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : itemRights === undefined
          ? await authorizer.filterByCan(c, 'read', page.data, (b) => ref('project', b.projectId))
          : await itemRights.filterItems(c, 'block', page.data, {
              idOf: (b) => b.id,
              todayRef: (b) => ref('project', b.projectId),
              versions: {
                versionOf: (b) => b.version,
                getVersion: (id, version) => binding.getVersion({ tenantId, blockId: id, version }),
              },
            });
    return c.json({
      data: visible.map(serializeBlock),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:blockId (latest version) ----------
  r.get('/:blockId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const blockId = c.req.param('blockId');
    const block = await binding.get({ tenantId, blockId });
    if (block === null) return notFound(c, blockId);
    const many = await served(c, blockId);
    if (many === 'hidden') return notFound(c, blockId);
    if (many === undefined && !(await canProject(c, 'read', block.projectId))) {
      return notFound(c, blockId);
    }
    const shown = await shownLatest(c, itemRights ?? itemServing, 'block', blockId, block, {
      versionOf: (b) => b.version,
      projectOf: (b) => b.projectId,
      getVersion: (version) => binding.getVersion({ tenantId, blockId, version }),
    });
    if (shown.kind === 'bad-input') return badInput(c, shown.message);
    if (shown.kind === 'not-found') return notFound(c, blockId);
    return c.json(serializeBlock(shown.row));
  });

  // ---------- GET /:blockId/versions ----------
  r.get('/:blockId/versions', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const blockId = c.req.param('blockId');
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && cursor.length > 0 && !isRegistryVersionsCursor(cursor)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, c.get('requestId')),
      );
    }
    const page = await binding.listVersions({
      tenantId,
      blockId,
      limit: clampLimit(c.req.query('limit')),
      includeTombstoned: c.req.query('includeTombstoned') === 'true',
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const data = await readableVersions(c, tenantId, blockId, page.data);
    if (data === undefined) return notFound(c, blockId);
    return c.json({
      data: data.map(serializeBlock),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:blockId/versions/:version ----------
  r.get('/:blockId/versions/:version', async (c) => {
    const blockId = c.req.param('blockId');
    const version = c.req.param('version');
    const many = await served(c, blockId);
    if (
      many === 'hidden' ||
      (many !== undefined &&
        !(await many.rights.versionVisible(c, 'block', blockId, many.projects, version)))
    ) {
      return notFound(c, blockId, version);
    }
    const block = await binding.getVersion({
      tenantId: c.get('tenantId') as TenantId,
      blockId,
      version,
    });
    if (block === null || (many === undefined && !(await canProject(c, 'read', block.projectId)))) {
      return notFound(c, blockId, version);
    }
    return c.json(serializeBlock(block));
  });

  // ---------- POST / (publish a version) ----------
  r.post('/', publishCompiles, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badInput(c, 'Request body must be valid JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return badInput(c, 'Request body must be an object');
    }
    const { projectId, ...definition } = body as Record<string, unknown>;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return badInput(c, '`projectId` is required');
    }
    if (!(await canProject(c, 'write', projectId as ProjectId))) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message: `Publishing a block needs write on project "${projectId}"`,
          },
          requestId,
        ),
      );
    }
    const later = await laterEnvironment(environmentOrders, tenantId, projectId as ProjectId);
    if (later !== undefined) {
      return environmentTakesPromotionsResponse(
        c,
        requestId,
        authorizer,
        { kind: 'publish', noun: 'data block' },
        later,
      );
    }
    const validated = validateBlock(definition);
    if (validated.kind === 'err')
      return validationFailed(c, validated.error.message, validated.error.issues);
    const block = validated.value;

    // A block keeps its kind. A settings version without a schema keeps
    // the latest version's (stored on it, so the check carries forward to
    // every later version); one that gives a schema replaces it.
    const latest = await binding.get({ tenantId, blockId: block.id });
    const continuity = continuityIssues(latest, block);
    if (continuity.length > 0) {
      return validationFailed(c, `Block "${block.id}" can't take this version`, continuity);
    }

    const outcome = await binding.publish({
      tenantId,
      projectId: projectId as ProjectId,
      block: withCarriedSchema(latest, block),
    });
    return published(c, outcome);
  });

  // ---------- POST /:blockId/versions/:version/unregister ----------
  r.post('/:blockId/versions/:version/unregister', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const blockId = c.req.param('blockId');
    const version = c.req.param('version');
    const refused = await mayChangeVersion(c, tenantId, blockId, version);
    if (refused !== undefined) return refused;
    const outcome = await binding.unregister({ tenantId, blockId, version });
    if (!outcome.unregistered) return notFound(c, blockId, version);
    return c.json({ blockId, version, unregistered: true });
  });

  // ---------- POST /:blockId/versions/:version/reinstate ----------
  r.post('/:blockId/versions/:version/reinstate', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const blockId = c.req.param('blockId');
    const version = c.req.param('version');
    const refused = await mayChangeVersion(c, tenantId, blockId, version);
    if (refused !== undefined) return refused;
    const outcome = await binding.reinstateVersion({ tenantId, blockId, version });
    if (outcome.kind === 'not-found') return notFound(c, blockId, version);
    return c.json({ blockId, version, wasTombstoned: outcome.wasTombstoned });
  });

  /**
   * Unregistering or reinstating a version: `write` on its project; for a
   * block more than one project serves, on every project the version can
   * run in (a version that doesn't exist: the block's), after reading it
   * (rule 1). `undefined`: allowed, or no such version, for the handler.
   */
  async function mayChangeVersion(
    c: Context<AppEnv>,
    tenantId: TenantId,
    blockId: string,
    version: string,
  ): Promise<Response | undefined> {
    const many = await served(c, blockId);
    if (many === 'hidden') return notFound(c, blockId, version);
    if (many !== undefined) {
      return many.rights.enforce(
        c,
        'block',
        blockId,
        many.projects,
        { rule: 'every-version', action: 'write', version },
        (cx, v) => notFound(cx, blockId, v),
      );
    }
    const block = await binding.getVersion({ tenantId, blockId, version });
    if (block === null || !(await canProject(c, 'read', block.projectId))) {
      return notFound(c, blockId, version);
    }
    if (!(await canProject(c, 'write', block.projectId))) return denied(c, block.projectId);
    return undefined;
  }

  /** Any version of a block, unregistered ones included: whose project it is. */
  /**
   * A page of a block's versions as the caller reads them: every one, when
   * they read the block's project; for a block more than one project
   * serves, those that can run in a project they read. `undefined`: they
   * don't read the block (its 404).
   */
  async function readableVersions(
    c: Context<AppEnv>,
    tenantId: TenantId,
    blockId: string,
    rows: readonly BlockRecord[],
  ): Promise<readonly BlockRecord[] | undefined> {
    const many = await served(c, blockId);
    if (many === 'hidden') return undefined;
    if (many !== undefined) {
      return many.rights.visibleVersions(
        c,
        'block',
        blockId,
        many.projects,
        rows,
        (b) => b.version,
      );
    }
    const owner = rows[0] ?? (await anyVersion(tenantId, blockId));
    return owner !== null && (await canProject(c, 'read', owner.projectId)) ? rows : undefined;
  }

  async function anyVersion(tenantId: TenantId, blockId: string): Promise<BlockRecord | null> {
    const page = await binding.listVersions({
      tenantId,
      blockId,
      limit: 1,
      includeTombstoned: true,
    });
    return page.data[0] ?? null;
  }

  return r;
}

function isBlockKind(value: string): value is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(value);
}

/** The response to a publish outcome. */
function published(c: Context<AppEnv>, outcome: BlockPublishOutcome) {
  const requestId = c.get('requestId');
  switch (outcome.kind) {
    case 'ok':
      c.status(201);
      return c.json({ blockId: outcome.blockId, version: outcome.version });
    case 'already-registered':
      c.status(statusFor('block-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'block-already-registered',
            message: `Block "${outcome.blockId}" version "${outcome.version}" is already published; versions never change, so publish a new one`,
            blockId: outcome.blockId,
            version: outcome.version,
          },
          requestId,
        ),
      );
    case 'project-mismatch':
      return projectMismatch(c, 'block', outcome.blockId, outcome.projectId);
    case 'project-not-found':
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
}

function validationFailed(
  c: Context<AppEnv>,
  message: string,
  issues: readonly { readonly path: string; readonly message: string }[],
) {
  c.status(statusFor('validation-failed') as never);
  return c.json(
    toWireError(
      {
        code: 'validation-failed',
        message,
        issues: issues as unknown as Record<string, unknown>[],
      },
      c.get('requestId'),
    ),
  );
}

function denied(c: Context<AppEnv>, projectId: ProjectId) {
  c.status(statusFor('permission-denied') as never);
  return c.json(
    toWireError(
      {
        code: 'permission-denied',
        message: `This needs write on the block's project "${projectId as unknown as string}"`,
      },
      c.get('requestId'),
    ),
  );
}

function serializeBlock(b: BlockRecord): Record<string, unknown> {
  return {
    id: b.id,
    version: b.version,
    kind: b.kind,
    ...(b.description !== undefined && { description: b.description }),
    content: b.content,
    projectId: b.projectId as unknown as string,
    publishedAt: b.publishedAt,
    ...(b.unregisteredAt !== undefined && { unregisteredAt: b.unregisteredAt }),
  };
}
