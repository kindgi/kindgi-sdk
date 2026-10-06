// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import {
  BLOCK_KINDS,
  type BlockDefinition,
  type BlockKind,
  settingsSchemaIssues,
  validateBlock,
} from '@kindgi/agents';
import { ref } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { BlockPublishOutcome, BlockRecord, BlockRegistryBinding } from '../block-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Data blocks: versioned prompts and settings that agent versions pin
 * (`/v1/blocks`).
 *
 * A block belongs to one project and is authorized through it: reading
 * is `read` on the project, publishing, unregistering and reinstating
 * are `write` on it. A block the caller can't read answers 404, as one
 * that doesn't exist.
 *
 * A version never changes, nor does a block's kind. A settings block's
 * values must satisfy the latest version's schema as well as their
 * own, so whatever reads them sees a stable shape.
 */
export function blocksRouter(binding: BlockRegistryBinding, authorizer?: Authorizer): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function canProject(
    c: Context<AppEnv>,
    action: 'read' | 'write',
    projectId: ProjectId,
  ): Promise<boolean> {
    return authorizer === undefined || authorizer.can(c, action, ref('project', projectId));
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
        : await authorizer.filterByCan(c, 'read', page.data, (b) => ref('project', b.projectId));
    return c.json({
      data: visible.map(serializeBlock),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:blockId (latest version) ----------
  r.get('/:blockId', async (c) => {
    const blockId = c.req.param('blockId');
    const block = await binding.get({ tenantId: c.get('tenantId') as TenantId, blockId });
    if (block === null || !(await canProject(c, 'read', block.projectId))) {
      return notFound(c, blockId);
    }
    return c.json(serializeBlock(block));
  });

  // ---------- GET /:blockId/versions ----------
  r.get('/:blockId/versions', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const blockId = c.req.param('blockId');
    const cursor = c.req.query('cursor');
    const page = await binding.listVersions({
      tenantId,
      blockId,
      limit: clampLimit(c.req.query('limit')),
      includeTombstoned: c.req.query('includeTombstoned') === 'true',
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const owner = page.data[0] ?? (await anyVersion(tenantId, blockId));
    if (owner === null || !(await canProject(c, 'read', owner.projectId))) {
      return notFound(c, blockId);
    }
    return c.json({
      data: page.data.map(serializeBlock),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:blockId/versions/:version ----------
  r.get('/:blockId/versions/:version', async (c) => {
    const blockId = c.req.param('blockId');
    const version = c.req.param('version');
    const block = await binding.getVersion({
      tenantId: c.get('tenantId') as TenantId,
      blockId,
      version,
    });
    if (block === null || !(await canProject(c, 'read', block.projectId))) {
      return notFound(c, blockId, version);
    }
    return c.json(serializeBlock(block));
  });

  // ---------- POST / (publish a version) ----------
  r.post('/', async (c) => {
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
    const block = await binding.getVersion({ tenantId, blockId, version });
    if (block === null || !(await canProject(c, 'read', block.projectId))) {
      return notFound(c, blockId, version);
    }
    if (!(await canProject(c, 'write', block.projectId))) return denied(c, block.projectId);
    const outcome = await binding.unregister({ tenantId, blockId, version });
    if (!outcome.unregistered) return notFound(c, blockId, version);
    return c.json({ blockId, version, unregistered: true });
  });

  // ---------- POST /:blockId/versions/:version/reinstate ----------
  r.post('/:blockId/versions/:version/reinstate', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const blockId = c.req.param('blockId');
    const version = c.req.param('version');
    const block = await binding.getVersion({ tenantId, blockId, version });
    if (block === null || !(await canProject(c, 'read', block.projectId))) {
      return notFound(c, blockId, version);
    }
    if (!(await canProject(c, 'write', block.projectId))) return denied(c, block.projectId);
    const outcome = await binding.reinstateVersion({ tenantId, blockId, version });
    if (outcome.kind === 'not-found') return notFound(c, blockId, version);
    return c.json({ blockId, version, wasTombstoned: outcome.wasTombstoned });
  });

  /** Any version of a block, unregistered ones included: whose project it is. */
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

/**
 * A new version against the block's latest: the same kind, and a
 * settings version without a schema of its own satisfies the schema it
 * keeps (`carriedSchema`).
 */
function continuityIssues(
  latest: BlockRecord | null,
  block: BlockDefinition,
): { path: string; message: string }[] {
  if (latest === null) return [];
  if (latest.kind !== block.kind) {
    return [
      {
        path: '/kind',
        message: `block "${block.id}" is a ${latest.kind} block; a version can't change its kind`,
      },
    ];
  }
  const carried = carriedSchema(latest, block);
  if (block.kind !== 'settings' || carried === undefined) return [];
  return settingsSchemaIssues(block.content.values, carried).map((i) => ({
    ...i,
    message: `${i.message} (the schema of version ${latest.version})`,
  }));
}

/**
 * The schema a settings version that gives none keeps: the latest
 * version's. A version that gives a schema replaces it (`{}` drops the
 * check on purpose).
 */
function carriedSchema(
  latest: BlockRecord | null,
  block: BlockDefinition,
): Readonly<Record<string, unknown>> | undefined {
  if (latest?.kind !== 'settings' || block.kind !== 'settings') return undefined;
  return block.content.schema === undefined ? latest.content.schema : undefined;
}

/** The version as stored: with the schema it keeps, if any. */
function withCarriedSchema(latest: BlockRecord | null, block: BlockDefinition): BlockDefinition {
  const schema = carriedSchema(latest, block);
  if (schema === undefined || block.kind !== 'settings') return block;
  return { ...block, content: { ...block.content, schema } };
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
      c.status(statusFor('block-project-mismatch') as never);
      return c.json(
        toWireError(
          {
            code: 'block-project-mismatch',
            message: `Block "${outcome.blockId}" belongs to project "${outcome.projectId as unknown as string}"; publish its versions there`,
            blockId: outcome.blockId,
            projectId: outcome.projectId as unknown as string,
          },
          requestId,
        ),
      );
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
