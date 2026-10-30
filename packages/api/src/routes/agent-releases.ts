// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import type { ReviewerRole } from '@kindgi/authz';
import type { Cursor, LiveScope, OrgId, ProjectId, RunId, Semver, TenantId } from '@kindgi/types';

import type { ProjectBinding } from '@kindgi/platform';

import type { AgentRegistryBinding } from '../agent-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { EvalRun, EvalRunBinding } from '../eval-run-binding.js';
import type { GatePolicy } from '../gate-policy-binding.js';
import { type GateApproval, type GateCheck, type GateResult, evaluateGate } from '../gate.js';
import type { ItemRights } from '../item-rights.js';
import type { JudgedComparisonSummary } from '../judged-dispatcher.js';
import type {
  AgentReleaseBindings,
  LivePin,
  LiveResolveInput,
  PromoteInput,
  Promotion,
  PromotionActor,
} from '../live-version-binding.js';
import {
  type ReferenceScopeBinding,
  liveScopeOutOfScope,
  outOfScopeResponse,
} from '../reference-scope.js';
import type { AppEnv } from '../types.js';
import { type WhatRuns, whatRuns } from '../what-runs.js';
import { serializeGatePolicy } from './gate-policy-wire.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';
import { parseSegmentsQuery } from './segments.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The routes that change what's live: authorized as `promote` on the agent, not `admin`. */
export function isPromotionWrite(method: string, path: string): boolean {
  return method === 'POST' && /\/(promotions|live\/rollback|live\/unpin)$/.test(path);
}

/** The promotion writes that set a live version — a pin or a rollback, not an unpin: only these span an order's environments. */
export function isLiveSet(method: string, path: string): boolean {
  return method === 'POST' && /\/(promotions|live\/rollback)$/.test(path);
}

/** `POST …/promotions`: a request that a version go live. */
export function isPromotionRequest(method: string, path: string): boolean {
  return method === 'POST' && path.endsWith('/promotions');
}

/** `POST …/live/rollback` and `…/live/unpin`: undoing what's live. */
export function isLiveUndo(method: string, path: string): boolean {
  return method === 'POST' && /\/live\/(rollback|unpin)$/.test(path);
}

/** `POST …/promotions/check` changes nothing: `read` on the agent. */
export function isPromotionCheck(method: string, path: string): boolean {
  return method === 'POST' && path.endsWith('/promotions/check');
}

/** What the gate reads besides the releases: comparisons, and a project's org. */
export interface AgentReleaseGateDeps {
  readonly evalRuns?: EvalRunBinding;
  readonly projects?: ProjectBinding;
  /** A project or segment scope must reach the agent (`reference-scope.ts`); absent → as named. */
  readonly referenceScope?: ReferenceScopeBinding;
}

/**
 * Live versions of an agent per scope, and the promotions that set them
 * (evals step 4):
 *   GET  /:agentId/live            the version a run would use for a project and segment path
 *   GET  /:agentId/live-versions   every pin
 *   POST /:agentId/promotions      make a version live for a scope, through its gate
 *                                    (201 promoted, 202 waiting for approval, 422 gate-failed)
 *   POST /:agentId/promotions/check  what the gate would say, writing nothing
 *   GET  /:agentId/gate-policy     the gate policy that applies to a scope
 *   GET  /:agentId/promotions[/:id]  the history
 *   POST /:agentId/live/rollback   back to the scope's previous live version
 *   POST /:agentId/live/unpin      remove the scope's pin (it falls back to the scope above)
 */
