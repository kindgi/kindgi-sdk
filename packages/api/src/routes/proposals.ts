// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type {
  AgentId,
  Cursor,
  FixProposalId,
  SupervisorId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  FixProposal,
  FixProposalStatus,
  PassCriterion,
  PatternRef,
  ProposedChange,
  SupervisorBinding,
} from '../supervisor-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';

const FIX_PROPOSAL_STATUSES: ReadonlySet<FixProposalStatus> = new Set([
  'draft',
  'dry-running',
  'dry-run-passed',
  'dry-run-failed',
  'proposed-for-review',
  'approved',
  'rejected',
  'applied',
  'rolled-back',
  'withdrawn',
]);

const PROPOSAL_TIERS: ReadonlySet<ProposedChange['tier']> = new Set([
  'prompt',
  'retrieval',
  'tool-config',
]);

const REVIEWER_ROLES: ReadonlySet<'standard' | 'senior' | 'admin'> = new Set([
  'standard',
  'senior',
  'admin',
]);

/**
 * Supervisor proposals resource. Ships the full self-fix lifecycle
 * over HTTP: draft → dry-run → submit-review → apply / rollback /
 * withdraw — the complete supervisor loop.
 *
 * Persistence + runtime wiring is caller-plugged via
 * `SupervisorBinding` — the API package doesn't own supervisor
 * runtime, agent registry, HITL wiring, or eval invocation.
 *
 * `supervisorId` scoping: every route requires an `X-Supervisor-Id`
 * request header. Missing / empty → `400 supervisor-header-missing`.
 *
 * State transitions: attempts to advance a proposal from a status
 * the runtime won't accept (e.g., apply on a proposal still in
 * `dry-running`) surface as `409 proposal-invalid-state-transition`.
 * This is a caller/state conflict per `docs/API-ROUTE-CONVENTIONS.md`
 * §4.3 — the request was well-formed but the resource is not in
 * the required state.
 */
