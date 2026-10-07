// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type AgentId, tunableKeys } from '@kindgi/agents';
import { type Action, ref } from '@kindgi/authz';
import type { Cursor, Semver, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from '../agent-binding.js';
import type { BlockRegistryBinding } from '../block-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type {
  ImprovementBudget,
  ImprovementPass,
  ImprovementPassBinding,
  ImprovementTier,
} from '../improvement-pass-binding.js';
import type { AgentReleaseBindings } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ProposalObjective } from '../supervisor-binding.js';
import type { AppEnv } from '../types.js';
import { actorOf, coordinatesOf } from './agent-releases.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';

type Ctx = Context<AppEnv>;

/** What `improve` checks a pass against before it starts. */
export interface ImproveDeps {
  readonly passes?: ImprovementPassBinding;
  readonly agents: AgentRegistryBinding;
  readonly blocks: BlockRegistryBinding;
  readonly releases: AgentReleaseBindings;
}

export const DEFAULT_BUDGET: ImprovementBudget = { maxCostUsd: 5, maxCandidates: 30 };
const MAX_COST_USD = 100;
const MAX_CANDIDATES = 200;
const OBJECTIVES: readonly ProposalObjective[] = ['weightedYesShare', 'weightedPrecisionAtK'];

/**
 * `POST /improve` (under `/v1/proposals`): start an improvement pass for
 * an agent version and a live scope. It answers 202 with the pass; the
 * pass carries on in the background (`GET /v1/improvement-passes/:id`).
 *
 * Checked first, as evaluating its proposal would be: the version must be
 * active and pinned, it must pin a settings block with tunable keys, the
 * agent registry must take writes, and the agent must have a live version
 * for the whole tenant. Needs `publish` on the agent.
 */
export function mountImproveRoute(r: Hono<AppEnv>, deps: ImproveDeps, authorizer?: Authorizer) {
  r.post('/improve', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseImproveBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const denied = await deny(c, authorizer, 'publish', parsed.agentId);
    if (denied !== undefined) return denied;
    if (deps.passes === undefined) return unsupported(c);
    if (deps.agents.readOnly !== undefined) {
      return fail(c, 'registry-read-only', {
        code: 'registry-read-only',
        message: deps.agents.readOnly.reason,
      });
    }
    const fromVersion =
      parsed.fromVersion ?? (await servingVersion(deps, tenantId, parsed.agentId, parsed.scope));
    const from =
      fromVersion === undefined
        ? null
        : await deps.agents.getVersion({
            tenantId,
            agentId: parsed.agentId as AgentId,
            version: fromVersion as Semver,
          });
    if (from === null || from.unregisteredAt !== undefined) {
      return fail(c, 'agent-version-not-found', {
        code: 'agent-version-not-found',
        message: `${parsed.agentId} has no active version ${fromVersion ?? '(none is registered)'}`,
      });
    }
    const tunable = await tunableBlocks(deps.blocks, tenantId, from);
    if (tunable.length === 0) {
      return fail(c, 'validation-failed', {
        code: 'validation-failed',
        message: `${parsed.agentId} ${from.version as unknown as string} pins no settings block with keys marked "x-kindgi-tunable": there's nothing for a pass to tune. Mark the keys it may tune in the block's schema (a number or integer with a minimum and maximum, or an enum) and publish it.`,
        issues: [],
      });
    }
    if ((await deps.releases.live.resolve({ tenantId, agentId: parsed.agentId })) === null) {
      return fail(c, 'proposal-needs-pin', {
        code: 'proposal-needs-pin',
        message: `${parsed.agentId} has no live version for the whole tenant, so the version a pass proposes would serve every scope nothing is pinned for. Promote its current version for the tenant first (scope { "kind": "tenant" }), then start the pass.`,
      });
    }
    const pass = await deps.passes.start({
      tenantId,
      ...(from.projectId !== undefined && { projectId: from.projectId }),
      agentId: parsed.agentId,
      fromVersion: from.version as unknown as string,
      scope: parsed.scope,
      suiteId: parsed.suiteId,
      tiers: parsed.tiers,
      objective: parsed.objective,
      budget: parsed.budget,
      requestedBy: actorOf(c),
    });
    c.status(202);
    return c.json(serializePass(pass));
  });
}

