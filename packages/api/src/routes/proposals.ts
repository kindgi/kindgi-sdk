// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import { type Action, ref } from '@kindgi/authz';
import type { Cursor, FixProposalId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { EvalComparison } from '../eval-run-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type ProposalFacts,
  type ProposalService,
  type ProposalServiceDeps,
  type ProposalServiceError,
  createProposalService,
  proposalNotFound,
} from '../proposal-service.js';
import {
  FIX_PROPOSAL_STATUSES,
  type FixProposalStatus,
  type ProposalEvaluationOutcome,
} from '../proposal-status.js';
import type {
  ProposalObjective,
  ProposalTier,
  ProposedChange,
  StoredProposal,
} from '../supervisor-binding.js';
import type { AppEnv } from '../types.js';
import { actorOf, promotionResponse, scopeFromQuery } from './agent-releases.js';
import { parseComparison } from './eval-comparison.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';

/** What the proposal lifecycle runs on besides its own store. */
export type ProposalsRouteDeps = Omit<ProposalServiceDeps, 'store'>;

const TIERS: readonly ProposalTier[] = ['settings-block', 'prompt-block'];
const OBJECTIVES: readonly ProposalObjective[] = ['weightedYesShare', 'weightedPrecisionAtK'];
const MAX_TEXT = 2000;

type Ctx = Context<AppEnv>;

/**
 * Improvement proposals (`/v1/proposals`): a change to one data block an
 * agent version pins (new settings values, or a new prompt template),
 * for one live scope, taken through the same comparison, gate and
 * promotion as any other version (`createProposalService`).
 *
 *   GET  /                 list (statuses derived): by agent, tier, status and live scope
 *   GET  /:id              one
 *   POST /                 a hand-written proposal (a draft)
 *   POST /:id/evaluate     publish the block version and derive the agent
 *                          version (inert until promoted), then compare it
 *                          on a test set (202)
 *   POST /:id/request      a gated promotion of the candidate for the scope
 *                          (201 promoted, 202 in review, 422 gate-failed)
 *   POST /:id/rollback     the scope goes back to what served it before
 *   POST /:id/withdraw     closed by a person
 *
 * Authorized on the proposal's agent: reading is `read`, drafting,
 * evaluating and withdrawing are `publish` (they make versions), and
 * requesting and rolling back are `promote`. A proposal the caller can't
 * read answers 404, as one that doesn't exist.
 */