export function proposalsRouter(binding: SupervisorBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- supervisor-id gate for the whole resource ----------
  r.use('*', async (c, next) => {
    const requestId = c.get('requestId');
    const supervisorId = c.req.header('x-supervisor-id');
    if (supervisorId === undefined || supervisorId.length === 0) {
      c.status(statusFor('supervisor-header-missing') as never);
      return c.json(
        toWireError(
          {
            code: 'supervisor-header-missing',
            message:
              'X-Supervisor-Id header is required on all /v1/proposals routes; supply the SupervisorId scoping the request.',
          },
          requestId,
        ),
      );
    }
    await next();
    return;
  });

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const statusRaw = c.req.query('status');
    const agentIdRaw = c.req.query('agentId');
    const tierRaw = c.req.query('tier');

    let status: FixProposalStatus | undefined;
    if (statusRaw !== undefined && statusRaw.length > 0) {
      if (!FIX_PROPOSAL_STATUSES.has(statusRaw as FixProposalStatus)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: `Unknown \`status\` value: ${statusRaw}` },
            requestId,
          ),
        );
      }
      status = statusRaw as FixProposalStatus;
    }

    let tier: ProposedChange['tier'] | undefined;
    if (tierRaw !== undefined && tierRaw.length > 0) {
      if (!PROPOSAL_TIERS.has(tierRaw as ProposedChange['tier'])) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: `Unknown \`tier\` value: ${tierRaw}` },
            requestId,
          ),
        );
      }
      tier = tierRaw as ProposedChange['tier'];
    }

    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.listProposals({
      tenantId,
      supervisorId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(status !== undefined && { status }),
      ...(agentIdRaw !== undefined && agentIdRaw.length > 0 && { agentId: agentIdRaw as AgentId }),
      ...(tier !== undefined && { tier }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });
    return c.json({
      data: page.data.map(serializeProposal),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:proposalId ----------
  r.get('/:proposalId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;
    const proposalId = c.req.param('proposalId') as FixProposalId;

    const proposal = await binding.getProposal({ tenantId, supervisorId, proposalId });
    if (proposal === null) {
      return proposalNotFound(c, requestId, proposalId);
    }
    return c.json(serializeProposal(proposal));
  });

  // ---------- POST / (draft) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badInput(c, requestId, 'Request body must be valid JSON');
    }
    const parsed = parseDraftBody(body);
    if (parsed.kind === 'err') {
      return badInput(c, requestId, parsed.message);
    }

    const outcome = await binding.draftProposal({
      tenantId,
      supervisorId,
      agentId: parsed.value.agentId,
      agentVersion: parsed.value.agentVersion,
      tier: parsed.value.tier,
      change: parsed.value.change,
      patternRefs: parsed.value.patternRefs,
      hypothesis: parsed.value.hypothesis,
      proposerRuleId: parsed.value.proposerRuleId,
    });
    // Both `ok` and `dedup` return 201 — the caller ends up with a
    // proposal id it can advance. Signal dedup via a header so
    // consumers that care can distinguish (mirrors the
    // X-Idempotent-Replay pattern from the idempotency middleware).
    if (outcome.kind === 'dedup') {
      c.header('X-Proposal-Deduped', 'true');
    }
    c.status(201);
    return c.json(serializeProposal(outcome.proposal));
  });

  // ---------- POST /:proposalId/dry-run ----------
  r.post('/:proposalId/dry-run', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;
    const proposalId = c.req.param('proposalId') as FixProposalId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badInput(c, requestId, 'Request body must be valid JSON');
    }
    const parsed = parseDryRunBody(body);
    if (parsed.kind === 'err') {
      return badInput(c, requestId, parsed.message);
    }

    const outcome = await binding.dryRunProposal({
      tenantId,
      supervisorId,
      proposalId,
      datasetId: parsed.value.datasetId,
      datasetVersion: parsed.value.datasetVersion,
      criterion: parsed.value.criterion,
    });
    if (outcome.kind === 'not-found') {
      return proposalNotFound(c, requestId, proposalId);
    }
    if (outcome.kind === 'invalid-transition') {
      return invalidTransition(c, requestId, outcome.proposalId, outcome.from, outcome.to);
    }
    if (outcome.kind === 'runtime-error') {
      return runtimeError(c, requestId, outcome.code, outcome.message);
    }
    return c.json({
      proposal: serializeProposal(outcome.proposal),
      passed: outcome.passed,
    });
  });

  // ---------- POST /:proposalId/submit-review ----------
  r.post('/:proposalId/submit-review', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;
    const proposalId = c.req.param('proposalId') as FixProposalId;

    // Body is optional — every field on submit-review is an override.
    let body: unknown = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      return badInput(c, requestId, 'Request body must be valid JSON');
    }
    const parsed = parseSubmitReviewBody(body);
    if (parsed.kind === 'err') {
      return badInput(c, requestId, parsed.message);
    }

    const outcome = await binding.submitReview({
      tenantId,
      supervisorId,
      proposalId,
      ...(parsed.value.requiredRole !== undefined && { requiredRole: parsed.value.requiredRole }),
      ...(parsed.value.expiresAt !== undefined && { expiresAt: parsed.value.expiresAt }),
    });
    if (outcome.kind === 'not-found') {
      return proposalNotFound(c, requestId, proposalId);
    }
    if (outcome.kind === 'invalid-transition') {
      return invalidTransition(c, requestId, outcome.proposalId, outcome.from, outcome.to);
    }
    if (outcome.kind === 'ground-layer-violation') {
      c.status(statusFor('ground-layer-violation') as never);
      return c.json(
        toWireError(
          {
            code: 'ground-layer-violation',
            message: `Proposal ${outcome.proposalId as unknown as string} violated ground guardrail ${outcome.guardrailId}: ${outcome.reason}`,
            proposalId: outcome.proposalId as unknown as string,
            guardrailId: outcome.guardrailId,
            reason: outcome.reason,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'runtime-error') {
      return runtimeError(c, requestId, outcome.code, outcome.message);
    }
    return c.json({
      proposal: serializeProposal(outcome.proposal),
      approvalId: outcome.approvalId as unknown as string,
      metaFix: outcome.metaFix,
    });
  });

  // ---------- POST /:proposalId/apply ----------
  r.post('/:proposalId/apply', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;
    const proposalId = c.req.param('proposalId') as FixProposalId;

    let body: unknown = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      return badInput(c, requestId, 'Request body must be valid JSON');
    }
    const parsed = parseApplyBody(body);
    if (parsed.kind === 'err') {
      return badInput(c, requestId, parsed.message);
    }

    const outcome = await binding.applyProposal({
      tenantId,
      supervisorId,
      proposalId,
      ...(parsed.value.newVersion !== undefined && { newVersion: parsed.value.newVersion }),
    });
    if (outcome.kind === 'not-found') {
      return proposalNotFound(c, requestId, proposalId);
    }
    if (outcome.kind === 'invalid-transition') {
      return invalidTransition(c, requestId, outcome.proposalId, outcome.from, outcome.to);
    }
    if (outcome.kind === 'runtime-error') {
      return runtimeError(c, requestId, outcome.code, outcome.message);
    }
    return c.json({
      proposalId: outcome.proposalId as unknown as string,
      appliedVersion: outcome.appliedVersion,
      appliedAt: outcome.appliedAt as unknown as string,
    });
  });

  // ---------- POST /:proposalId/rollback ----------
  r.post('/:proposalId/rollback', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;
    const proposalId = c.req.param('proposalId') as FixProposalId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badInput(c, requestId, 'Request body must be valid JSON');
    }
    const parsed = parseReasonBody(body);
    if (parsed.kind === 'err') {
      return badInput(c, requestId, parsed.message);
    }

    const outcome = await binding.rollbackProposal({
      tenantId,
      supervisorId,
      proposalId,
      reason: parsed.value.reason,
    });
    if (outcome.kind === 'not-found') {
      return proposalNotFound(c, requestId, proposalId);
    }
    if (outcome.kind === 'invalid-transition') {
      return invalidTransition(c, requestId, outcome.proposalId, outcome.from, outcome.to);
    }
    if (outcome.kind === 'runtime-error') {
      return runtimeError(c, requestId, outcome.code, outcome.message);
    }
    return c.json({
      proposalId: outcome.proposalId as unknown as string,
      rolledBackAt: outcome.rolledBackAt as unknown as string,
    });
  });

  // ---------- POST /:proposalId/withdraw ----------
  r.post('/:proposalId/withdraw', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const supervisorId = c.req.header('x-supervisor-id') as SupervisorId;
    const proposalId = c.req.param('proposalId') as FixProposalId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badInput(c, requestId, 'Request body must be valid JSON');
    }
    const parsed = parseReasonBody(body);
    if (parsed.kind === 'err') {
      return badInput(c, requestId, parsed.message);
    }

    const outcome = await binding.withdrawProposal({
      tenantId,
      supervisorId,
      proposalId,
      reason: parsed.value.reason,
    });
    if (outcome.kind === 'not-found') {
      return proposalNotFound(c, requestId, proposalId);
    }
    if (outcome.kind === 'invalid-transition') {
      return invalidTransition(c, requestId, outcome.proposalId, outcome.from, outcome.to);
    }
    if (outcome.kind === 'runtime-error') {
      return runtimeError(c, requestId, outcome.code, outcome.message);
    }
    return c.json(serializeProposal(outcome.proposal));
  });

  return r;
}