export function mountAgentReleaseRoutes(
  r: Hono<AppEnv>,
  registry: AgentRegistryBinding,
  releases: AgentReleaseBindings,
  deps: AgentReleaseGateDeps = {},
  /** What a project-scoped promotion's project may run (`reference-scope.ts`); absent → as named. */
  referenceScope?: ReferenceScopeBinding,
  /** Rights on an agent more than one project serves (`item-rights.ts`); absent → the agent's own. */
  itemRights?: ItemRights,
): void {
  const seen = (c: Ctx, agentId: string, versions: readonly string[]) =>
    seenVersions(itemRights, c, agentId, versions);
  /** A promotion the caller can see: every version it names is one. */
  const named = (p: Promotion): string[] =>
    [p.fromVersion, p.toVersion].filter((v): v is Semver => v !== null).map(String);
  const shows = (p: Promotion, visible: ReadonlySet<string>) =>
    named(p).every((v) => visible.has(v));
  /** A project or segment promotion of an agent that project doesn't reach: refused. */
  const outOfScope = (tenantId: TenantId, agentId: string, scope: LiveScope) =>
    liveScopeOutOfScope(referenceScope, tenantId, agentId, scope);
  const gateDeps: AgentReleaseGateDeps = {
    ...deps,
    ...(referenceScope !== undefined && { referenceScope }),
  };
  r.get('/:agentId/live', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const projectId = c.req.query('projectId');
    if (projectId !== undefined && !UUID_RE.test(projectId)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`projectId` must be a project id (a UUID)' },
          requestId,
        ),
      );
    }
    const segments = parseSegmentsQuery(c.req.queries('segment') ?? []);
    if (segments.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: segments.message }, requestId));
    }
    if (segments.segments !== undefined && projectId === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: 'A `segment` path needs a `projectId`' },
          requestId,
        ),
      );
    }
    const runs = await whatRuns(releases, {
      tenantId,
      agentId,
      ...(projectId !== undefined && { projectId: projectId as ProjectId }),
      ...(segments.segments !== undefined && { segments: segments.segments }),
    });
    return answerLive(c, agentId, runs);
  });

  /**
   * What `GET …/live` answers: the live version that covers the scope,
   * else (nothing pinned on the way up) Latest, which is what a run gets
   * (`whatRuns`). A version the caller can't see answers as no version
   * running there does (`item-rights.ts`), and so does an agent no one
   * registered.
   */
  async function answerLive(c: Ctx, agentId: string, runs: WhatRuns | null) {
    const hidden = async (version: string) => !(await seen(c, agentId, [version])).has(version);
    if (runs?.follows === 'pin' && !(await hidden(runs.version as unknown as string))) {
      return c.json({
        agentId,
        version: runs.version as unknown as string,
        via: 'live',
        liveScope: liveScopeToWire(runs.liveScope),
      });
    }
    const latest = runs?.follows === 'latest' ? runs : null;
    if (latest === null || (await hidden(latest.version as unknown as string))) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No version of agent "${agentId}" runs in this scope: none is pinned there, and none is its latest`,
          },
          c.get('requestId'),
        ),
      );
    }
    return c.json({ agentId, version: latest.version as unknown as string, via: 'latest' });
  }

  r.get('/:agentId/live-versions', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const all = await releases.live.list({ tenantId, agentId });
    const visible = await seen(
      c,
      agentId,
      all.map((p) => p.version as unknown as string),
    );
    const pins = all.filter((p) => visible.has(p.version as unknown as string));
    return c.json({ data: pins.map(serializeLivePin) });
  });

  r.post('/:agentId/promotions', async (c) => {
    const requestId = c.get('requestId');
    const parsed = await readPromotionBody(c);
    if (parsed.kind === 'err') return badInput(c, requestId, parsed.message);
    const agentId = c.req.param('agentId');
    const outcome = await requestPromotion(registry, releases, gateDeps, {
      tenantId: c.get('tenantId') as TenantId,
      agentId,
      version: parsed.value.version,
      scope: parsed.value.scope,
      requestedBy: actorOf(c),
      ...(parsed.value.reason !== undefined && { reason: parsed.value.reason }),
      ...(parsed.value.evalRunId !== undefined && { evalRunId: parsed.value.evalRunId }),
    });
    return promotionResponse(c, outcome);
  });

  r.post('/:agentId/promotions/check', async (c) => {
    const requestId = c.get('requestId');
    const parsed = await readPromotionBody(c);
    if (parsed.kind === 'err') return badInput(c, requestId, parsed.message);
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const refused = await outOfScope(tenantId, agentId, parsed.value.scope);
    if (refused !== undefined) return outOfScopeResponse(c, requestId, refused);
    const policy = await policyFor(releases, tenantId, agentId, parsed.value.scope);
    const gate = await runGate(
      registry,
      releases,
      deps,
      { ...parsed.value, tenantId, agentId },
      policy,
    );
    if (gate.kind === 'err') return failed(c, requestId, gate.error);
    const { result } = gate;
    return c.json({
      outcome: !result.passed
        ? 'gate-failed'
        : result.approval !== undefined
          ? 'needs-approval'
          : 'would-promote',
      policy: policy === null ? null : { id: policy.id, version: policy.version },
      checks: result.checks,
      ...(result.approval !== undefined && { approval: result.approval }),
    });
  });

  r.get('/:agentId/gate-policy', async (c) => {
    const requestId = c.get('requestId');
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    if (scope.scope === undefined) {
      return badInput(c, requestId, '`scopeKind` is required: the scope a promotion would be for');
    }
    const policy = await policyFor(
      releases,
      c.get('tenantId') as TenantId,
      c.req.param('agentId'),
      scope.scope,
    );
    return c.json({ policy: policy === null ? null : serializeGatePolicy(policy) });
  });

  r.get('/:agentId/promotions', async (c) => {
    const requestId = c.get('requestId');
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    const cursor = c.req.query('cursor');
    const refused = refuseUnissuedCursor(c, releases.promotions, 'promotions', cursor);
    if (refused !== undefined) return refused;
    const agentId = c.req.param('agentId');
    const page = await releases.promotions.list({
      tenantId: c.get('tenantId') as TenantId,
      agentId,
      limit: clampLimit(c.req.query('limit')),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const visible = await seen(c, agentId, [...new Set(page.data.flatMap(named))]);
    return c.json({
      data: page.data.filter((p) => shows(p, visible)).map(serializePromotion),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:agentId/promotions/:promotionId', async (c) => {
    const requestId = c.get('requestId');
    const found = await releases.promotions.get(
      c.get('tenantId') as TenantId,
      c.req.param('promotionId'),
    );
    if (
      found === null ||
      found.agentId !== c.req.param('agentId') ||
      !shows(found, await seen(c, found.agentId, named(found)))
    ) {
      c.status(statusFor('promotion-not-found') as never);
      return c.json(
        toWireError(
          { code: 'promotion-not-found', message: 'No such promotion for this agent' },
          requestId,
        ),
      );
    }
    return c.json(serializePromotion(found));
  });

  r.post('/:agentId/live/rollback', async (c) => {
    const requestId = c.get('requestId');
    const body = await readBody(c);
    if (body === undefined) return badJson(c, requestId);
    const scope = parseLiveScopeBody(body.scope);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    if (
      body.toVersion !== undefined &&
      (typeof body.toVersion !== 'string' || body.toVersion === '')
    ) {
      return badInput(c, requestId, '`toVersion` must be a version when supplied');
    }
    const text = optionalText(body, ['reason']);
    if (text.kind === 'err') return badInput(c, requestId, text.message);
    const outcome = await releases.promotions.rollback({
      tenantId: c.get('tenantId') as TenantId,
      agentId: c.req.param('agentId'),
      scope: scope.scope,
      requestedBy: actorOf(c),
      ...(typeof body.toVersion === 'string' && { toVersion: body.toVersion as Semver }),
      ...text.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, outcome.error);
    return c.json(serializePromotion(outcome.value));
  });

  r.post('/:agentId/live/unpin', async (c) => {
    const requestId = c.get('requestId');
    const body = await readBody(c);
    if (body === undefined) return badJson(c, requestId);
    const scope = parseLiveScopeBody(body.scope);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    const text = optionalText(body, ['reason']);
    if (text.kind === 'err') return badInput(c, requestId, text.message);
    const outcome = await releases.promotions.unpin({
      tenantId: c.get('tenantId') as TenantId,
      agentId: c.req.param('agentId'),
      scope: scope.scope,
      requestedBy: actorOf(c),
      ...text.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, outcome.error);
    return c.json(serializePromotion(outcome.value));
  });
}

type Ctx = Context<AppEnv>;

/**
 * The versions among `versions` of an agent the caller can see: all of
 * them, unless more than one project serves the agent (`item-rights.ts`,
 * rule 2).
 */
export async function seenVersions(
  itemRights: ItemRights | undefined,
  c: Ctx,
  agentId: string,
  versions: readonly string[],
): Promise<ReadonlySet<string>> {
  return visibleOf(itemRights, c, agentId, await itemRights?.multi(c, 'agent', agentId), versions);
}

/**
 * The pins among `pins` whose version the caller can see, in order, by the
 * rule `seenVersions` applies to each pin's agent. One ask finds the agents
 * more than one project serves; only their versions are read further.
 */
export async function seenPins<P extends Pick<LivePin, 'agentId' | 'version'>>(
  itemRights: ItemRights | undefined,
  c: Ctx,
  pins: readonly P[],
): Promise<P[]> {
  if (itemRights === undefined || pins.length === 0) return [...pins];
  const versionOf = (p: P) => p.version as unknown as string;
  const multi = await itemRights.multiOfMany(
    c,
    'agent',
    pins.map((p) => p.agentId),
  );
  const visible = new Map<string, ReadonlySet<string>>();
  for (const [agentId, projects] of multi) {
    const versions = [...new Set(pins.filter((p) => p.agentId === agentId).map(versionOf))];
    visible.set(agentId, await visibleOf(itemRights, c, agentId, projects, versions));
  }
  return pins.filter((p) => visible.get(p.agentId)?.has(versionOf(p)) ?? true);
}

/** A pin on the wire (`LivePin`), as an agent's and a project's lists show it. */
export function serializeLivePin(p: LivePin) {
  return {
    agentId: p.agentId,
    scope: liveScopeToWire(p.scope),
    version: p.version as unknown as string,
    promotionId: p.promotionId,
    setAt: p.setAt as unknown as string,
  };
}

/** Rule 2 for one agent, given its projects when more than one serves it. */
async function visibleOf(
  itemRights: ItemRights | undefined,
  c: Ctx,
  agentId: string,
  projects: readonly ProjectId[] | undefined,
  versions: readonly string[],
): Promise<ReadonlySet<string>> {
  if (itemRights === undefined || projects === undefined) return new Set(versions);
  return new Set(
    await itemRights.visibleVersions(c, 'agent', agentId, projects, versions, (v) => v),
  );
}

/** A promotion request's outcome: recorded, refused before recording, or unsupported here. */
export type PromotionRequestOutcome =
  | {
      readonly kind: 'ok';
      readonly promotion: Promotion;
      /** The gate's checks as they ran (a binding may not echo them on the row). */
      readonly checks?: readonly GateCheck[];
    }
  | { readonly kind: 'err'; readonly error: { code: string; message: string } }
  | { readonly kind: 'gate-unsupported'; readonly policy: GatePolicy };

/**
 * Request that `version` go live for `scope`, through the scope's gate:
 * the binding records it as promoted, waiting for approval, or refused
 * (`promotion.status`). Without gated requests in this deployment, an
 * ungated scope promotes as before and a gated one is unsupported.
 */
export async function requestPromotion(
  registry: AgentRegistryBinding,
  releases: AgentReleaseBindings,
  deps: AgentReleaseGateDeps,
  input: PromoteInput,
  options: {
    /** An approval the promotion waits for even when the scope's policy asks for none. */
    readonly requireApproval?: GateApproval;
    /**
     * For a drafter's promotion: whether the tenant has a separate approver (a
     * reviewer other than the requester who could decide) ranked at or above
     * the given role. Consulted only when a scope policy sets
     * `separateApprover: false`, so the drafter's rule is re-checked at the
     * policy's role rather than the drafter's own `standard`.
     */
    readonly draftedEligibleAtRole?: (role: ReviewerRole) => Promise<boolean>;
  } = {},
): Promise<PromotionRequestOutcome> {
  // Every way a promotion is asked for comes through here (the route, a
  // proposal's request): a project or segment scope must reach the agent.
  const outOfScope = await liveScopeOutOfScope(
    deps.referenceScope,
    input.tenantId,
    input.agentId,
    input.scope,
  );
  if (outOfScope !== undefined) return { kind: 'err', error: outOfScope };
  const policy = await policyFor(releases, input.tenantId, input.agentId, input.scope);
  if (releases.promotions.request === undefined) {
    if (policy !== null) return { kind: 'gate-unsupported', policy };
    if (options.requireApproval !== undefined) {
      return {
        kind: 'err',
        error: {
          code: 'promotion-gate-unsupported',
          message:
            "This promotion waits for a reviewer's approval, and this deployment can't record a gated promotion yet.",
        },
      };
    }
    // No gate, and a binding from before gates: promote as before.
    const outcome = await releases.promotions.promote(input);
    return outcome.kind === 'err'
      ? { kind: 'err', error: outcome.error }
      : { kind: 'ok', promotion: outcome.value };
  }
  const gate = await runGate(registry, releases, deps, input, policy);
  if (gate.kind === 'err') return gate;
  const approval = await resolveApproval(gate.result.approval, options);
  const outcome = await releases.promotions.request({
    ...input,
    gate: {
      policy: policy === null ? null : { id: policy.id, version: policy.version },
      checks: gate.result.checks,
      passed: gate.result.passed,
      ...(approval !== undefined && { approval }),
      servingVersion: gate.servingVersion as Semver,
      ...(gate.pinInPlace && { pinInPlace: true }),
    },
  });
  return outcome.kind === 'err'
    ? { kind: 'err', error: outcome.error }
    : { kind: 'ok', promotion: outcome.value, checks: gate.result.checks };
}

/**
 * The approval a promotion request waits for. A scope policy's approval wins —
 * its role and its reviewer eligibility. For a drafter's promotion the policy's
 * rule is only a floor: the drafter's separate-approver rule can make it
 * stricter, never looser, so whoever started the pass can't approve their own
 * drafter's work. The policy's `separateApprover` defaults to `true`
 * (`gateApproval`), so only an explicit `false` defers to the drafter's rule,
 * re-checked at the policy's role (`draftedEligibleAtRole`) rather than the
 * drafter's own `standard`. A policy with no approvals block, and any
 * non-drafted promotion, are left unchanged.
 */
async function resolveApproval(
  policyApproval: GateApproval | undefined,
  options: {
    readonly requireApproval?: GateApproval;
    readonly draftedEligibleAtRole?: (role: ReviewerRole) => Promise<boolean>;
  },
): Promise<GateApproval | undefined> {
  if (policyApproval === undefined) return options.requireApproval;
  // A non-drafted promotion carries no drafter approval: the policy's stands.
  if (options.requireApproval === undefined) return policyApproval;
  // Already strict (the default, or an explicit true): nothing to add.
  if (policyApproval.separateApprover) return policyApproval;
  const separateApprover =
    options.draftedEligibleAtRole !== undefined
      ? await options.draftedEligibleAtRole(policyApproval.role)
      : options.requireApproval.separateApprover;
  return { ...policyApproval, separateApprover };
}

/**
 * The answer to a promotion request: 201 promoted, 202 waiting for
 * approval, 422 `gate-failed` with the checks, or the error. `extra` is
 * merged into whichever answer comes out — the caller carries fields it
 * knows the outcome alone can't, such as a make-live's pins so far.
 */
export function promotionResponse(
  c: Ctx,
  outcome: PromotionRequestOutcome,
  extra: Readonly<Record<string, unknown>> = {},
) {
  const requestId = c.get('requestId');
  if (outcome.kind === 'gate-unsupported') {
    c.status(statusFor('promotion-gate-unsupported') as never);
    return c.json(
      toWireError(
        {
          code: 'promotion-gate-unsupported',
          message: `Gate policy ${outcome.policy.id} ${outcome.policy.version} applies to this promotion, and this deployment can't record a gated promotion yet.`,
          ...extra,
        },
        requestId,
      ),
    );
  }
  if (outcome.kind === 'err') return failed(c, requestId, outcome.error, extra);
  const { promotion } = outcome;
  if (promotion.status === 'refused') {
    const checks = promotion.checks ?? outcome.checks ?? [];
    c.status(statusFor('gate-failed') as never);
    return c.json(
      toWireError(
        {
          code: 'gate-failed',
          message: `The release gate policy refused ${promotion.agentId} ${promotion.toVersion as unknown as string}: ${checks
            .filter((check) => !check.passed)
            .map((check) => check.message)
            .join(' ')}`,
          promotionId: promotion.id,
          policy: promotion.policy ?? null,
          checks,
          ...extra,
        },
        requestId,
      ),
    );
  }
  c.status(promotion.status === 'pending-approval' ? 202 : 201);
  return c.json({ ...serializePromotion(promotion), ...extra });
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function badJson(c: Ctx, requestId: string) {
  return badInput(c, requestId, 'Request body must be a JSON object');
}