/**
 * `/v1/improvement-passes`: read passes back, and cancel one.
 *
 *   GET  /               newest first; `?agentId=` narrows
 *   GET  /:passId        one
 *   POST /:passId/cancel stop a running pass (it writes no proposal)
 *
 * Authorized on the pass's agent: `read`, and `publish` to cancel. A pass
 * the caller can't read answers 404.
 */
export function improvementPassesRouter(
  passes: ImprovementPassBinding | undefined,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function load(c: Ctx): Promise<ImprovementPass | Response> {
    if (passes === undefined) return unsupported(c);
    const passId = c.req.param('passId') ?? '';
    const pass = await passes.get({ tenantId: c.get('tenantId') as TenantId, passId });
    const hidden =
      pass !== null &&
      authorizer !== undefined &&
      !(await authorizer.can(c, 'read', ref('agent', pass.agentId)));
    if (pass === null || hidden) {
      return fail(c, 'improvement-pass-not-found', {
        code: 'improvement-pass-not-found',
        message: `No improvement pass ${passId}`,
        passId,
      });
    }
    return pass;
  }

  r.get('/', async (c) => {
    if (passes === undefined) return unsupported(c);
    const agentId = c.req.query('agentId');
    const cursor = c.req.query('cursor');
    const page = await passes.list({
      tenantId: c.get('tenantId') as TenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(agentId !== undefined && agentId !== '' && { agentId }),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
    });
    const readable =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (p) => ref('agent', p.agentId));
    return c.json({
      data: readable.map(serializePass),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:passId', async (c) => {
    const pass = await load(c);
    if (pass instanceof Response) return pass;
    return c.json(serializePass(pass));
  });

  r.post('/:passId/cancel', async (c) => {
    const pass = await load(c);
    if (pass instanceof Response) return pass;
    const denied = await deny(c, authorizer, 'publish', pass.agentId);
    if (denied !== undefined) return denied;
    const actor = actorOf(c);
    const outcome = await (passes as ImprovementPassBinding).cancel({
      tenantId: c.get('tenantId') as TenantId,
      passId: pass.id,
      by: `${actor.kind}:${actor.id}`,
    });
    if (outcome.kind === 'not-found') {
      return fail(c, 'improvement-pass-not-found', {
        code: 'improvement-pass-not-found',
        message: `No improvement pass ${pass.id}`,
        passId: pass.id,
      });
    }
    if (outcome.kind === 'finished') {
      return fail(c, 'improvement-pass-finished', {
        code: 'improvement-pass-finished',
        message: `Improvement pass ${pass.id} has ended (${outcome.pass.status}): there's nothing to cancel`,
        passId: pass.id,
        status: outcome.pass.status,
      });
    }
    return c.json(serializePass(outcome.pass));
  });

  return r;
}

/** What serves the scope now: its live version, else the agent's latest. */
async function servingVersion(
  deps: ImproveDeps,
  tenantId: TenantId,
  agentId: string,
  scope: ImprovementPass['scope'],
): Promise<string | undefined> {
  const live = await deps.releases.live.resolve({ tenantId, agentId, ...coordinatesOf(scope) });
  if (live !== null) return live.version as unknown as string;
  const latest = await deps.agents.get({ tenantId, agentId: agentId as AgentId });
  return latest?.version as unknown as string | undefined;
}

/** The settings blocks a version pins whose schema marks keys tunable. */
async function tunableBlocks(
  blocks: BlockRegistryBinding,
  tenantId: TenantId,
  version: AgentVersionRecord,
): Promise<string[]> {
  const found: string[] = [];
  for (const [blockId, pinned] of Object.entries(version.pins?.settings ?? {})) {
    if (version.modelSettings?.id === blockId) continue;
    const block = await blocks.getVersion({ tenantId, blockId, version: pinned });
    if (block?.kind === 'settings' && tunableKeys(block.content.schema).length > 0) {
      found.push(blockId);
    }
  }
  return found;
}

export function serializePass(p: ImprovementPass): Record<string, unknown> {
  return {
    id: p.id,
    agentId: p.agentId,
    fromVersion: p.fromVersion,
    scope: liveScopeToWire(p.scope),
    suiteId: p.suiteId,
    tiers: p.tiers,
    objective: p.objective,
    budget: p.budget,
    requestedBy: p.requestedBy,
    status: p.status,
    candidatesEvaluated: p.candidatesEvaluated,
    costUsd: p.costUsd,
    ...(p.outcome !== undefined && { outcome: p.outcome }),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(p.finishedAt !== undefined && { finishedAt: p.finishedAt }),
  };
}

// ---------- parsing ----------

interface ImproveBody {
  readonly agentId: string;
  readonly fromVersion?: string;
  readonly scope: ImprovementPass['scope'];
  readonly suiteId: string;
  readonly tiers: readonly ImprovementTier[];
  readonly objective: ProposalObjective;
  readonly budget: ImprovementBudget;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200;
}

function parseBudget(raw: unknown): ImprovementBudget | string {
  if (raw === undefined) return DEFAULT_BUDGET;
  const b = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : undefined;
  const o = b as Record<string, unknown> | undefined;
  const cost = o?.maxCostUsd ?? DEFAULT_BUDGET.maxCostUsd;
  const count = o?.maxCandidates ?? DEFAULT_BUDGET.maxCandidates;
  if (
    o === undefined ||
    Object.keys(o).some((k) => k !== 'maxCostUsd' && k !== 'maxCandidates') ||
    typeof cost !== 'number' ||
    !(cost > 0 && cost <= MAX_COST_USD) ||
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_CANDIDATES
  ) {
    return `\`budget\` is { maxCostUsd?: up to ${MAX_COST_USD}, maxCandidates?: 1 to ${MAX_CANDIDATES} }`;
  }
  return { maxCostUsd: cost, maxCandidates: count };
}

function parseImproveBody(b: Record<string, unknown>): ImproveBody | string {
  const known = ['agentId', 'fromVersion', 'scope', 'suiteId', 'tiers', 'objective', 'budget'];
  const extra = Object.keys(b).find((k) => !known.includes(k));
  if (extra !== undefined) return `\`${extra}\` isn't a field of improve: { ${known.join(', ')} }`;
  if (!nonEmpty(b.agentId)) return '`agentId` is required';
  if (b.fromVersion !== undefined && !nonEmpty(b.fromVersion)) {
    return '`fromVersion` must be a version when given (default: the one serving the scope)';
  }
  const scope = parseLiveScopeBody(b.scope);
  if (scope.kind === 'err') return scope.message;
  if (!nonEmpty(b.suiteId)) return '`suiteId` is required: the test set to search and prove on';
  const tiers = b.tiers ?? ['settings'];
  if (!Array.isArray(tiers) || tiers.length !== 1 || tiers[0] !== 'settings') {
    return "`tiers` is ['settings']: a pass tunes settings blocks";
  }
  if (b.objective !== undefined && !OBJECTIVES.includes(b.objective as ProposalObjective)) {
    return `\`objective\` must be one of ${OBJECTIVES.join(', ')}`;
  }
  const budget = parseBudget(b.budget);
  if (typeof budget === 'string') return budget;
  return {
    agentId: b.agentId,
    ...(typeof b.fromVersion === 'string' && { fromVersion: b.fromVersion }),
    scope: scope.scope,
    suiteId: b.suiteId,
    tiers: ['settings'],
    objective: (b.objective as ProposalObjective | undefined) ?? 'weightedYesShare',
    budget,
  };
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | undefined> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------- helpers ----------

async function deny(c: Ctx, authorizer: Authorizer | undefined, action: Action, agentId: string) {
  if (authorizer === undefined) return undefined;
  const decision = await authorizer.check(c, action, ref('agent', agentId));
  if (decision.allowed) return undefined;
  return fail(c, 'permission-denied', {
    code: 'permission-denied',
    message: `Permission denied: this needs ${action} on agent "${agentId}" (${decision.reason})`,
  });
}

function unsupported(c: Ctx) {
  return fail(c, 'improve-unsupported', {
    code: 'improve-unsupported',
    message: "This runtime doesn't run improvement passes.",
  });
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