// -------------------- serialization --------------------

function serializeProposal(p: FixProposal): Record<string, unknown> {
  return {
    id: p.id as unknown as string,
    tenantId: p.tenantId as unknown as string,
    supervisorId: p.supervisorId as unknown as string,
    agentId: p.agentId as unknown as string,
    agentVersion: p.agentVersion,
    tier: p.tier,
    change: p.change,
    patternRefs: p.patternRefs,
    hypothesis: p.hypothesis,
    proposerRuleId: p.proposerRuleId,
    status: p.status,
    fingerprint: p.fingerprint,
    ...(p.resolutionReason !== undefined && { resolutionReason: p.resolutionReason }),
    ...(p.reviewApprovalId !== undefined && {
      reviewApprovalId: p.reviewApprovalId as unknown as string,
    }),
    ...(p.appliedVersion !== undefined && { appliedVersion: p.appliedVersion }),
    ...(p.appliedAt !== undefined && { appliedAt: p.appliedAt as unknown as string }),
    ...(p.rolledBackAt !== undefined && { rolledBackAt: p.rolledBackAt as unknown as string }),
    createdAt: p.createdAt as unknown as string,
    updatedAt: p.updatedAt as unknown as string,
    ...(p.resolvedAt !== undefined && { resolvedAt: p.resolvedAt as unknown as string }),
  };
}