function badInput(c: Ctx, requestId: string, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function failed(
  c: Ctx,
  requestId: string,
  error: { code: string; message: string },
  extra: Readonly<Record<string, unknown>> = {},
) {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError({ ...error, ...extra }, requestId));
}

/** Optional short strings (`reason`, `evalRunId`): absent, or a non-empty string. */
function optionalText(
  body: Readonly<Record<string, unknown>>,
  fields: readonly ('reason' | 'evalRunId')[],
):
  | { kind: 'ok'; value: { reason?: string; evalRunId?: string } }
  | { kind: 'err'; message: string } {
  const value: { reason?: string; evalRunId?: string } = {};
  for (const field of fields) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim() === '' || v.length > 2000) {
      return { kind: 'err', message: `\`${field}\` must be a non-empty string when supplied` };
    }
    value[field] = v;
  }
  return { kind: 'ok', value };
}

/** The promotion body: `{version, scope, evalRunId?, reason?}`. */
async function readPromotionBody(c: Ctx): Promise<
  | {
      kind: 'ok';
      value: { version: Semver; scope: LiveScope; evalRunId?: string; reason?: string };
    }
  | { kind: 'err'; message: string }
> {
  const body = await readBody(c);
  if (body === undefined) return { kind: 'err', message: 'Request body must be a JSON object' };
  const scope = parseLiveScopeBody(body.scope);
  if (scope.kind === 'err') return scope;
  if (typeof body.version !== 'string' || body.version.length === 0) {
    return { kind: 'err', message: '`version` is required: the agent version to make live' };
  }
  const text = optionalText(body, ['reason', 'evalRunId']);
  if (text.kind === 'err') return text;
  return {
    kind: 'ok',
    value: { version: body.version as Semver, scope: scope.scope, ...text.value },
  };
}

