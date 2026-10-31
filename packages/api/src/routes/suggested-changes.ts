// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import { type Action, ref } from '@kindgi/authz';
import type { AgentPinScope, Cursor, SuggestedChangeId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import {
  type ItemRights,
  agentPinScopeCheck,
  widthRefusal,
  writeWhereMade,
} from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import {
  type SuggestedChangeFacts,
  type SuggestedChangeServiceDeps,
  type SuggestedChangeServiceError,
  createSuggestedChangeService,
  suggestedChangeNotFound,
} from '../suggested-change-service.js';
import {
  SUGGESTED_CHANGE_STATUSES,
  type SuggestedChangeEvaluationOutcome,
  type SuggestedChangeStatus,
} from '../suggested-change-status.js';
import type {
  ProposedChange,
  StoredSuggestedChange,
  SuggestedChangeObjective,
  SuggestedChangeTier,
} from '../supervisor-binding.js';
import type { TestRunComparison } from '../test-run-binding.js';
import type { AppEnv } from '../types.js';
import { agentPinScopeToWire, parseAgentPinScopeBody } from './agent-pin-scope-wire.js';
import { actorOf, pinResponse, scopeFromQuery } from './agent-pins.js';
import { parseComparison } from './eval-comparison.js';
import { clampLimit } from './pagination.js';

/** What the suggested change lifecycle runs on besides its own store. */
export type SuggestedChangesRouteDeps = Omit<SuggestedChangeServiceDeps, 'store'>;

const TIERS: readonly SuggestedChangeTier[] = ['settings-block', 'prompt-block'];
const OBJECTIVES: readonly SuggestedChangeObjective[] = ['passRate', 'weightedPrecisionAtK'];
const MAX_TEXT = 2000;

type Ctx = Context<AppEnv>;

/**
 * suggested changes (`/v1/suggested-changes`): a change to one data block an
 * agent version pins (new settings values, or a new prompt template),
 * for one pin scope, taken through the same comparison, gate and
 * pin as any other version (`createSuggestedChangeService`).
 *
 *   GET  /                 list (statuses derived): by agent, tier, status and pin scope
 *   GET  /:id              one
 *   POST /                 a hand-written suggested change (a draft)
 *   POST /:id/evaluate     publish the block version and derive the agent
 *                          version (inert until pinned), then compare it
 *                          on a test set (202)
 *   POST /:id/rescore      the latest evaluation scored again, with what
 *                          people corrected on its replays since (202)
 *   POST /:id/pin          a gated pin of the candidate for the scope
 *                          (201 pinned, 202 in review, 422 gate-failed)
 *   POST /:id/withdraw     closed by a person
 *
 * Authorized on the suggested change's agent: reading is `read`, drafting,
 * evaluating, rescoring and withdrawing are `publish`, and
 * pinning is `pin`. A suggested change the caller can't
 * read answers 404, as one that doesn't exist.
 *
 * For an agent more than one project serves (`item-rights.ts`): reading
 * is `read` on the agent or on any of its projects; drafting, evaluating,
 * rescoring and withdrawing are `write` where its new versions are made;
 * pinning is `admin` where the scope is (each of the
 * agent's projects, for the tenant's or an org's).
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
  const service = createSuggestedChangeService({ ...deps, store });

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

  async function answer(c: Ctx, stored: StoredSuggestedChange, status: 200 | 201 | 202 = 200) {
    const f = await service.facts(c.get('tenantId') as TenantId)(stored);
    c.status(status);
    return c.json(serialize(stored, f));
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

  // ---------- GET / ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const status = c.req.query('status');
    if (
      status !== undefined &&
      !SUGGESTED_CHANGE_STATUSES.includes(status as SuggestedChangeStatus)
    ) {
      return badInput(c, `Unknown \`status\`: ${status}`);
    }
    const tier = c.req.query('tier');
    if (tier !== undefined && !TIERS.includes(tier as SuggestedChangeTier)) {
      return badInput(c, `Unknown \`tier\`: ${tier} (one of ${TIERS.join(', ')})`);
    }
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, scope.message);
    const agentId = c.req.query('agentId');
    const cursor = c.req.query('cursor');
    const page = await store.listSuggestedChanges({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
      ...(agentId !== undefined && agentId !== '' && { agentId: agentId as AgentId }),
      ...(tier !== undefined && { tier: tier as SuggestedChangeTier }),
      ...(scope.scope !== undefined && { pinnedScope: scope.scope }),
    });
    const shown = await readableOnPage(c, page.data);
    const read = service.facts(tenantId);
    const rows = await Promise.all(shown.map(async (p) => serialize(p, await read(p))));
    return c.json({
      // A status filter applies after deriving, so a page can hold fewer rows than `limit`.
      data: status === undefined ? rows : rows.filter((row) => row.status === status),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:suggestedChangeId ----------
  r.get('/:suggestedChangeId', async (c) => {
    const stored = await load(c);
    if (stored instanceof Response) return stored;
    return answer(c, stored);
  });

  // ---------- POST / (a hand-written suggested change) ----------
  r.post('/', async (c) => {
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseCreateBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const denied = await deny(c, 'publish', parsed.agentId);
    if (denied !== undefined) return denied;
    const actor = actorOf(c);
    const outcome = await service.draft({
      tenantId: c.get('tenantId') as TenantId,
      agentId: parsed.agentId,
      fromVersion: parsed.fromVersion,
      scope: parsed.scope,
      tier: parsed.tier,
      blockId: parsed.blockId,
      content: parsed.content,
      why: parsed.why,
      ...(parsed.fixes !== undefined && { evidence: { fixes: parsed.fixes } }),
      drafter: { kind: 'person', by: `${actor.kind}:${actor.id}` },
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    if (outcome.value.deduped) {
      c.header('X-Suggested-Change-Deduped', 'true');
      return answer(c, outcome.value.suggestedChange);
    }
    return answer(c, outcome.value.suggestedChange, 201);
  });

  // ---------- POST /:suggestedChangeId/evaluate ----------
  r.post('/:suggestedChangeId/evaluate', publishCompiles, async (c) => {
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseEvaluateBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const ready = await prepare(c, 'publish');
    if (ready instanceof Response) return ready;
    const outcome = await service.evaluate({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChange: ready.suggestedChange,
      testSetId: parsed.testSetId,
      objective: parsed.objective,
      ...(parsed.comparison !== undefined && { comparison: parsed.comparison }),
      actor: actorOf(c),
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    return answer(c, outcome.value, 202);
  });

  // ---------- POST /:suggestedChangeId/rescore ----------
  // The latest evaluation scored again, with what people corrected on its
  // replays since; the new test run becomes the suggested change's evaluation.
  r.post('/:suggestedChangeId/rescore', async (c) => {
    const ready = await prepare(c, 'publish');
    if (ready instanceof Response) return ready;
    const extra = Object.keys(ready.body);
    if (extra.length > 0) {
      return badInput(
        c,
        `\`${extra[0]}\` isn't a field of a rescore: it takes none (the latest evaluation's test set version and settings)`,
      );
    }
    const outcome = await service.rescore({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChange: ready.suggestedChange,
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
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
    const reason = optionalText(ready.body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    const outcome = await service.pin({
      tenantId: c.get('tenantId') as TenantId,
      suggestedChange: ready.suggestedChange,
      actor: actorOf(c),
      ...(reason.value !== undefined && { reason: reason.value }),
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    const { suggestedChange, pin } = outcome.value;
    if (pin.kind !== 'ok') return pinResponse(c, pin);
    if (pin.pin.status === 'refused') {
      return pinResponse(c, pin, {
        suggestedChangeId: suggestedChange.id as unknown as string,
      });
    }
    return answer(c, suggestedChange, pin.pin.status === 'pending-approval' ? 202 : 201);
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
    return answer(c, outcome.value);
  });

  return r;
}

// ---------- wire ----------

function evaluationWire(
  stored: NonNullable<StoredSuggestedChange['evaluation']>,
  seen: SuggestedChangeEvaluationOutcome | null | undefined,
): Record<string, unknown> {
  // The reference run it's held to stays the runtime's: what it found is
  // `costUsd` and `decisions`.
  const recorded = {
    testRunId: stored.testRunId,
    testSetId: stored.testSetId,
    objective: stored.objective,
    startedAt: stored.startedAt,
    ...(stored.rule !== undefined && { rule: stored.rule }),
  };
  if (seen === undefined || seen === null) return recorded;
  return {
    ...recorded,
    runStatus: seen.runStatus,
    ...(seen.baseline !== undefined && { baseline: seen.baseline }),
    ...(seen.candidate !== undefined && { candidate: seen.candidate }),
    ...(seen.delta !== undefined && { delta: seen.delta }),
    ...(seen.spread !== undefined && { spread: seen.spread }),
    ...(seen.cases !== undefined && { cases: seen.cases }),
    ...(seen.better !== undefined && { better: seen.better }),
    ...(seen.costUsd !== undefined && { costUsd: seen.costUsd }),
    ...(seen.decisions !== undefined && { decisions: seen.decisions }),
  };
}

export function serialize(
  p: StoredSuggestedChange,
  f: SuggestedChangeFacts,
): Record<string, unknown> {
  const pin = f.pin ?? undefined;
  return {
    id: p.id as unknown as string,
    agentId: p.agentId as unknown as string,
    fromVersion: p.fromVersion,
    scope: agentPinScopeToWire(p.scope),
    tier: p.tier,
    change: p.change,
    why: p.why,
    ...(p.evidence !== undefined && { evidence: p.evidence }),
    madeBy: p.drafter,
    status: f.status,
    ...(p.candidate !== undefined && { candidate: p.candidate }),
    ...(p.evaluation !== undefined && { evaluation: evaluationWire(p.evaluation, f.evaluation) }),
    ...(pin !== undefined && {
      pin: {
        id: pin.id,
        status: pin.status ?? 'pinned',
        ...(pin.approvalId !== undefined && { approvalId: pin.approvalId }),
        ...(f.pinnedNow !== undefined && { pinnedNow: f.pinnedNow }),
      },
    }),
    ...(p.rolledBack !== undefined && { rolledBack: p.rolledBack }),
    ...(p.withdrawn !== undefined && { withdrawn: p.withdrawn }),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ---------- parsing ----------

interface CreateBody {
  readonly agentId: string;
  readonly fromVersion: string;
  readonly scope: StoredSuggestedChange['scope'];
  readonly tier: SuggestedChangeTier;
  readonly blockId: string;
  readonly content: ProposedChange['change']['content'];
  readonly why: string;
  readonly fixes?: readonly string[];
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT;
}

function parseContent(tier: SuggestedChangeTier, raw: unknown): string | undefined {
  const content = obj(raw);
  const keys = content === undefined ? [] : Object.keys(content);
  if (tier === 'settings-block') {
    return content !== undefined && obj(content.values) !== undefined && keys.length === 1
      ? undefined
      : '`change.content` for a settings block is { values: { … } } (the schema carries over)';
  }
  return content !== undefined && typeof content.template === 'string' && keys.length === 1
    ? undefined
    : '`change.content` for a prompt block is { template } (the parameters carry over)';
}

function parseEvidence(raw: unknown): { fixes?: string[] } | string {
  if (raw === undefined) return {};
  const evidence = obj(raw);
  const ids = evidence?.fixes;
  const valid =
    evidence !== undefined &&
    Object.keys(evidence).every((k) => k === 'fixes') &&
    (ids === undefined || (Array.isArray(ids) && ids.every((id) => nonEmpty(id))));
  if (!valid) return '`evidence` is { fixes?: string[] }';
  return ids === undefined ? {} : { fixes: ids as string[] };
}

function parseCreateBody(b: Record<string, unknown>): CreateBody | string {
  if (!nonEmpty(b.agentId)) return '`agentId` is required';
  if (!nonEmpty(b.fromVersion)) {
    return '`fromVersion` is required: the agent version the change applies to';
  }
  const scope = parseAgentPinScopeBody(b.scope);
  if (scope.kind === 'err') return scope.message;
  if (!TIERS.includes(b.tier as SuggestedChangeTier))
    return `\`tier\` must be one of ${TIERS.join(', ')}`;
  const tier = b.tier as SuggestedChangeTier;
  const change = obj(b.change);
  if (change === undefined) return '`change` must be an object: { blockId, content }';
  if (!nonEmpty(change.blockId)) return '`change.blockId` is required';
  const contentProblem = parseContent(tier, change.content);
  if (contentProblem !== undefined) return contentProblem;
  if (!nonEmpty(b.why)) {
    return '`why` is required: what the change should improve, and why';
  }
  const evidence = parseEvidence(b.evidence);
  if (typeof evidence === 'string') return evidence;
  return {
    agentId: b.agentId,
    fromVersion: b.fromVersion,
    scope: scope.scope,
    tier,
    blockId: change.blockId,
    content: change.content as ProposedChange['change']['content'],
    why: b.why,
    ...evidence,
  };
}

interface EvaluateBody {
  readonly testSetId: string;
  readonly objective: SuggestedChangeObjective;
  readonly comparison?: TestRunComparison;
}

function parseEvaluateBody(b: Record<string, unknown>): EvaluateBody | string {
  if (!nonEmpty(b.testSetId)) {
    return '`testSetId` is required: the test set (a corrections test set) to compare on';
  }
  if (b.objective !== undefined && !OBJECTIVES.includes(b.objective as SuggestedChangeObjective)) {
    return `\`objective\` must be one of ${OBJECTIVES.join(', ')}`;
  }
  const extra = Object.keys(b).filter(
    (k) =>
      !['testSetId', 'objective', 'reads', 'repetitions', 'k', 'groupWeights', 'sample'].includes(
        k,
      ),
  );
  if (extra.length > 0) {
    return `\`${extra[0]}\` isn't a field of an evaluation: { testSetId, objective?, reads?, repetitions?, k?, groupWeights?, sample? }`;
  }
  const comparison = parseComparison(b);
  if (comparison.kind === 'err') return comparison.message;
  return {
    testSetId: b.testSetId,
    objective: (b.objective as SuggestedChangeObjective | undefined) ?? 'passRate',
    ...(comparison.value !== undefined && { comparison: comparison.value }),
  };
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