// -------------------- error helpers --------------------

type Ctx = Context<AppEnv>;

function badInput(c: Ctx, requestId: string, message: string): Response {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function proposalNotFound(c: Ctx, requestId: string, proposalId: FixProposalId): Response {
  c.status(statusFor('proposal-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'proposal-not-found',
        message: `No proposal with id "${proposalId as unknown as string}"`,
        proposalId: proposalId as unknown as string,
      },
      requestId,
    ),
  );
}

function invalidTransition(
  c: Ctx,
  requestId: string,
  proposalId: FixProposalId,
  from: FixProposalStatus,
  to: FixProposalStatus,
): Response {
  c.status(statusFor('proposal-invalid-state-transition') as never);
  return c.json(
    toWireError(
      {
        code: 'proposal-invalid-state-transition',
        message: `Cannot transition proposal ${proposalId as unknown as string} from ${from} to ${to}`,
        proposalId: proposalId as unknown as string,
        from,
        to,
      },
      requestId,
    ),
  );
}

function runtimeError(c: Ctx, requestId: string, code: string, message: string): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, requestId));
}

// -------------------- request parsing --------------------

type Parsed<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

interface DraftPayload {
  readonly agentId: AgentId;
  readonly agentVersion: string;
  readonly tier: ProposedChange['tier'];
  readonly change: ProposedChange['change'];
  readonly patternRefs: readonly PatternRef[];
  readonly hypothesis: string;
  readonly proposerRuleId: string;
}

function parseDraftBody(body: unknown): Parsed<DraftPayload> {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', message: 'Request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const agentId = b.agentId;
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return { kind: 'err', message: 'Field `agentId` must be a non-empty string' };
  }
  const agentVersion = b.agentVersion;
  if (typeof agentVersion !== 'string' || agentVersion.length === 0) {
    return { kind: 'err', message: 'Field `agentVersion` must be a non-empty string' };
  }
  const tier = b.tier;
  if (typeof tier !== 'string' || !PROPOSAL_TIERS.has(tier as ProposedChange['tier'])) {
    return {
      kind: 'err',
      message: 'Field `tier` must be one of "prompt", "retrieval", "tool-config"',
    };
  }
  const change = b.change;
  if (change === null || typeof change !== 'object') {
    return { kind: 'err', message: 'Field `change` must be an object' };
  }
  const patternRefs = b.patternRefs;
  if (!Array.isArray(patternRefs)) {
    return { kind: 'err', message: 'Field `patternRefs` must be an array' };
  }
  const hypothesis = b.hypothesis;
  if (typeof hypothesis !== 'string' || hypothesis.length === 0) {
    return { kind: 'err', message: 'Field `hypothesis` must be a non-empty string' };
  }
  const proposerRuleId = b.proposerRuleId;
  if (typeof proposerRuleId !== 'string' || proposerRuleId.length === 0) {
    return { kind: 'err', message: 'Field `proposerRuleId` must be a non-empty string' };
  }
  return {
    kind: 'ok',
    value: {
      agentId: agentId as AgentId,
      agentVersion,
      tier: tier as ProposedChange['tier'],
      change: change as ProposedChange['change'],
      patternRefs: patternRefs as readonly PatternRef[],
      hypothesis,
      proposerRuleId,
    },
  };
}

interface DryRunPayload {
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly criterion: PassCriterion;
}

