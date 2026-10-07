// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { type Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import { type Action, ref, tuplesForCreate } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import { canonicalize } from '@kindgi/schema';
import type {
  Cursor,
  FixProposalId,
  RunId,
  Semver,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from '../agent-binding.js';
import type { BlockRecord, BlockRegistryBinding } from '../block-binding.js';
import { type BlockEdit, blockEditDefinition, publishBlockEdit } from '../block-publish.js';
import { deriveAgentVersion } from '../derive-agent-version.js';
import { statusFor, toWireError } from '../errors.js';
import type { EvalComparison, EvalRunBinding, EvalRunStartOutcome } from '../eval-run-binding.js';
import type { AgentReleaseBindings, LivePin, Promotion } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  FIX_PROPOSAL_STATUSES,
  type FixProposalStatus,
  PROPOSAL_ACTIONS,
  type ProposalAction,
  type ProposalEvaluationOutcome,
  evaluationOutcome,
  proposalActionAllowed,
  proposalStatus,
} from '../proposal-status.js';
import { refuseReadOnly } from '../registry-read-only.js';
import type {
  ProposalObjective,
  ProposalStep,
  ProposalTier,
  ProposedChange,
  StoredProposal,
  SupervisorBinding,
} from '../supervisor-binding.js';
import type { AppEnv } from '../types.js';
import { actorOf, promotionResponse, requestPromotion, scopeFromQuery } from './agent-releases.js';
import { parseComparison } from './eval-comparison.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';

/** What the proposal lifecycle runs on besides its own store. */
export interface ProposalsRouteDeps {
  readonly agents: AgentRegistryBinding;
  readonly blocks: BlockRegistryBinding;
  readonly evalRuns: EvalRunBinding;
  readonly releases: AgentReleaseBindings;
  readonly projects?: ProjectBinding;
}

const TIERS: readonly ProposalTier[] = ['settings-block', 'prompt-block'];
const OBJECTIVES: readonly ProposalObjective[] = ['weightedYesShare', 'weightedPrecisionAtK'];
const MAX_TEXT = 2000;

type Ctx = Context<AppEnv>;

