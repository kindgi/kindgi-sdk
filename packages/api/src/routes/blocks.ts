// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import {
  type AgentId,
  BLOCK_KINDS,
  type BlockKind,
  type SettingsBlockContent,
  modelNamedTwice,
  modelSettingsIssues,
  validateBlock,
} from '@kindgi/agents';
import type { AuditEventBinding } from '@kindgi/audit-events';
import { ref } from '@kindgi/authz';
import { emitAuditEvent } from '@kindgi/compliance';
import type { Logger } from '@kindgi/log';
import { highestVersion } from '@kindgi/tools';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { AgentPinBindings } from '../agent-pin-binding.js';
import type {
  BlockPublishOutcome,
  BlockRecord,
  BlockRegistryBinding,
  BlockUseBinding,
} from '../block-binding.js';
import { continuityIssues, withCarriedSchema } from '../block-publish.js';
import type {
  BlockVersionPullRequest,
  BlockVersionPullRequestBinding,
} from '../block-version-pr-binding.js';
import { callerIdentity } from '../caller.js';
import type { DeploymentBinding } from '../deployment-binding.js';
import { environmentTakesPromotionsResponse, laterEnvironment } from '../environment-entry.js';
import type { EnvironmentOrderBinding } from '../environment-orders-binding.js';
import { statusFor, toWireError } from '../errors.js';
import { type ItemRights, type ItemServing, shownLatest } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import { refuseWritesWhenReadOnly } from '../registry-read-only.js';
import type { AppEnv } from '../types.js';
import { whatRunsByProject } from '../what-runs.js';
import { actorOf, seenVersions } from './agent-pins.js';
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
 * own, so whatever reads them sees a stable shape. A settings block an
 * agent version uses as its model settings takes only model settings,
 * and never names the model that version names too.
 *
 * Each version records who published it and where it came from (`api`
 * here). Publishing, unregistering and reinstating a version are audit
 * events, with the caller as their actor.
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
  /**
   * Which agent versions use a block, for the model-settings check on a
   * publish. Absent: a settings version isn't checked as model settings.
   */
  blockUse?: BlockUseBinding,
  /** Where the audit events land. Absent: none is recorded. */
  auditEvents?: AuditEventBinding,
  /**
   * What runs where, for `GET /:blockId/runs-in`. Absent (or without
   * `blockUse`): it answers `501 runs-in-unsupported`.
   */
  runsIn?: BlockRunsInDeps,
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

  // ---------- GET /:blockId/runs-in ----------
  // Where the block's versions run now. For each agent with a version that
  // pins the block (`BlockUseBinding.pinningBlock`), its projects are taken
  // as `GET /v1/agents/:agentId/projects` takes them, so the two pages
  // agree: its own project, then each one a version can run in, only those
  // the caller reads. `whatRunsByProject` says what runs in each. A row is
  // a project, or a segment pin inside one, whose running version pins the
  // block, with the block version it pins. An agent version the caller
  // can't see is left out (`seenVersions`). Each row says whether the
  // pack's files have that version (`withInYourFiles`).
  /** The projects an agent runs in that the caller reads, as `GET /v1/agents/:agentId/projects` lists them. */
  async function agentProjectsRead(
    c: Context<AppEnv>,
    deps: BlockRunsInDeps,
    agentId: string,
  ): Promise<readonly ProjectId[]> {
    const projectsOf = itemRights ?? itemServing;
    const projects =
      projectsOf !== undefined
        ? await projectsOf.projects(c, 'agent', agentId)
        : await deps.ownProject(c.get('tenantId') as TenantId, agentId as AgentId);
    if (projects === undefined || projects.length === 0) return [];
    return authorizer === undefined
      ? projects
      : authorizer.filterByCan(c, 'read', projects, (p) => ref('project', p as unknown as string));
  }

  r.get('/:blockId/runs-in', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const blockId = c.req.param('blockId');
    const block = await binding.get({ tenantId, blockId });
    if (block === null) return notFound(c, blockId);
    const many = await served(c, blockId);
    if (many === 'hidden') return notFound(c, blockId);
    if (many === undefined && !(await canProject(c, 'read', block.projectId))) {
      return notFound(c, blockId);
    }
    if (blockUse === undefined || runsIn === undefined) {
      c.status(statusFor('runs-in-unsupported') as never);
      return c.json(
        toWireError(
          {
            code: 'runs-in-unsupported',
            message: "This runtime can't say where a block runs: it doesn't read pins and Latest",
          },
          c.get('requestId'),
        ),
      );
    }
    const pinning = pinningVersions(await blockUse.pinningBlock({ tenantId, blockId }));
    const data: BlockRunsInRow[] = [];
    for (const [id, versions] of pinning) {
      const named = await agentProjectsRead(c, runsIn, id);
      if (named.length === 0) continue;
      const [rows, visible] = await Promise.all([
        whatRunsByProject(runsIn.agentPins, { tenantId, agentId: id as AgentId }, named),
        seenVersions(itemRights, c, id, [...versions.keys()]),
      ]);
      data.push(
        ...agentRunsInRows(id, rows, (version) =>
          visible.has(version) ? versions.get(version) : undefined,
        ),
      );
    }
    return c.json({ data: await withInYourFiles(runsIn, tenantId, blockId, data, c.get('log')) });
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
    if (block.kind === 'settings' && blockUse !== undefined) {
      const refused = await modelSettingsRefusal(blockUse, tenantId, block.id, block.content);
      if (refused !== undefined) return validationFailed(c, refused.message, refused.issues);
    }

    const outcome = await binding.publish({
      tenantId,
      projectId: projectId as ProjectId,
      block: withCarriedSchema(latest, block),
      publishedBy: actorOf(c),
      source: { kind: 'api' },
    });
    if (outcome.kind === 'ok') {
      await audit(c, 'block-version-published', projectId as ProjectId, {
        blockId: block.id,
        version: block.version,
        kind: block.kind,
        source: { kind: 'api' },
      });
    }
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
    await auditVersion(c, 'block-version-unregistered', tenantId, blockId, version);
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
    if (outcome.wasTombstoned) {
      await auditVersion(c, 'block-version-reinstated', tenantId, blockId, version);
    }
    return c.json({ blockId, version, wasTombstoned: outcome.wasTombstoned });
  });

  /** An audit event for a change to a block version, with the caller as its actor. */
  async function audit(
    c: Context<AppEnv>,
    kind: 'block-version-published' | 'block-version-unregistered' | 'block-version-reinstated',
    projectId: ProjectId | undefined,
    doc: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await emitAuditEvent({
      auditEvents,
      tenantId: c.get('tenantId') as TenantId,
      ...(projectId !== undefined && { projectId }),
      kind,
      actor: callerIdentity(c),
      outcome: 'succeeded',
      correlationId: c.get('requestId'),
      doc,
      log: c.get('log').child({ subsystem: 'audit' }),
    });
  }

  /** `audit` for an unregister or reinstate, in the version's own project. */
  async function auditVersion(
    c: Context<AppEnv>,
    kind: 'block-version-unregistered' | 'block-version-reinstated',
    tenantId: TenantId,
    blockId: string,
    version: string,
  ): Promise<void> {
    if (auditEvents === undefined) return;
    const record = await binding.getVersion({ tenantId, blockId, version });
    await audit(c, kind, record?.projectId, { blockId, version });
  }

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