function parseDryRunBody(body: unknown): Parsed<DryRunPayload> {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', message: 'Request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const datasetId = b.datasetId;
  if (typeof datasetId !== 'string' || datasetId.length === 0) {
    return { kind: 'err', message: 'Field `datasetId` must be a non-empty string' };
  }
  const datasetVersion = b.datasetVersion;
  if (typeof datasetVersion !== 'string' || datasetVersion.length === 0) {
    return { kind: 'err', message: 'Field `datasetVersion` must be a non-empty string' };
  }
  const rawCriterion = b.criterion;
  if (rawCriterion === null || typeof rawCriterion !== 'object') {
    return { kind: 'err', message: 'Field `criterion` must be an object' };
  }
  const cr = rawCriterion as Record<string, unknown>;
  if (cr.kind === 'min-pass-rate') {
    const minPassRate = cr.minPassRate;
    if (typeof minPassRate !== 'number' || !Number.isFinite(minPassRate)) {
      return {
        kind: 'err',
        message: 'Field `criterion.minPassRate` must be a finite number for kind "min-pass-rate"',
      };
    }
    return {
      kind: 'ok',
      value: { datasetId, datasetVersion, criterion: { kind: 'min-pass-rate', minPassRate } },
    };
  }
  if (cr.kind === 'strict-improvement') {
    const baseline = cr.baselinePassRate;
    const minDelta = cr.minDelta;
    if (typeof baseline !== 'number' || !Number.isFinite(baseline)) {
      return {
        kind: 'err',
        message:
          'Field `criterion.baselinePassRate` must be a finite number for kind "strict-improvement"',
      };
    }
    if (typeof minDelta !== 'number' || !Number.isFinite(minDelta)) {
      return {
        kind: 'err',
        message: 'Field `criterion.minDelta` must be a finite number for kind "strict-improvement"',
      };
    }
    return {
      kind: 'ok',
      value: {
        datasetId,
        datasetVersion,
        criterion: { kind: 'strict-improvement', baselinePassRate: baseline, minDelta },
      },
    };
  }
  return {
    kind: 'err',
    message: 'Field `criterion.kind` must be "min-pass-rate" or "strict-improvement"',
  };
}

interface SubmitReviewPayload {
  readonly requiredRole?: 'standard' | 'senior' | 'admin';
  readonly expiresAt?: Timestamp;
}

function parseSubmitReviewBody(body: unknown): Parsed<SubmitReviewPayload> {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', message: 'Request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const out: {
    requiredRole?: 'standard' | 'senior' | 'admin';
    expiresAt?: Timestamp;
  } = {};
  const requiredRole = b.requiredRole;
  if (requiredRole !== undefined) {
    if (
      typeof requiredRole !== 'string' ||
      !REVIEWER_ROLES.has(requiredRole as 'standard' | 'senior' | 'admin')
    ) {
      return {
        kind: 'err',
        message: 'Field `requiredRole` must be one of "standard", "senior", "admin"',
      };
    }
    out.requiredRole = requiredRole as 'standard' | 'senior' | 'admin';
  }
  const expiresAt = b.expiresAt;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || Number.isNaN(new Date(expiresAt).getTime())) {
      return { kind: 'err', message: 'Field `expiresAt` must be an ISO date string' };
    }
    out.expiresAt = expiresAt as Timestamp;
  }
  return { kind: 'ok', value: out };
}

interface ApplyPayload {
  readonly newVersion?: string;
}

function parseApplyBody(body: unknown): Parsed<ApplyPayload> {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', message: 'Request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const newVersion = b.newVersion;
  if (newVersion !== undefined) {
    if (typeof newVersion !== 'string' || newVersion.length === 0) {
      return {
        kind: 'err',
        message: 'Field `newVersion` must be a non-empty string when present',
      };
    }
    return { kind: 'ok', value: { newVersion } };
  }
  return { kind: 'ok', value: {} };
}

interface ReasonPayload {
  readonly reason: string;
}

function parseReasonBody(body: unknown): Parsed<ReasonPayload> {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', message: 'Request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const reason = b.reason;
  if (typeof reason !== 'string' || reason.length === 0) {
    return { kind: 'err', message: 'Field `reason` must be a non-empty string' };
  }
  return { kind: 'ok', value: { reason } };
}