/** The gate policy for a promotion of `agentId` for `scope`; `null` when none applies. */
export async function policyFor(
  releases: AgentReleaseBindings,
  tenantId: TenantId,
  agentId: string,
  scope: LiveScope,
): Promise<GatePolicy | null> {
  return releases.gatePolicies === undefined
    ? null
    : releases.gatePolicies.resolve({ tenantId, agentId, scope });
}

/** The scope's coordinates, as a run in it would resolve its version. */
export function coordinatesOf(scope: LiveScope): Omit<LiveResolveInput, 'tenantId' | 'agentId'> {
  switch (scope.kind) {
    case 'tenant':
      return {};
    case 'org':
      return { orgId: scope.orgId };
    case 'project':
      return { projectId: scope.projectId };
    case 'segment':
      return { projectId: scope.projectId, segments: scope.path };
  }
}

/** A finished comparison's summary, or `null` for any other eval run. */
function summaryOf(run: EvalRun): JudgedComparisonSummary | null {
  const summary = run.result?.summary;
  return run.kind === 'judged' && summary !== null && typeof summary === 'object'
    ? (summary as JudgedComparisonSummary)
    : null;
}

/** Whether two live scopes are the same scope. */
function sameScope(a: LiveScope, b: LiveScope): boolean {
  switch (a.kind) {
    case 'tenant':
      return b.kind === 'tenant';
    case 'org':
      return b.kind === 'org' && b.orgId === a.orgId;
    case 'project':
      return b.kind === 'project' && b.projectId === a.projectId;
    case 'segment':
      return (
        b.kind === 'segment' &&
        b.projectId === a.projectId &&
        b.path.length === a.path.length &&
        b.path.every((s, i) => s.key === a.path[i]?.key && s.value === a.path[i]?.value)
      );
  }
}

