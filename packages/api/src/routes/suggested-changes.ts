// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import type { AuditEventBinding } from '@kindgi/audit-events';
import { type Action, ref } from '@kindgi/authz';
import { emitAuditEvent } from '@kindgi/compliance';
import type { AgentPinScope, Cursor, ProjectId, SuggestedChangeId, TenantId } from '@kindgi/types';

import type { PinActor } from '../agent-pin-binding.js';
import type { BlockRegistryBinding } from '../block-binding.js';
import { callerIdentity } from '../caller.js';
import { environmentTakesPromotionsResponse } from '../environment-entry.js';
import { statusFor, toWireError } from '../errors.js';
import {
  type ItemRights,
  agentPinScopeCheck,
  widthRefusal,
  writeWhereMade,
} from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import { latestMoved } from '../pin-test-runs.js';
import {
  type SuggestedChangeCreator,
  type SuggestedChangeFacts,
  type SuggestedChangeServiceDeps,
  type SuggestedChangeServiceError,
  createSuggestedChangeService,
  suggestedChangeNotFound,
} from '../suggested-change-service.js';
import {
  SUGGESTED_CHANGE_STATUSES,
  type SuggestedChangeSide,
  type SuggestedChangeStatus,
  blockChangeOf,
  suggestedChangeMaker,
} from '../suggested-change-status.js';
import type {
  CodeChange,
  ProposedChange,
  StoredSuggestedChange,
  SuggestedChangeMaker,
} from '../supervisor-binding.js';
import type { AppEnv } from '../types.js';
import { type PinRequestOutcome, actorOf, pinAnswer, pinResponse } from './agent-pins.js';
import { clampLimit } from './pagination.js';

/** What the suggested change lifecycle runs on besides its own store. */
export type SuggestedChangesRouteDeps = Omit<SuggestedChangeServiceDeps, 'store'> & {
  /**
   * Where making, pinning, adding as Latest and withdrawing one are
   * recorded, with the caller as their actor. Absent: none is.
   */
  readonly auditEvents?: AuditEventBinding;
};

const MAKER_KINDS: readonly SuggestedChangeMaker['kind'][] = [
  'improve-run',
  'person',
  'service',
  'deploy',
  'offer',
];
const MAX_TEXT = 2000;
/** At most this many ids in a new card's `fixes`: each is read before the card is made. */
const FIXES_MAX = 100;
/** How much of the first line of `why` a title keeps. */
const TITLE_LENGTH = 60;

type Ctx = Context<AppEnv>;

/**
 * Suggested changes (`/v1/suggested-changes`): a change to one data block
 * (new settings values, or a new prompt template) for one project, built
 * on what the project runs and checked on the project's test set
 * (`createSuggestedChangeService`).
 *
 *   GET  /                 list, newest first (statuses derived): by agent,
 *                          project, status and who made it
 *   GET  /:id              one, with its block's content before and after
 *   POST /                 a suggested change by hand: published, derived
 *                          (inert until pinned) and checked (201, checking)
 *   POST /:id/check        checked again on the project's test set (202);
 *                          rebuilt first on what the project runs now,
 *                          when that moved
 *   POST /:id/pin          a gated pin of its version for the project
 *                          (201 pinned, 202 waiting for a second person,
 *                          422 gate-failed)
 *   POST /:id/add-as-latest  its version made Latest, for a project on
 *                          Latest (200 added-as-latest; no gate)
 *   POST /:id/withdraw     closed by a person
 *
 * Once one is pinned (not waiting for a second person) or added as
 * Latest, its project's other ready or check-failed suggested changes for
 * the agent are rebuilt on its version. One built on a version its project
 * no longer runs isn't pinned or added as Latest: it's rebuilt (409
 * `suggested-change-out-of-date`).
 *
 * Making one, pinning it, adding it as Latest and withdrawing it are audit
 * events (`suggested-change-*`), with the caller as their actor.
 *
 * Authorized on the suggested change's agent: reading is `read`, making,
 * checking and withdrawing are `publish`, and pinning and adding as
 * Latest are `pin`. A suggested change the caller can't read answers
 * 404, as one that doesn't exist.
 *
 * For an agent more than one project serves (`item-rights.ts`): reading
 * is `read` on the agent or on any of its projects; making, checking and
 * withdrawing are `write` where its new versions are made; pinning and
 * adding as Latest are `admin` in the suggested change's project.
 */