/**
 * Improvement proposals (`/v1/proposals`): a change to one data block an
 * agent version pins (new settings values, or a new prompt template),
 * for one live scope, taken through the same comparison, gate and
 * promotion as any other version.
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
  binding: SupervisorBinding,
  deps: ProposalsRouteDeps,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const facts = factsReader(deps);

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
    const stored = await binding.getProposal({
      tenantId: c.get('tenantId') as TenantId,
      proposalId: proposalId as FixProposalId,
    });
    if (stored === null) return notFound(c, proposalId);
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'read', ref('agent', stored.agentId as unknown as string)))
    ) {
      return notFound(c, proposalId);
    }
    return stored;
  }

  /** Record a step; 409 when another call recorded one first. */
  async function record(
    c: Ctx,
    stored: StoredProposal,
    step: ProposalStep,
  ): Promise<StoredProposal | Response> {
    const outcome = await binding.recordProposal({
      tenantId: c.get('tenantId') as TenantId,
      proposalId: stored.id,
      expectRevision: stored.revision,
      step,
    });
    if (outcome.kind === 'ok') return outcome.proposal;
    if (outcome.kind === 'not-found') return notFound(c, stored.id as unknown as string);
    return fail(c, 'proposal-invalid-state-transition', {
      code: 'proposal-invalid-state-transition',
      message: `Proposal ${stored.id as unknown as string} changed while this ran: read it again`,
      proposalId: stored.id as unknown as string,
    });
  }

  async function answer(c: Ctx, stored: StoredProposal, status: 200 | 201 | 202 = 200) {
    const f = await facts.forRequest(c.get('tenantId') as TenantId)(stored);
    c.status(status);
    return c.json(serialize(stored, f));
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
    const page = await binding.listProposals({
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
    const read = facts.forRequest(tenantId);
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
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseCreateBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const denied = await deny(c, 'publish', parsed.agentId);
    if (denied !== undefined) return denied;

    const from = await deps.agents.getVersion({
      tenantId,
      agentId: parsed.agentId as AgentId,
      version: parsed.fromVersion as Semver,
    });
    if (from === null || from.unregisteredAt !== undefined) {
      return fail(c, 'agent-version-not-found', {
        code: 'agent-version-not-found',
        message: `${parsed.agentId} has no active version ${parsed.fromVersion}`,
      });
    }
    const pinned = await pinnedBlock(deps.blocks, tenantId, from, parsed.tier, parsed.blockId);
    if (pinned.kind === 'invalid') return validationFailed(c, pinned.message, pinned.issues);
    const edit = editOf(parsed.tier, parsed.content);
    const checked = await blockEditDefinition(
      { blocks: deps.blocks, tenantId, from: pinned.block, edit },
      pinned.block.version,
    );
    if (checked.kind === 'invalid') {
      return validationFailed(
        c,
        `The new content isn't a valid version of block "${parsed.blockId}"`,
        checked.issues,
      );
    }
    if (sameContent(pinned.block, edit)) {
      return validationFailed(c, `The proposal doesn't change block "${parsed.blockId}"`, [
        {
          path: '/change/content',
          message: `equals version ${pinned.block.version}, which ${parsed.fromVersion} pins`,
        },
      ]);
    }
    const change = {
      blockId: parsed.blockId,
      fromVersion: pinned.block.version,
      content: parsed.content,
    } as ProposedChange['change'];
    const outcome = await binding.createProposal({
      tenantId,
      ...(from.projectId !== undefined && { projectId: from.projectId }),
      agentId: parsed.agentId as AgentId,
      fromVersion: parsed.fromVersion,
      scope: parsed.scope,
      tier: parsed.tier,
      change,
      hypothesis: parsed.hypothesis,
      ...(parsed.judgmentIds !== undefined && { evidence: { judgmentIds: parsed.judgmentIds } }),
      drafter: { kind: 'person', by: who(c) },
      fingerprint: fingerprintOf(parsed, change),
    });
    if (outcome.kind === 'dedup') {
      c.header('X-Proposal-Deduped', 'true');
      return answer(c, outcome.proposal);
    }
    return answer(c, outcome.proposal, 201);
  });

  // ---------- POST /:proposalId/evaluate ----------
  r.post('/:proposalId/evaluate', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseEvaluateBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const loaded = await load(c);
    if (loaded instanceof Response) return loaded;
    let stored = loaded;
    const agentId = stored.agentId as unknown as string;
    const denied = await deny(c, 'publish', agentId);
    if (denied !== undefined) return denied;
    const refused = refuseStatus(c, 'evaluate', stored, await facts.forRequest(tenantId)(stored));
    if (refused !== undefined) return refused;

    // Evaluating derives an agent version: not into a registry that takes no writes.
    if (deps.agents.readOnly !== undefined) return refuseReadOnly(c, deps.agents.readOnly);
    // A version promoted nowhere is still the agent's latest, and the
    // latest serves every scope nothing is pinned for.
    const tenantPin = await deps.releases.live.resolve({ tenantId, agentId });
    if (tenantPin === null) {
      return fail(c, 'proposal-needs-pin', {
        code: 'proposal-needs-pin',
        message: `${agentId} has no live version for the whole tenant, so a new version of it would serve every scope nothing is pinned for. Promote its current version for the tenant first (scope { "kind": "tenant" }), then evaluate.`,
      });
    }

    if (stored.candidate === undefined) {
      const made = await makeCandidate(c, stored);
      if (made instanceof Response) return made;
      const recorded = await record(c, stored, { kind: 'candidate', candidate: made });
      if (recorded instanceof Response) return recorded;
      stored = recorded;
    }
    const candidate = stored.candidate;
    if (candidate === undefined) throw new Error('a recorded candidate is on the proposal');
    const version = await deps.agents.getVersion({
      tenantId,
      agentId: stored.agentId,
      version: candidate.agentVersion as Semver,
    });
    if (
      version === null ||
      version.unregisteredAt !== undefined ||
      version.projectId === undefined
    ) {
      return fail(c, 'agent-version-not-found', {
        code: 'agent-version-not-found',
        message: `The candidate ${agentId} ${candidate.agentVersion} is unregistered: withdraw this proposal and draft it again`,
      });
    }
    const started = await deps.evalRuns.start({
      tenantId,
      projectId: version.projectId,
      suiteId: parsed.suiteId,
      agentRef: { agentId: stored.agentId, version: candidate.agentVersion as Semver },
      correlationId: `proposal:${stored.id as unknown as string}`,
      ...(parsed.comparison !== undefined && { comparison: parsed.comparison }),
    });
    if (started.kind !== 'ok') return startFailed(c, started);
    const evaluated = await record(c, stored, {
      kind: 'evaluation',
      evaluation: {
        evalRunId: started.runId as unknown as string,
        suiteId: parsed.suiteId,
        objective: parsed.objective,
        startedAt: new Date().toISOString() as Timestamp,
      },
    });
    if (evaluated instanceof Response) return evaluated;
    return answer(c, evaluated, 202);
  });

  // ---------- POST /:proposalId/request ----------
  r.post('/:proposalId/request', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const reason = optionalText(body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    const stored = await load(c);
    if (stored instanceof Response) return stored;
    const denied = await deny(c, 'promote', stored.agentId as unknown as string);
    if (denied !== undefined) return denied;
    const refused = refuseStatus(c, 'request', stored, await facts.forRequest(tenantId)(stored));
    if (refused !== undefined) return refused;
    const { candidate, evaluation } = stored;
    if (candidate === undefined || evaluation === undefined) {
      throw new Error('an evaluated proposal has a candidate and an evaluation');
    }
    const outcome = await requestPromotion(
      deps.agents,
      deps.releases,
      { evalRuns: deps.evalRuns, ...(deps.projects !== undefined && { projects: deps.projects }) },
      {
        tenantId,
        agentId: stored.agentId as unknown as string,
        version: candidate.agentVersion as Semver,
        scope: stored.scope,
        requestedBy: actorOf(c),
        reason: reason.value ?? `Improvement proposal ${stored.id as unknown as string}`,
        evalRunId: evaluation.evalRunId,
      },
    );
    if (outcome.kind !== 'ok') return promotionResponse(c, outcome);
    const recorded = await record(c, stored, {
      kind: 'promotion',
      promotionId: outcome.promotion.id,
    });
    if (recorded instanceof Response) return recorded;
    if (outcome.promotion.status === 'refused') {
      return promotionResponse(c, outcome, { proposalId: stored.id as unknown as string });
    }
    return answer(c, recorded, outcome.promotion.status === 'pending-approval' ? 202 : 201);
  });

  // ---------- POST /:proposalId/rollback ----------
  r.post('/:proposalId/rollback', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const reason = optionalText(body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    const stored = await load(c);
    if (stored instanceof Response) return stored;
    const agentId = stored.agentId as unknown as string;
    const denied = await deny(c, 'promote', agentId);
    if (denied !== undefined) return denied;
    const seen = await facts.forRequest(tenantId)(stored);
    const refused = refuseStatus(c, 'rollback', stored, seen);
    if (refused !== undefined) return refused;
    const promotion = seen.promotion;
    if (promotion === null || promotion === undefined || seen.liveNow !== true) {
      return invalidTransition(
        c,
        stored,
        seen.status,
        "its version doesn't serve the scope anymore (the scope was promoted, rolled back or unpinned since), so there's nothing of it to roll back.",
      );
    }
    const input = {
      tenantId,
      agentId,
      scope: stored.scope,
      requestedBy: actorOf(c),
      reason: reason.value ?? `Rolled back improvement proposal ${stored.id as unknown as string}`,
    };
    // Back to the scope's own pin before; with none, it falls back to the scope above.
    const outcome =
      promotion.fromVersion === null
        ? await deps.releases.promotions.unpin(input)
        : await deps.releases.promotions.rollback({ ...input, toVersion: promotion.fromVersion });
    if (outcome.kind === 'err') return fail(c, outcome.error.code, { ...outcome.error });
    const recorded = await record(c, stored, {
      kind: 'rolled-back',
      rolledBack: {
        at: new Date().toISOString() as Timestamp,
        promotionId: outcome.value.id,
        by: who(c),
        ...(reason.value !== undefined && { reason: reason.value }),
      },
    });
    if (recorded instanceof Response) return recorded;
    return answer(c, recorded);
  });

  // ---------- POST /:proposalId/withdraw ----------
  r.post('/:proposalId/withdraw', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const reason = optionalText(body, 'reason');
    if (reason.kind === 'err') return badInput(c, reason.message);
    if (reason.value === undefined)
      return badInput(c, '`reason` is required: why it was withdrawn');
    const stored = await load(c);
    if (stored instanceof Response) return stored;
    const denied = await deny(c, 'publish', stored.agentId as unknown as string);
    if (denied !== undefined) return denied;
    const refused = refuseStatus(c, 'withdraw', stored, await facts.forRequest(tenantId)(stored));
    if (refused !== undefined) return refused;
    const recorded = await record(c, stored, {
      kind: 'withdrawn',
      withdrawn: { at: new Date().toISOString() as Timestamp, by: who(c), reason: reason.value },
    });
    if (recorded instanceof Response) return recorded;
    return answer(c, recorded);
  });

  /** Publish the block version and derive the agent version a proposal is evaluated as. */
  async function makeCandidate(
    c: Ctx,
    stored: StoredProposal,
  ): Promise<NonNullable<StoredProposal['candidate']> | Response> {
    const tenantId = c.get('tenantId') as TenantId;
    const { blockId, fromVersion } = stored.change;
    const from = await deps.blocks.getVersion({ tenantId, blockId, version: fromVersion });
    if (from === null) {
      return validationFailed(c, `Block "${blockId}" version ${fromVersion} is gone`, []);
    }
    const published = await publishBlockEdit({
      blocks: deps.blocks,
      tenantId,
      from,
      edit: editOf(stored.tier, stored.change.content),
    });
    if (published.kind === 'invalid') {
      return validationFailed(
        c,
        `The proposal's content can't be published as block "${blockId}"`,
        published.issues,
      );
    }
    const pinKind = stored.tier === 'settings-block' ? 'settings' : 'prompts';
    const userId = userOf(c);
    const derived = await deriveAgentVersion({
      agents: deps.agents,
      blocks: deps.blocks,
      tenantId,
      agentId: stored.agentId,
      from: stored.fromVersion,
      swaps: { [pinKind]: { [blockId]: published.version } },
      label: `proposal ${stored.id as unknown as string}`,
      by: who(c),
      proposalId: stored.id as unknown as string,
      tuplesFor: (projectId) => (id) =>
        tuplesForCreate(
          { kind: 'agent', id: id as AgentId, tenantId, projectId },
          userId ?? ('00000000-0000-0000-0000-000000000000' as UserId),
        ),
    });
    if (derived.kind !== 'ok' && derived.kind !== 'reused') {
      return validationFailed(
        c,
        derived.kind === 'invalid'
          ? `Can't derive a version from ${stored.fromVersion}`
          : `Can't derive a version from ${stored.fromVersion} (${derived.kind})`,
        derived.kind === 'invalid' ? derived.issues : [],
      );
    }
    const { agent } = derived;
    if (agent.pinsDigest === undefined) throw new Error('a derived version is pinned');
    return {
      agentVersion: agent.version as unknown as string,
      blockVersion: published.version,
      pinsDigest: agent.pinsDigest,
    };
  }

  return r;
}