/**
 * The gate for a promotion request: what serves the scope now, the
 * comparison it names, and the policy's checks against them. With no
 * policy there's nothing to check. A pin in place (the scope has no pin
 * of its own and serves exactly the version already) changes nothing any
 * run gets, so the policy's checks and approval don't apply: one passing
 * `pinInPlace` check, and `pinInPlace` for the binding to re-check.
 */
async function runGate(
  registry: AgentRegistryBinding,
  releases: AgentReleaseBindings,
  deps: AgentReleaseGateDeps,
  req: {
    readonly tenantId: TenantId;
    readonly agentId: string;
    readonly version: Semver;
    readonly scope: LiveScope;
    readonly evalRunId?: string;
  },
  policy: GatePolicy | null,
): Promise<
  | { kind: 'ok'; result: GateResult; servingVersion: string; pinInPlace?: boolean }
  | { kind: 'err'; error: { code: string; message: string } }
> {
  const { tenantId, agentId } = req;
  const err = (code: string, message: string) => ({
    kind: 'err' as const,
    error: { code, message },
  });
  const promoted = await registry.getVersion({
    tenantId,
    agentId: agentId as AgentId,
    version: req.version,
  });
  if (promoted === null || promoted.unregisteredAt !== undefined) {
    return err('agent-version-not-found', `${agentId} has no active version ${req.version}`);
  }
  const runs = await whatRuns(releases, { tenantId, agentId, ...coordinatesOf(req.scope) });
  if (runs === null) {
    return err(
      'agent-not-found',
      `No version of agent "${agentId}" runs in this scope: none is pinned there, and none is its latest`,
    );
  }
  const live = runs.follows === 'pin' ? runs : null;
  const servingVersion = runs.version as unknown as string;
  if (policy === null) return { kind: 'ok', result: { checks: [], passed: true }, servingVersion };
  if (servingVersion === (req.version as unknown as string)) {
    const pins = await releases.live.list({ tenantId, agentId });
    if (!pins.some((pin) => sameScope(pin.scope, req.scope))) {
      const from = live === null ? 'as the latest version' : 'from a pin above it';
      return {
        kind: 'ok',
        result: {
          checks: [
            {
              name: 'pinInPlace',
              passed: true,
              message: `${agentId} ${servingVersion} already serves this scope (${from}), so pinning it here changes nothing for runs: the gate's checks and approval don't apply.`,
            },
          ],
          passed: true,
        },
        servingVersion,
        pinInPlace: true,
      };
    }
  }

  let summary: JudgedComparisonSummary | null = null;
  if (req.evalRunId !== undefined) {
    const run =
      deps.evalRuns === undefined
        ? null
        : await deps.evalRuns.get({ tenantId, runId: req.evalRunId as RunId });
    if (run === null) return err('eval-run-not-found', `No eval run ${req.evalRunId}`);
    summary = summaryOf(run);
    if (summary === null) {
      return err(
        'bad-input',
        `Eval run ${req.evalRunId} isn't a finished comparison: it has no comparison summary`,
      );
    }
  }
  let summaryProjectOrgId: string | undefined;
  const judgedIn = summary?.scope.projectId;
  if (req.scope.kind === 'org' && judgedIn !== undefined && deps.projects !== undefined) {
    const project = await deps.projects.get(tenantId, judgedIn as ProjectId);
    summaryProjectOrgId = project?.orgId as unknown as string | undefined;
  }
  const result = evaluateGate({
    spec: policy.spec,
    promotion: {
      agentId,
      version: req.version as unknown as string,
      pinsDigest: promoted.pinsDigest ?? null,
      scope: req.scope,
    },
    summary,
    servingVersion,
    ...(summaryProjectOrgId !== undefined && { summaryProjectOrgId }),
    now: new Date(),
  });
  return { kind: 'ok', result, servingVersion };
}