export function suggestedChangesRouter(
  store: SuggestedChangeServiceDeps['store'],
  deps: SuggestedChangesRouteDeps,
  authorizer?: Authorizer,
  /** Rights on an agent more than one project serves. Absent: one project each. */
  itemRights?: ItemRights,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Every schema a publish compiles counts against its tenant's budget.
  const publishCompiles = publishCompilesMiddleware();
  const { auditEvents, ...serviceDeps } = deps;
  const service = createSuggestedChangeService({ ...serviceDeps, store });

  /** An audit event for a suggested change, in its project, with the caller as its actor. */
  async function audit(
    c: Ctx,
    kind:
      | 'suggested-change-created'
      | 'suggested-change-pinned'
      | 'suggested-change-added-as-latest'
      | 'suggested-change-withdrawn',
    p: StoredSuggestedChange,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const projectId = p.scope.kind === 'project' ? p.scope.projectId : p.projectId;
    await emitAuditEvent({
      auditEvents,
      tenantId: c.get('tenantId') as TenantId,
      ...(projectId !== undefined && { projectId }),
      kind,
      actor: callerIdentity(c),
      outcome: 'succeeded',
      correlationId: c.get('requestId'),
      doc: { ...auditDoc(p), ...extra },
      log: c.get('log').child({ subsystem: 'audit' }),
    });
  }

  /** The agent's projects, when more than one serves it; else `undefined` (today's checks). */
  const served = (c: Ctx, agentId: string) =>
    authorizer === undefined
      ? Promise.resolve(undefined)
      : (itemRights?.multi(c, 'agent', agentId) ?? Promise.resolve(undefined));

  /**
   * `undefined` when allowed; else the 403. For an agent more than one
   * project serves, `publish` is `write` where its versions are made and
   * `pin` is `admin` where `scope` is (the module's rules).
   */
  async function deny(c: Ctx, action: Action, agentId: string, scope?: AgentPinScope) {
    if (authorizer === undefined) return undefined;
    const projects = await served(c, agentId);
    if (itemRights !== undefined && projects !== undefined) {
      if (action === 'pin') {
        // A pin scope's check names no version, so the 404 is never answered.
        return itemRights.enforce(c, 'agent', agentId, projects, agentPinScopeCheck(scope), () =>
          failWith(c, suggestedChangeNotFound(c.req.param('suggestedChangeId') ?? '')),
        );
      }
      return writeWhereMade(
        c,
        itemRights,
        { kind: 'agent', id: agentId },
        projects,
        `changing a suggested change for agent "${agentId}"`,
      );
    }
    const decision = await authorizer.check(c, action, ref('agent', agentId));
    if (decision.allowed) return undefined;
    return fail(c, 'permission-denied', {
      code: 'permission-denied',
      message: `Permission denied: this needs ${action} on agent "${agentId}" (${decision.reason})`,
    });
  }

  /** The suggested changes of a page whose agent the caller may read (`item-rights.ts`). */
  async function readableOnPage(c: Ctx, rows: readonly StoredSuggestedChange[]) {
    if (authorizer === undefined) return rows;
    const agentOf = (p: StoredSuggestedChange) => ref('agent', p.agentId as unknown as string);
    return itemRights === undefined
      ? authorizer.filterByCan(c, 'read', rows, agentOf)
      : itemRights.filterItems(c, 'agent', rows, {
          idOf: (p) => p.agentId as unknown as string,
          todayRef: agentOf,
        });
  }

  /** The suggested change, if it exists and the caller may read it (else the 404). */
  async function load(c: Ctx): Promise<StoredSuggestedChange | Response> {
    const suggestedChangeId = c.req.param('suggestedChangeId') ?? '';
    const stored = await store.getSuggestedChange({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChangeId: suggestedChangeId as SuggestedChangeId,
    });
    const hidden = stored !== null && !(await readable(c, stored.agentId as unknown as string));
    if (stored === null || hidden) return failWith(c, suggestedChangeNotFound(suggestedChangeId));
    return stored;
  }

  /** Whether the caller reads the agent: `read` on it, or for one more than one project serves, on any of them. */
  async function readable(c: Ctx, agentId: string): Promise<boolean> {
    if (authorizer === undefined) return true;
    const projects = await served(c, agentId);
    return itemRights !== undefined && projects !== undefined
      ? (await itemRights.read(c, 'agent', agentId, projects)) === undefined
      : authorizer.can(c, 'read', ref('agent', agentId));
  }

  /** Read the body and the suggested change, and check the caller may `action` it. */
  async function prepare(
    c: Ctx,
    action: Action,
  ): Promise<{ body: Record<string, unknown>; suggestedChange: StoredSuggestedChange } | Response> {
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const suggestedChange = await load(c);
    if (suggestedChange instanceof Response) return suggestedChange;
    const denied = await deny(
      c,
      action,
      suggestedChange.agentId as unknown as string,
      suggestedChange.scope,
    );
    return denied ?? { body, suggestedChange };
  }

  /** The suggested change as the wire shows it; `detail` adds its block's content before and after. */
  async function answer(
    c: Ctx,
    stored: StoredSuggestedChange,
    status: 200 | 201 | 202 = 200,
    detail = false,
  ) {
    const f = await service.facts(c.get('tenantId') as TenantId)(stored);
    const before = detail ? await blockBefore(deps.blocks, stored) : undefined;
    c.status(status);
    return c.json(serialize(stored, f, before));
  }

  /** A refusal from the service, as the API answers it. */
  async function refuse(c: Ctx, error: SuggestedChangeServiceError) {
    if (error.code !== 'environment-takes-promotions') return failWith(c, error);
    return environmentTakesPromotionsResponse(
      c,
      c.get('requestId'),
      authorizer,
      { kind: 'suggested-change' },
      {
        firstProjectId: error.firstProjectId as ProjectId,
        position: error.position as number,
      },
    );
  }

  // ---------- GET / ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const status = c.req.query('status');
    if (
      status !== undefined &&
      !SUGGESTED_CHANGE_STATUSES.includes(status as SuggestedChangeStatus)
    ) {
      return badInput(
        c,
        `Unknown \`status\`: ${status} (one of ${SUGGESTED_CHANGE_STATUSES.join(', ')})`,
      );
    }
    const madeBy = c.req.query('madeBy');
    if (madeBy !== undefined && !MAKER_KINDS.includes(madeBy as SuggestedChangeMaker['kind'])) {
      return badInput(c, `Unknown \`madeBy\`: ${madeBy} (one of ${MAKER_KINDS.join(', ')})`);
    }
    const agentId = c.req.query('agentId');
    const projectId = c.req.query('projectId');
    const cursor = c.req.query('cursor');
    const page = await store.listSuggestedChanges({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
      ...(agentId !== undefined && agentId !== '' && { agentId: agentId as AgentId }),
      ...(projectId !== undefined &&
        projectId !== '' && {
          pinnedScope: { kind: 'project', projectId: projectId as ProjectId },
        }),
    });
    const shown = await readableOnPage(c, page.data);
    const read = service.facts(tenantId);
    const rows = await Promise.all(shown.map(async (p) => serialize(p, await read(p))));
    return c.json({
      // The status and madeBy filters apply after deriving, so a page can
      // hold fewer rows than `limit`.
      data: rows.filter(
        (row) =>
          (status === undefined || row.status === status) &&
          (madeBy === undefined || row.madeBy.kind === madeBy),
      ),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:suggestedChangeId ----------
  r.get('/:suggestedChangeId', async (c) => {
    const stored = await load(c);
    if (stored instanceof Response) return stored;
    return answer(c, stored, 200, true);
  });

  // ---------- POST / (a suggested change by hand) ----------
  r.post('/', publishCompiles, async (c) => {
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseCreateBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const denied = await deny(c, 'publish', parsed.agentId);
    if (denied !== undefined) return denied;
    const actor = actorOf(c);
    const outcome = await service.create({
      tenantId: c.get('tenantId') as TenantId,
      agentId: parsed.agentId,
      projectId: parsed.projectId as ProjectId,
      blockId: parsed.blockId,
      content: parsed.content,
      why: parsed.why,
      ...(parsed.fixes !== undefined && { fixes: parsed.fixes }),
      madeBy: makerOf(actor),
      actor,
    });
    if (outcome.kind === 'err') return refuse(c, outcome.error);
    if (outcome.value.deduped) {
      c.header('X-Suggested-Change-Deduped', 'true');
      return answer(c, outcome.value.suggestedChange);
    }
    await audit(c, 'suggested-change-created', outcome.value.suggestedChange);
    return answer(c, outcome.value.suggestedChange, 201);
  });

  // ---------- POST /:suggestedChangeId/check ----------
  r.post('/:suggestedChangeId/check', publishCompiles, async (c) => {
    const ready = await prepare(c, 'publish');
    if (ready instanceof Response) return ready;
    const extra = Object.keys(ready.body);
    if (extra.length > 0) {
      return badInput(
        c,
        `\`${extra[0]}\` isn't a field of a check: it takes none (it runs on the project's test set)`,
      );
    }
    const outcome = await service.check({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChange: ready.suggestedChange,
      actor: actorOf(c),
    });
    if (outcome.kind === 'err') return refuse(c, outcome.error);
    return answer(c, outcome.value, 202);
  });

  // ---------- POST /:suggestedChangeId/pin ----------
  r.post('/:suggestedChangeId/pin', async (c) => {
    const ready = await prepare(c, 'pin');
    if (ready instanceof Response) return ready;
    const spans = await widthRefusal(c, {
      rights: itemRights,
      agentId: ready.suggestedChange.agentId as unknown as string,
      scope: ready.suggestedChange.scope,
    });
    if (spans !== undefined) return spans;
    const body = readPinBody(ready.body);
    if (body.kind === 'err') return badInput(c, body.message);
    const outcome = await service.pin({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChange: ready.suggestedChange,
      actor: actorOf(c),
      ...body.value,
      log: c.get('log'),
    });
    if (outcome.kind === 'err') return refuse(c, outcome.error);
    const { suggestedChange, pin } = outcome.value;
    if (pin.kind !== 'ok') return pinResponse(c, pin, refusedPinExtra(pin, suggestedChange));
    if (pin.pin.status === 'refused') {
      return pinResponse(c, pin, {
        suggestedChangeId: suggestedChange.id as unknown as string,
      });
    }
    return pinned(c, suggestedChange, pin);
  });

  /**
   * A pin the gate let through: recorded, and answered `201` pinned, or
   * `202` while it waits for a second person, as the agent pin route
   * answers it (`pinAnswer`), with the suggested change it pinned.
   */
  async function pinned(
    c: Ctx,
    suggestedChange: StoredSuggestedChange,
    outcome: Extract<PinRequestOutcome, { kind: 'ok' }>,
  ): Promise<Response> {
    const { pin } = outcome;
    const waits = pin.status === 'pending-approval';
    await audit(c, 'suggested-change-pinned', suggestedChange, {
      pinChangeId: pin.id,
      status: waits ? 'waiting-for-second-person' : 'pinned',
    });
    if (!waits) await rebuildOthers(c, suggestedChange);
    const f = await service.facts(c.get('tenantId') as TenantId)(suggestedChange);
    c.status(waits ? 202 : 201);
    return c.json({ ...pinAnswer(outcome), suggestedChange: serialize(suggestedChange, f) });
  }

  /**
   * Its project now runs its version: the project's other suggested
   * changes for the agent are rebuilt on it. One that can't be stays as
   * it was, and the reason is logged.
   */
  async function rebuildOthers(c: Ctx, suggestedChange: StoredSuggestedChange): Promise<void> {
    const { scope } = suggestedChange;
    if (scope.kind !== 'project') return;
    const log = c.get('log');
    try {
      const { failed } = await service.rebuildOthers({
        tenantId: c.get('tenantId') as TenantId,
        agentId: suggestedChange.agentId,
        projectId: scope.projectId,
        actor: actorOf(c),
        except: suggestedChange.id,
      });
      for (const f of failed) {
        log.warn(
          `suggested change ${f.suggestedChangeId as unknown as string} wasn't rebuilt: ${f.message}`,
        );
      }
    } catch (e) {
      log.warn(
        `rebuilding the suggested changes for project ${scope.projectId as unknown as string} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * An add moves Latest only in the card's project: check the new Latest
   * there (`latestMoved`). Without a test set store or the corrections
   * nothing is checked. The add stands either way: a check that can't
   * start is logged, and the next move checks again.
   */
  async function checkLatest(c: Ctx, suggestedChange: StoredSuggestedChange): Promise<void> {
    const { scope } = suggestedChange;
    const { testSets, corrections } = deps;
    if (scope.kind !== 'project' || testSets === undefined || corrections === undefined) return;
    const log = c.get('log');
    try {
      await latestMoved(
        { agentPins: deps.agentPins, testRuns: deps.testRuns, testSets, corrections },
        {
          tenantId: c.get('tenantId') as TenantId,
          agentId: suggestedChange.agentId as unknown as string,
          projects: [scope.projectId],
          log,
        },
      );
    } catch (e) {
      log.warn(
        `checking Latest in project ${scope.projectId as unknown as string} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ---------- POST /:suggestedChangeId/add-as-latest ----------
  r.post('/:suggestedChangeId/add-as-latest', async (c) => {
    const ready = await prepare(c, 'pin');
    if (ready instanceof Response) return ready;
    const spans = await widthRefusal(c, {
      rights: itemRights,
      agentId: ready.suggestedChange.agentId as unknown as string,
      scope: ready.suggestedChange.scope,
    });
    if (spans !== undefined) return spans;
    const reason = optionalText(ready.body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    const outcome = await service.addAsLatest({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChange: ready.suggestedChange,
      actor: actorOf(c),
      ...(reason.value !== undefined && { reason: reason.value }),
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    await audit(c, 'suggested-change-added-as-latest', outcome.value);
    await rebuildOthers(c, outcome.value);
    await checkLatest(c, outcome.value);
    return answer(c, outcome.value);
  });

  // ---------- POST /:suggestedChangeId/withdraw ----------
  r.post('/:suggestedChangeId/withdraw', async (c) => {
    const ready = await prepare(c, 'publish');
    if (ready instanceof Response) return ready;
    const reason = optionalText(ready.body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    if (reason.value === undefined) {
      return badInput(c, '`reason` is required: why it was withdrawn');
    }
    const outcome = await service.withdraw({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChange: ready.suggestedChange,
      actor: actorOf(c),
      reason: reason.value,
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    await audit(c, 'suggested-change-withdrawn', outcome.value);
    return answer(c, outcome.value);
  });

  return r;
}

/**
 * What an audit event names of a suggested change: its id, agent, block
 * (or, for a deploy card, its deployment), versions and who or what made
 * it — never its content, its why or its check's answers.
 */
function auditDoc(p: StoredSuggestedChange): Readonly<Record<string, unknown>> {
  const block = blockChangeOf(p);
  return {
    suggestedChangeId: p.id as unknown as string,
    agentId: p.agentId as unknown as string,
    builtOn: p.builtOnVersion ?? p.fromVersion,
    ...(p.candidate !== undefined && { version: p.candidate.agentVersion }),
    ...(block === undefined
      ? { deploymentId: (p.change as CodeChange).deploymentId }
      : { blockId: block.change.blockId }),
    ...(p.candidate?.blockVersion !== undefined && { blockVersion: p.candidate.blockVersion }),
    madeBy: suggestedChangeMaker(p),
  };
}

// ---------- wire ----------

/** Who made a suggested change through the API: the caller. */
function makerOf(actor: PinActor): SuggestedChangeCreator {
  return actor.kind === 'user'
    ? { kind: 'person', userId: actor.id }
    : { kind: 'service', id: actor.id };
}

/** `user:<id>` or `service:<id>`, as a step records who took it, on the wire (`PinActor`). */
function actorWire(by: string): PinActor {
  const at = by.indexOf(':');
  const kind = at < 0 ? '' : by.slice(0, at);
  return kind === 'user' || kind === 'service'
    ? { kind, id: by.slice(at + 1) }
    : { kind: 'service', id: by };
}

/**
 * The content of the block version a suggested change changes: as it was
 * kept when the change was drafted (`ProposedChange` `before`), else read
 * from that version; `undefined` when it's gone, or for a deploy card,
 * which changes no one block.
 */
async function blockBefore(
  blocks: BlockRegistryBinding,
  p: StoredSuggestedChange,
): Promise<ProposedChange['change']['content'] | undefined> {
  const changed = blockChangeOf(p);
  if (changed === undefined) return undefined;
  if (changed.change.before !== undefined) return changed.change.before;
  const { blockId, fromVersion } = changed.change;
  const block = await blocks.getVersion({ tenantId: p.tenantId, blockId, version: fromVersion });
  if (block === null) return undefined;
  return block.kind === 'settings'
    ? { values: block.content.values as Record<string, unknown> }
    : { template: block.content.template as string };
}

/**
 * Its one change on the wire: the block, from and to, with the content
 * before and after on `GET` of one; or a deploy card's code.
 */
function changeWire(p: StoredSuggestedChange, before?: ProposedChange['change']['content']) {
  const block = blockChangeOf(p);
  if (block === undefined) {
    const { deploymentId, imageDigest } = p.change as CodeChange;
    return {
      kind: 'code' as const,
      deploymentId,
      ...(imageDigest !== undefined && { imageDigest }),
    };
  }
  const { blockId, fromVersion, content } = block.change;
  return {
    kind: 'block' as const,
    blockId,
    from: fromVersion,
    ...(p.candidate?.blockVersion !== undefined && { to: p.candidate.blockVersion }),
    ...(before !== undefined && { before, after: content }),
  };
}

/** The first line of why (no closing stop), cut to fit, then the block's change. */
function titleOf(p: StoredSuggestedChange): string {
  const line = (p.why.split('\n')[0] ?? '').trim().replace(/[.:;,!?]+$/, '');
  const cut = line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH).trimEnd()}…` : line;
  const block = blockChangeOf(p);
  if (block === undefined) {
    const to = p.candidate === undefined ? 'a new version' : `v${p.candidate.agentVersion}`;
    return `${cut}: v${p.builtOnVersion ?? p.fromVersion} → ${to}`;
  }
  const to =
    p.candidate?.blockVersion === undefined ? 'a new version' : `v${p.candidate.blockVersion}`;
  return `${cut}: ${block.change.blockId} v${block.change.fromVersion} → ${to}`;
}

/** A US-dollar amount per conversation: at most four decimals, no trailing zeros. */
function perConversation(cost: NonNullable<SuggestedChangeSide['costUsd']>): string | undefined {
  if (cost.cases === 0) return undefined;
  return (cost.total / cost.cases).toFixed(4).replace(/\.?0+$/, '');
}

function sideWire(testRunId: string, side: SuggestedChangeSide | undefined) {
  if (side === undefined) return { testRunId };
  const cost = side.costUsd === undefined ? undefined : perConversation(side.costUsd);
  return {
    testRunId,
    passing: side.passing,
    of: side.of,
    ...(cost !== undefined && { costPerConversation: cost }),
  };
}

/**
 * The check: `not-started` before one ran, `running` while either run
 * is, `failed` when either failed or can't be read, else `done`.
 */
function checkWire(p: StoredSuggestedChange, f: SuggestedChangeFacts) {
  const stored = p.evaluation;
  if (stored === undefined) return { status: 'not-started' as const };
  const seen = f.evaluation ?? undefined;
  let status: 'running' | 'done' | 'failed';
  if (f.status === 'checking') status = 'running';
  else if (seen === undefined || f.status === 'check-failed') status = 'failed';
  else if (seen.runStatus !== 'completed') status = 'failed';
  else status = 'done';
  const reference = stored.reference;
  return {
    status,
    testSetId: stored.testSetId,
    ...(seen?.testSetVersion !== undefined && { testSetVersion: seen.testSetVersion }),
    ...(reference !== undefined && { now: sideWire(reference.testRunId, seen?.now) }),
    with: sideWire(stored.testRunId, seen?.with),
    ...(seen?.newlyFailing !== undefined && { newlyFailing: seen.newlyFailing }),
    startedAt: stored.startedAt,
  };
}

export function serialize(
  p: StoredSuggestedChange,
  f: SuggestedChangeFacts,
  before?: ProposedChange['change']['content'],
) {
  const pin = f.pin ?? undefined;
  const version = p.candidate?.agentVersion;
  const projectId = p.scope.kind === 'project' ? p.scope.projectId : p.projectId;
  const pinned =
    f.status === 'pinned' && pin !== undefined && version !== undefined
      ? {
          version,
          by: pin.requestedBy,
          at: pin.resolvedAt ?? pin.createdAt,
        }
      : undefined;
  return {
    id: p.id as unknown as string,
    agentId: p.agentId as unknown as string,
    ...(projectId !== undefined && { projectId: projectId as unknown as string }),
    title: titleOf(p),
    madeBy: suggestedChangeMaker(p),
    builtOn: {
      version: p.builtOnVersion ?? p.fromVersion,
      ...(p.rebuiltAt !== undefined && { rebuiltAt: p.rebuiltAt }),
    },
    ...(version !== undefined && { version }),
    changes: [changeWire(p, before)],
    why: p.why,
    fixes: p.evidence?.fixes ?? [],
    check: checkWire(p, f),
    status: f.status,
    ...(f.note !== undefined && { note: f.note }),
    ...(pinned !== undefined && { pinned }),
    ...(f.status === 'waiting-for-second-person' &&
      pin?.approvalId !== undefined && { approvalId: pin.approvalId }),
    ...(p.addedAsLatest !== undefined &&
      version !== undefined && {
        addedAsLatest: {
          version,
          by: actorWire(p.addedAsLatest.by),
          at: p.addedAsLatest.at,
          ...(p.addedAsLatest.reason !== undefined && { reason: p.addedAsLatest.reason }),
        },
      }),
    ...(p.withdrawn !== undefined && {
      withdrawn: {
        by: actorWire(p.withdrawn.by),
        reason: p.withdrawn.reason,
        at: p.withdrawn.at,
      },
    }),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ---------- parsing ----------

interface CreateBody {
  readonly agentId: string;
  readonly projectId: string;
  readonly blockId: string;
  readonly content: ProposedChange['change']['content'];
  readonly why: string;
  readonly fixes?: readonly string[];
}

const CREATE_FIELDS = ['agentId', 'projectId', 'block', 'values', 'template', 'why', 'fixes'];

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT;
}

function parseCreateBody(b: Record<string, unknown>): CreateBody | string {
  const extra = Object.keys(b).find((k) => !CREATE_FIELDS.includes(k));
  if (extra !== undefined) {
    return `\`${extra}\` isn't a field of a suggested change: { agentId, projectId, block, values | template, why, fixes? }`;
  }
  if (!nonEmpty(b.agentId)) return '`agentId` is required';
  if (!nonEmpty(b.projectId)) {
    return "`projectId` is required: the project it's for, whose version it's built on";
  }
  if (!nonEmpty(b.block)) return '`block` is required: the id of the block it changes';
  const values = b.values === undefined ? undefined : obj(b.values);
  if (b.values !== undefined && values === undefined) return '`values` must be an object';
  if (b.template !== undefined && typeof b.template !== 'string') {
    return '`template` must be a string';
  }
  if ((values === undefined) === (b.template === undefined)) {
    return 'Send one of `values` (a settings block) or `template` (a prompt block)';
  }
  if (!nonEmpty(b.why)) return '`why` is required: what the change should fix, and why';
  const fixes = b.fixes;
  const fixesWrong = fixesProblem(fixes);
  if (fixesWrong !== undefined) return fixesWrong;
  return {
    agentId: b.agentId,
    projectId: b.projectId,
    blockId: b.block,
    content: values !== undefined ? { values } : { template: b.template as string },
    why: b.why,
    ...(fixes !== undefined && { fixes: fixes as string[] }),
  };
}

/** Why a new card's `fixes` are refused as sent: not a list of ids, or too long. `undefined` when fine or absent. */
function fixesProblem(fixes: unknown): string | undefined {
  if (fixes === undefined) return undefined;
  if (!(Array.isArray(fixes) && fixes.every((id) => nonEmpty(id)))) {
    return '`fixes` is a list of correction ids';
  }
  if (fixes.length > FIXES_MAX) return `\`fixes\` names at most ${FIXES_MAX} corrections`;
  return undefined;
}

/** A pin's body (`SuggestedChangePinBody`): `reason` and `stopFollowingLatest`, each optional. */
function readPinBody(
  body: Record<string, unknown>,
):
  | { kind: 'ok'; value: { reason?: string; stopFollowingLatest?: true } }
  | { kind: 'err'; message: string } {
  const reason = optionalText(body, 'reason');
  if (reason.kind === 'err') return reason;
  const stop = body.stopFollowingLatest;
  if (stop !== undefined && typeof stop !== 'boolean') {
    return { kind: 'err', message: '`stopFollowingLatest` must be a boolean' };
  }
  return {
    kind: 'ok',
    value: {
      ...(reason.value !== undefined && { reason: reason.value }),
      ...(stop === true && { stopFollowingLatest: true }),
    },
  };
}

/**
 * What a refused pin's error adds: `pin-stops-latest` names the suggested
 * change, as the service's own refusal does (its project went onto Latest
 * after the service asked); others answer as the agent pin route's.
 */
function refusedPinExtra(
  pin: Exclude<PinRequestOutcome, { kind: 'ok' }>,
  suggestedChange: StoredSuggestedChange,
): Readonly<Record<string, unknown>> {
  return pin.kind === 'err' && pin.error.code === 'pin-stops-latest'
    ? { suggestedChangeId: suggestedChange.id as unknown as string }
    : {};
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
): { kind: 'ok'; value?: string } | { kind: 'err'; message: string } {
  const v = body[field];
  if (v === undefined) return { kind: 'ok' };
  return nonEmpty(v)
    ? { kind: 'ok', value: v }
    : {
        kind: 'err',
        message: `\`${field}\` must be a non-empty string (at most ${MAX_TEXT} characters)`,
      };
}

/** The body as an object; `{}` when empty, `undefined` when it isn't a JSON object. */
async function readBody(c: Ctx): Promise<Record<string, unknown> | undefined> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined;
  }
}

// ---------- helpers ----------

function fail(
  c: Ctx,
  code: string,
  error: { code: string; message: string } & Record<string, unknown>,
) {
  c.status(statusFor(code) as never);
  return c.json(toWireError(error, c.get('requestId')));
}

function badInput(c: Ctx, message: string) {
  return fail(c, 'bad-input', { code: 'bad-input', message });
}

function failWith(c: Ctx, error: SuggestedChangeServiceError) {
  return fail(c, error.code, error);
}