/**
 * Why a new settings version is refused as model settings: an agent
 * version uses the block as its model settings, and the values aren't
 * model settings, or name the model that version names too. Undefined
 * when no agent version uses it so, or the values pass.
 */
async function modelSettingsRefusal(
  blockUse: BlockUseBinding,
  tenantId: TenantId,
  blockId: string,
  content: SettingsBlockContent,
): Promise<{ message: string; issues: { path: string; message: string }[] } | undefined> {
  const uses = (await blockUse.pinningBlock({ tenantId, blockId })).filter(
    (u) => u.as === 'model-settings',
  );
  const [first] = uses;
  if (first === undefined) return undefined;
  const issues = modelSettingsIssues(content.values);
  if (issues.length > 0) {
    return {
      message: `Block "${blockId}" is the model settings of agent "${first.agentId}" version ${first.version}, and these values aren't model settings`,
      issues,
    };
  }
  const twice = uses.flatMap((u) => {
    const why = modelNamedTwice(u, content.values);
    return why === undefined
      ? []
      : [{ path: '/content/values', message: `agent "${u.agentId}" version ${u.version}: ${why}` }];
  });
  return twice.length === 0
    ? undefined
    : { message: `Block "${blockId}"'s new values name the model twice`, issues: twice };
}

/** What `GET /v1/blocks/:blockId/runs-in` reads besides the block registry. */
export interface BlockRunsInDeps {
  /** The agents' pins and Latest, which say what runs in each project. */
  readonly agentPins: Pick<AgentPinBindings, 'pinned' | 'latest'>;
  /**
   * An agent's own project, when no item-projects binding names its
   * projects (`agentOwnProject`). `undefined`: no such agent.
   */
  readonly ownProject: (
    tenantId: TenantId,
    agentId: AgentId,
  ) => Promise<readonly ProjectId[] | undefined>;
  /**
   * Each project's deployments: whether the newest one of the row agent's
   * pack lists the block's version.
   */
  readonly deployments?: Pick<DeploymentBinding, 'list'>;
  /** The pull requests opened for block versions. */
  readonly pullRequests?: BlockVersionPullRequestBinding;
}