// ---------- derived facts ----------

/** What a proposal's ids resolve to now, and the status that follows. */
export interface ProposalFacts {
  readonly status: FixProposalStatus;
  readonly evaluation?: ProposalEvaluationOutcome | null;
  readonly promotion?: Promotion | null;
  /** For a promoted proposal: whether its version still serves the scope. */
  readonly liveNow?: boolean;
}

function factsReader(deps: ProposalsRouteDeps) {
  return {
    /** A reader for one request: each agent's pins are read once. */
    forRequest(tenantId: TenantId) {
      const pins = new Map<string, Promise<readonly LivePin[]>>();
      const pinsOf = (agentId: string): Promise<readonly LivePin[]> => {
        const known = pins.get(agentId);
        if (known !== undefined) return known;
        const found = deps.releases.live.list({ tenantId, agentId });
        pins.set(agentId, found);
        return found;
      };
      return async (p: StoredProposal): Promise<ProposalFacts> => {
        const promotion =
          p.promotionId === undefined
            ? undefined
            : await deps.releases.promotions.get(tenantId, p.promotionId);
        let evaluation: ProposalEvaluationOutcome | null | undefined;
        if (p.evaluation !== undefined) {
          const run = await deps.evalRuns.get({
            tenantId,
            runId: p.evaluation.evalRunId as RunId,
          });
          evaluation = run === null ? null : evaluationOutcome(p.evaluation.objective, run);
        }
        const status = proposalStatus(p, promotion, evaluation);
        let liveNow: boolean | undefined;
        if (status === 'promoted' && promotion !== undefined && promotion !== null) {
          const all = await pinsOf(p.agentId as unknown as string);
          liveNow = all.some((pin) => pin.promotionId === promotion.id);
        }
        return {
          status,
          ...(evaluation !== undefined && { evaluation }),
          ...(promotion !== undefined && { promotion }),
          ...(liveNow !== undefined && { liveNow }),
        };
      };
    },
  };
}