export function proposalsRouter(
  store: ProposalServiceDeps['store'],
  deps: ProposalsRouteDeps,
  authorizer?: Authorizer,
  mount?: (r: Hono<AppEnv>, service: ProposalService) => void,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const service = createProposalService({ ...deps, store });
  // Routes mounted before `/:proposalId` (an improvement pass's `improve`).
  mount?.(r, service);

  /** `undefined` when allowed; else the 403. */
  async function deny(c: Ctx, action: Action, agentId: string) {
    if (authorizer === undefined) return undefined;
    const decision = await authorizer.check(c, action, ref('agent', agentId));
    if (decision.allowed) return undefined;
    return fail(c, 'permission-denied', {
      code: 'permission-denied',
      message: `Permission denied: this needs ${action} on agent "${agentId}" (${decision.reason})`,
    });
  }

  /** The proposal, if it exists and the caller may read it (else the 404). */
  async function load(c: Ctx): Promise<StoredProposal | Response> {
    const proposalId = c.req.param('proposalId') ?? '';
    const stored = await store.getProposal({
      tenantId: c.get('tenantId') as TenantId,
      proposalId: proposalId as FixProposalId,
    });
    const hidden =
      stored !== null &&
      authorizer !== undefined &&
      !(await authorizer.can(c, 'read', ref('agent', stored.agentId as unknown as string)));
    if (stored === null || hidden) return failWith(c, proposalNotFound(proposalId));
    return stored;
  }

  async function answer(c: Ctx, stored: StoredProposal, status: 200 | 201 | 202 = 200) {
    const f = await service.facts(c.get('tenantId') as TenantId)(stored);
    c.status(status);
    return c.json(serialize(stored, f));
  }

  /** Read the body and the proposal, and check the caller may `action` it. */
  async function prepare(
    c: Ctx,
    action: Action,
  ): Promise<{ body: Record<string, unknown>; proposal: StoredProposal } | Response> {
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const proposal = await load(c);
    if (proposal instanceof Response) return proposal;
    const denied = await deny(c, action, proposal.agentId as unknown as string);
    return denied ?? { body, proposal };
  }

  // ---------- GET / ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const status = c.req.query('status');
    if (status !== undefined && !FIX_PROPOSAL_STATUSES.includes(status as FixProposalStatus)) {
      return badInput(c, `Unknown \`status\`: ${status}`);
    }
    const tier = c.req.query('tier');
    if (tier !== undefined && !TIERS.includes(tier as ProposalTier)) {
      return badInput(c, `Unknown \`tier\`: ${tier} (one of ${TIERS.join(', ')})`);
    }
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, scope.message);
    const agentId = c.req.query('agentId');
    const cursor = c.req.query('cursor');
    const page = await store.listProposals({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
      ...(agentId !== undefined && agentId !== '' && { agentId: agentId as AgentId }),
      ...(tier !== undefined && { tier: tier as ProposalTier }),
      ...(scope.scope !== undefined && { liveScope: scope.scope }),
    });
    const readable =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (p) =>
            ref('agent', p.agentId as unknown as string),
          );
    const read = service.facts(tenantId);
    const rows = await Promise.all(readable.map(async (p) => serialize(p, await read(p))));
    return c.json({
      // A status filter applies after deriving, so a page can hold fewer rows than `limit`.
      data: status === undefined ? rows : rows.filter((row) => row.status === status),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:proposalId ----------
  r.get('/:proposalId', async (c) => {
    const stored = await load(c);
    if (stored instanceof Response) return stored;
    return answer(c, stored);
  });

  // ---------- POST / (a hand-written proposal) ----------
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
      hypothesis: parsed.hypothesis,
      ...(parsed.judgmentIds !== undefined && { evidence: { judgmentIds: parsed.judgmentIds } }),
      drafter: { kind: 'person', by: `${actor.kind}:${actor.id}` },
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    if (outcome.value.deduped) {
      c.header('X-Proposal-Deduped', 'true');
      return answer(c, outcome.value.proposal);
    }
    return answer(c, outcome.value.proposal, 201);
  });

  // ---------- POST /:proposalId/evaluate ----------
  r.post('/:proposalId/evaluate', async (c) => {
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseEvaluateBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const ready = await prepare(c, 'publish');
    if (ready instanceof Response) return ready;
    const outcome = await service.evaluate({
      tenantId: c.get('tenantId') as TenantId,
      proposal: ready.proposal,
      suiteId: parsed.suiteId,
      objective: parsed.objective,
      ...(parsed.comparison !== undefined && { comparison: parsed.comparison }),
      actor: actorOf(c),
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    return answer(c, outcome.value, 202);
  });

  // ---------- POST /:proposalId/request ----------
  r.post('/:proposalId/request', async (c) => {
    const ready = await prepare(c, 'promote');
    if (ready instanceof Response) return ready;
    const reason = optionalText(ready.body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    const outcome = await service.request({
      tenantId: c.get('tenantId') as TenantId,
      proposal: ready.proposal,
      actor: actorOf(c),
      ...(reason.value !== undefined && { reason: reason.value }),
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    const { proposal, promotion } = outcome.value;
    if (promotion.kind !== 'ok') return promotionResponse(c, promotion);
    if (promotion.promotion.status === 'refused') {
      return promotionResponse(c, promotion, { proposalId: proposal.id as unknown as string });
    }
    return answer(c, proposal, promotion.promotion.status === 'pending-approval' ? 202 : 201);
  });

  // ---------- POST /:proposalId/rollback ----------
  r.post('/:proposalId/rollback', async (c) => {
    const ready = await prepare(c, 'promote');
    if (ready instanceof Response) return ready;
    const reason = optionalText(ready.body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    const outcome = await service.rollback({
      tenantId: c.get('tenantId') as TenantId,
      proposal: ready.proposal,
      actor: actorOf(c),
      ...(reason.value !== undefined && { reason: reason.value }),
    });
    if (outcome.kind === 'err') return failWith(c, outcome.error);
    return answer(c, outcome.value);
  });

  // ---------- POST /:proposalId/withdraw ----------
  r.post('/:proposalId/withdraw', async (c) => {
    const ready = await prepare(c, 'publish');
    if (ready instanceof Response) return ready;
    const reason = optionalText(ready.body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    if (reason.value === undefined) {
      return badInput(c, '`reason` is required: why it was withdrawn');
    }
    const outcome = await service.withdraw({
      tenantId: c.get('tenantId') as TenantId,
      proposal: ready.proposal,
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
  stored: NonNullable<StoredProposal['evaluation']>,
  seen: ProposalEvaluationOutcome | null | undefined,
): Record<string, unknown> {
  if (seen === undefined || seen === null) return { ...stored };
  return {
    ...stored,
    runStatus: seen.runStatus,
    ...(seen.baseline !== undefined && { baseline: seen.baseline }),
    ...(seen.candidate !== undefined && { candidate: seen.candidate }),
    ...(seen.delta !== undefined && { delta: seen.delta }),
    ...(seen.spread !== undefined && { spread: seen.spread }),
    ...(seen.cases !== undefined && { cases: seen.cases }),
    ...(seen.better !== undefined && { better: seen.better }),
  };
}

export function serialize(p: StoredProposal, f: ProposalFacts): Record<string, unknown> {
  const promotion = f.promotion ?? undefined;
  return {
    id: p.id as unknown as string,
    agentId: p.agentId as unknown as string,
    fromVersion: p.fromVersion,
    scope: liveScopeToWire(p.scope),
    tier: p.tier,
    change: p.change,
    hypothesis: p.hypothesis,
    ...(p.evidence !== undefined && { evidence: p.evidence }),
    drafter: p.drafter,
    status: f.status,
    ...(p.candidate !== undefined && { candidate: p.candidate }),
    ...(p.evaluation !== undefined && { evaluation: evaluationWire(p.evaluation, f.evaluation) }),
    ...(promotion !== undefined && {
      promotion: {
        id: promotion.id,
        status: promotion.status ?? 'promoted',
        ...(promotion.approvalId !== undefined && { approvalId: promotion.approvalId }),
        ...(f.liveNow !== undefined && { liveNow: f.liveNow }),
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
  readonly scope: StoredProposal['scope'];
  readonly tier: ProposalTier;
  readonly blockId: string;
  readonly content: ProposedChange['change']['content'];
  readonly hypothesis: string;
  readonly judgmentIds?: readonly string[];
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT;
}

function parseContent(tier: ProposalTier, raw: unknown): string | undefined {
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

function parseEvidence(raw: unknown): { judgmentIds?: string[] } | string {
  if (raw === undefined) return {};
  const evidence = obj(raw);
  const ids = evidence?.judgmentIds;
  const valid =
    evidence !== undefined &&
    Object.keys(evidence).every((k) => k === 'judgmentIds') &&
    (ids === undefined || (Array.isArray(ids) && ids.every((id) => nonEmpty(id))));
  if (!valid) return '`evidence` is { judgmentIds?: string[] }';
  return ids === undefined ? {} : { judgmentIds: ids as string[] };
}

function parseCreateBody(b: Record<string, unknown>): CreateBody | string {
  if (!nonEmpty(b.agentId)) return '`agentId` is required';
  if (!nonEmpty(b.fromVersion)) {
    return '`fromVersion` is required: the agent version the change applies to';
  }
  const scope = parseLiveScopeBody(b.scope);
  if (scope.kind === 'err') return scope.message;
  if (!TIERS.includes(b.tier as ProposalTier)) return `\`tier\` must be one of ${TIERS.join(', ')}`;
  const tier = b.tier as ProposalTier;
  const change = obj(b.change);
  if (change === undefined) return '`change` must be an object: { blockId, content }';
  if (!nonEmpty(change.blockId)) return '`change.blockId` is required';
  const contentProblem = parseContent(tier, change.content);
  if (contentProblem !== undefined) return contentProblem;
  if (!nonEmpty(b.hypothesis)) {
    return '`hypothesis` is required: what the change should improve, and why';
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
    hypothesis: b.hypothesis,
    ...evidence,
  };
}

interface EvaluateBody {
  readonly suiteId: string;
  readonly objective: ProposalObjective;
  readonly comparison?: EvalComparison;
}

function parseEvaluateBody(b: Record<string, unknown>): EvaluateBody | string {
  if (!nonEmpty(b.suiteId)) {
    return '`suiteId` is required: the test set (a judged eval suite) to compare on';
  }
  if (b.objective !== undefined && !OBJECTIVES.includes(b.objective as ProposalObjective)) {
    return `\`objective\` must be one of ${OBJECTIVES.join(', ')}`;
  }
  const extra = Object.keys(b).filter(
    (k) =>
      !['suiteId', 'objective', 'reads', 'repetitions', 'k', 'classWeights', 'sample'].includes(k),
  );
  if (extra.length > 0) {
    return `\`${extra[0]}\` isn't a field of an evaluation: { suiteId, objective?, reads?, repetitions?, k?, classWeights?, sample? }`;
  }
  const comparison = parseComparison(b);
  if (comparison.kind === 'err') return comparison.message;
  return {
    suiteId: b.suiteId,
    objective: (b.objective as ProposalObjective | undefined) ?? 'weightedYesShare',
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

function failWith(c: Ctx, error: ProposalServiceError) {
  return fail(c, error.code, error);
}