/** One place a version of the block runs: a project, or a segment pin inside one. */
interface BlockRunsInRow {
  readonly projectId: ProjectId;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly blockVersion: string;
  readonly follows: 'pin' | 'latest';
  readonly segment?: readonly { readonly key: string; readonly value: string }[];
  readonly inYourFiles?: {
    readonly state: 'yes' | 'not-yet';
    readonly pr?: BlockVersionPullRequest;
  };
}

/** Each agent's versions that pin the block, and the block version each pins. */
function pinningVersions(
  uses: Awaited<ReturnType<BlockUseBinding['pinningBlock']>>,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const pinning = new Map<string, Map<string, string>>();
  for (const use of uses) {
    const agentId = use.agentId as unknown as string;
    const versions = pinning.get(agentId) ?? new Map<string, string>();
    versions.set(use.version, use.blockVersion);
    pinning.set(agentId, versions);
  }
  return pinning;
}

/**
 * One agent's rows: each project, and each segment pin inside one, whose
 * running version pins the block (`pinned` gives the block version it
 * pins, `undefined` for none or a version the caller can't see).
 */
function agentRunsInRows(
  agentId: string,
  rows: Awaited<ReturnType<typeof whatRunsByProject>>,
  pinned: (version: string) => string | undefined,
): BlockRunsInRow[] {
  const out: BlockRunsInRow[] = [];
  for (const { projectId, runs, segments } of rows) {
    const blockVersion = runs === null ? undefined : pinned(runs.version);
    if (runs !== null && blockVersion !== undefined) {
      out.push({
        projectId,
        agentId,
        agentVersion: runs.version,
        blockVersion,
        follows: runs.follows,
      });
    }
    for (const s of segments) {
      const segmentBlockVersion = pinned(s.version);
      if (segmentBlockVersion === undefined) continue;
      out.push({
        projectId,
        agentId,
        agentVersion: s.version,
        blockVersion: segmentBlockVersion,
        follows: 'pin',
        segment: s.path.map(({ key, value }) => ({ key, value })),
      });
    }
  }
  return out;
}