/** Who asked, from the request's principal. */
export function actorOf(c: Ctx): PromotionActor {
  const actor = c.get('principal')?.actor;
  if (actor === undefined) return { kind: 'service', id: 'unknown' };
  return { kind: actor.kind === 'user' ? 'user' : 'service', id: actor.id };
}

/** `?scopeKind=tenant|org|project|segment&scopeId=…&segment=key:value` for the history filter. */
export function scopeFromQuery(
  query: (name: string) => string | undefined,
  segmentValues: readonly string[],
): { kind: 'ok'; scope?: LiveScope } | { kind: 'err'; message: string } {
  const kind = query('scopeKind');
  const id = query('scopeId');
  if (kind === undefined || kind === '') {
    return id === undefined
      ? { kind: 'ok' }
      : { kind: 'err', message: '`scopeId` needs `scopeKind`' };
  }
  if (kind === 'tenant') return { kind: 'ok', scope: { kind: 'tenant' } };
  if (id === undefined || !UUID_RE.test(id)) {
    return { kind: 'err', message: '`scopeId` must be an org or project id (a UUID)' };
  }
  if (kind === 'org') return { kind: 'ok', scope: { kind: 'org', orgId: id as OrgId } };
  if (kind === 'project')
    return { kind: 'ok', scope: { kind: 'project', projectId: id as ProjectId } };
  if (kind === 'segment') {
    const path = parseSegmentsQuery(segmentValues);
    if (path.kind === 'err') return path;
    if (path.segments === undefined)
      return { kind: 'err', message: 'A segment scope needs `segment`' };
    return {
      kind: 'ok',
      scope: { kind: 'segment', projectId: id as ProjectId, path: path.segments },
    };
  }
  return { kind: 'err', message: '`scopeKind` must be one of tenant, org, project, segment' };
}

export function serializePromotion(p: Promotion): Record<string, unknown> {
  return {
    id: p.id,
    agentId: p.agentId,
    scope: liveScopeToWire(p.scope),
    action: p.action,
    fromVersion: p.fromVersion as unknown as string | null,
    toVersion: p.toVersion as unknown as string | null,
    requestedBy: p.requestedBy,
    ...(p.reason !== undefined && { reason: p.reason }),
    ...(p.evalRunId !== undefined && { evalRunId: p.evalRunId }),
    createdAt: p.createdAt as unknown as string,
    ...(p.status !== undefined && { status: p.status }),
    ...(p.policy !== undefined && { policy: p.policy }),
    ...(p.checks !== undefined && { checks: p.checks }),
    ...(p.approvalId !== undefined && { approvalId: p.approvalId }),
    ...(p.resolvedAt !== undefined && { resolvedAt: p.resolvedAt as unknown as string }),
  };
}