/** 409 unless the proposal's status allows `action`. */
function refuseStatus(c: Ctx, action: ProposalAction, stored: StoredProposal, f: ProposalFacts) {
  if (proposalActionAllowed(action, f.status)) return undefined;
  return invalidTransition(
    c,
    stored,
    f.status,
    `it's ${f.status}, and ${action} needs one of: ${PROPOSAL_ACTIONS[action].join(', ')}.`,
  );
}

function invalidTransition(c: Ctx, stored: StoredProposal, status: FixProposalStatus, why: string) {
  return fail(c, 'proposal-invalid-state-transition', {
    code: 'proposal-invalid-state-transition',
    message: `Proposal ${stored.id as unknown as string}: ${why}`,
    proposalId: stored.id as unknown as string,
    status,
  });
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

// ---------- blocks ----------

function editOf(tier: ProposalTier, content: ProposedChange['change']['content']): BlockEdit {
  return tier === 'settings-block'
    ? { kind: 'settings', values: (content as { values: Record<string, unknown> }).values }
    : { kind: 'prompt', template: (content as { template: string }).template };
}

function sameContent(pinned: BlockRecord, edit: BlockEdit): boolean {
  if (pinned.kind === 'settings' && edit.kind === 'settings') {
    return canonicalize(pinned.content.values) === canonicalize(edit.values);
  }
  return pinned.kind === 'prompt' && edit.kind === 'prompt'
    ? pinned.content.template === edit.template
    : false;
}

type PinnedBlock =
  | { readonly kind: 'ok'; readonly block: BlockRecord }
  | {
      readonly kind: 'invalid';
      readonly message: string;
      readonly issues: readonly { readonly path: string; readonly message: string }[];
    };

/** The block version `from` pins for the tier, or why there's none to change. */
async function pinnedBlock(
  blocks: BlockRegistryBinding,
  tenantId: TenantId,
  from: AgentVersionRecord,
  tier: ProposalTier,
  blockId: string,
): Promise<PinnedBlock> {
  const kind = tier === 'settings-block' ? 'settings' : 'prompts';
  const what = tier === 'settings-block' ? 'settings' : 'prompt';
  const named = `${from.id as unknown as string} ${from.version as unknown as string}`;
  if (from.pins === undefined) {
    return {
      kind: 'invalid',
      message: `${named} has no pins (it was published before pins); publish it again to pin it`,
      issues: [],
    };
  }
  const version = from.pins[kind][blockId];
  if (version === undefined) {
    return {
      kind: 'invalid',
      message: `${named} doesn't use ${what} block "${blockId}"`,
      issues: [
        {
          path: '/change/blockId',
          message: `not a ${what} block this version pins; adding a block is a code change`,
        },
      ],
    };
  }
  const block = await blocks.getVersion({ tenantId, blockId, version });
  if (block === null) {
    return {
      kind: 'invalid',
      message: `Block "${blockId}" version ${version}, which ${named} pins, isn't in the block store`,
      issues: [],
    };
  }
  return { kind: 'ok', block };
}

// ---------- helpers ----------

/** The same change, from the same version, for the same scope, is one proposal. */
function fingerprintOf(parsed: CreateBody, change: ProposedChange['change']): string {
  const canonical = canonicalize({
    agentId: parsed.agentId,
    fromVersion: parsed.fromVersion,
    scope: liveScopeToWire(parsed.scope),
    tier: parsed.tier,
    change,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function userOf(c: Ctx): UserId | undefined {
  const actor = c.get('principal')?.actor;
  return actor?.kind === 'user' ? (actor.id as UserId) : undefined;
}

/** Who did it, as versions record it: `user:<id>`, else `service:<id>`. */
function who(c: Ctx): string {
  const actor = actorOf(c);
  return `${actor.kind}:${actor.id}`;
}

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

function notFound(c: Ctx, proposalId: string) {
  return fail(c, 'proposal-not-found', {
    code: 'proposal-not-found',
    message: `No proposal ${proposalId}`,
    proposalId,
  });
}

function validationFailed(
  c: Ctx,
  message: string,
  issues: readonly { readonly path: string; readonly message: string }[],
) {
  return fail(c, 'validation-failed', {
    code: 'validation-failed',
    message,
    issues: issues as unknown as Record<string, unknown>[],
  });
}

function startFailed(c: Ctx, outcome: Exclude<EvalRunStartOutcome, { kind: 'ok' }>) {
  switch (outcome.kind) {
    case 'suite-not-found':
      return fail(c, 'eval-suite-not-found', {
        code: 'eval-suite-not-found',
        message: `No eval suite registered with id "${outcome.suiteId}"`,
        suiteId: outcome.suiteId,
      });
    case 'dispatcher-not-registered':
      return fail(c, 'dispatcher-not-registered', {
        code: 'dispatcher-not-registered',
        message: `No eval-run dispatcher registered for kind "${outcome.evalKind}"`,
      });
    case 'dispatcher-input-invalid':
      return fail(c, 'dispatcher-input-invalid', {
        code: 'dispatcher-input-invalid',
        message: outcome.message,
      });
    case 'project-not-found':
      return fail(c, 'bad-input', {
        code: 'bad-input',
        message: `The candidate's project "${outcome.projectId as unknown as string}" isn't in this tenant`,
      });
  }
}