/**
 * How many deployments a page of a project's list holds when "In your
 * files" looks for an agent's pack, and how many pages it reads before
 * it takes the pack as not deployed there.
 */
const PACK_DEPLOYMENTS_PAGE = 50;
const PACK_DEPLOYMENT_PAGES = 4;

/**
 * Each row with "In your files", when the runtime reads deployments or
 * pull requests (neither: the rows as they are). `yes` when the pack's
 * newest deployment in the row's project lists the block at its version
 * or a newer one, or the pull request opened for it there was merged;
 * else `not-yet`. The pack is the row agent's: a project can hold
 * several, so it's the newest deployment there that ships the agent. The
 * pull request comes with it when one was opened. A row whose pull
 * request can't be read has none: it's logged, by the error's name only,
 * and the page still answers.
 */
async function withInYourFiles(
  deps: BlockRunsInDeps,
  tenantId: TenantId,
  blockId: string,
  rows: readonly BlockRunsInRow[],
  log: Logger,
): Promise<readonly BlockRunsInRow[]> {
  const { deployments, pullRequests } = deps;
  if (deployments === undefined && pullRequests === undefined) return rows;
  const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => {
    let found = cache.get(key);
    if (found === undefined) {
      found = read();
      cache.set(key, found);
    }
    return found;
  };
  const deployed = new Map<string, Promise<string | undefined>>();
  const opened = new Map<string, Promise<BlockVersionPullRequest | null | 'unread'>>();
  // Newest first, so the first deployment that ships the agent is its pack's newest.
  const deployedIn = (projectId: ProjectId, agentId: string) =>
    once(deployed, `${projectId as unknown as string}\u0000${agentId}`, async () => {
      if (deployments === undefined) return undefined;
      let cursor: Cursor | undefined;
      for (let page = 0; page < PACK_DEPLOYMENT_PAGES; page++) {
        const { data, nextCursor } = await deployments.list({
          tenantId,
          projectId,
          limit: PACK_DEPLOYMENTS_PAGE,
          ...(cursor !== undefined && { cursor }),
        });
        const newest = data.find((d) => d.contents.agents.some((a) => a.id === agentId));
        if (newest !== undefined) {
          return newest.contents.blocks?.find((b) => b.id === blockId)?.version;
        }
        if (nextCursor === undefined) return undefined;
        cursor = nextCursor;
      }
      return undefined;
    });
  const openedFor = (projectId: ProjectId, version: string) =>
    once(opened, `${projectId as unknown as string}\u0000${version}`, async () => {
      if (pullRequests === undefined) return null;
      try {
        return await pullRequests.forVersion({ tenantId, projectId, blockId, version });
      } catch (cause) {
        log.warn('A block version pull request could not be read', {
          blockId,
          version,
          projectId: projectId as unknown as string,
          // The name only: a message can quote what the repository answered.
          error: cause instanceof Error ? cause.name : typeof cause,
        });
        return 'unread';
      }
    });
  return Promise.all(
    rows.map(async (row): Promise<BlockRunsInRow> => {
      const [inFiles, pr] = await Promise.all([
        deployedIn(row.projectId, row.agentId),
        openedFor(row.projectId, row.blockVersion),
      ]);
      if (pr === 'unread') return row;
      const yes =
        (inFiles !== undefined && atLeast(inFiles, row.blockVersion)) || pr?.state === 'merged';
      return {
        ...row,
        inYourFiles: {
          state: yes ? 'yes' : 'not-yet',
          ...(pr !== null && { pr: { number: pr.number, url: pr.url, state: pr.state } }),
        },
      };
    }),
  );
}

/** `a` is `b` or a newer version, by the one version rule: a prerelease is older than its release. */
function atLeast(a: string, b: string): boolean {
  return a === b || highestVersion([a, b]) === a;
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
    ...(b.publishedBy !== undefined && { publishedBy: b.publishedBy }),
    ...(b.source !== undefined && { source: b.source }),
  };
}
