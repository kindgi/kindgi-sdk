// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type AgentId, modelSettingsTunableKeys, tunableKeys } from '@kindgi/agents';
import { type Action, ref } from '@kindgi/authz';
import type { Cursor, ProjectId, Semver, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from '../agent-binding.js';
import type { BlockRegistryBinding } from '../block-binding.js';
import type { CorrectionRegistryBinding, CorrectorGroupScope } from '../correction-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { EvalGroupWeights } from '../test-run-binding.js';
import {
  IMPROVE_SCHEDULE_DEFAULTS,
  type ImproveScheduleInput,
  type ImproveThreshold,
  type ImprovementBudget,
  type ImprovementModel,
  type ImprovementPass,
  type ImprovementPassBinding,
  type ImprovementTier,
} from '../improvement-pass-binding.js';
import { type ItemRights, writeWhereMade } from '../item-rights.js';
import type { AgentReleaseBindings } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type ReferenceScopeBinding,
  liveScopeOutOfScope,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import { refusesCandidates, refusesScope } from '../registry-read-only.js';
import type { SuggestedChangeObjective } from '../supervisor-binding.js';
import type { TestSetRegistryBinding } from '../test-set-binding.js';
import type { AppEnv } from '../types.js';
import { whatRuns } from '../what-runs.js';
import { actorOf, coordinatesOf } from './agent-releases.js';
import { deniedBy } from './denied.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';
import { UUID_RE } from './uuid-param.js';

type Ctx = Context<AppEnv>;

/** What `improve` checks a pass against before it starts. */
export interface ImproveDeps {
  readonly passes?: ImprovementPassBinding;
  readonly agents: AgentRegistryBinding;
  readonly blocks: BlockRegistryBinding;
  readonly releases: AgentReleaseBindings;
  /** What the agent's project may reach (`reference-scope.ts`); absent → as named. */
  readonly referenceScope?: ReferenceScopeBinding;
  /** Whether a project is suspended: no pass starts in one. Absent: no check. */
  readonly projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;
  /**
   * The tenant's corrector groups. The `groupWeights` default counts everyone
   * (`as-recorded`) until an expert group (one with `assertableBy`) is named
   * in the tenant, the project the pass reads its corrections from, or on the
   * agent improved, then it's `experts-only`. Absent: the default stays
   * `experts-only`. Only `listGroups` is used.
   */
  readonly correctorGroups?: Pick<CorrectionRegistryBinding, 'listGroups'>;
  /**
   * Test sets, to resolve the project a pass reads its corrections from: a
   * corrections test set's own `spec.projectId`, else the test set's recorded project.
   * That's the project the `groupWeights` default keys off, not where the
   * agent is made — the two differ when the test set is an earlier environment's.
   * Absent, or the test set records no project: the default keys off the agent
   * version's project. Only `get` is used.
   */
  readonly testSets?: Pick<TestSetRegistryBinding, 'get'>;
}

/**
 * The pass default for `groupWeights` when the caller doesn't set one.
 * Until an expert group (one with `assertableBy`) is named — in the
 * tenant, the project the pass reads its corrections from (`projectId`), or on
 * the agent being improved — Improve counts *everyone's* corrections
 * (`as-recorded`); once one is, the default is trusted corrections only
 * (`experts-only`). An explicit `groupWeights` always wins. With no
 * corrector-group binding wired, the default stays `experts-only` (the prior
 * behavior).
 */
async function resolveGroupWeights(
  deps: ImproveDeps,
  tenantId: TenantId,
  projectId: ProjectId | undefined,
  agentId: string | undefined,
  explicit: EvalGroupWeights | undefined,
): Promise<EvalGroupWeights> {
  if (explicit !== undefined) return explicit;
  if (deps.correctorGroups === undefined) return 'experts-only';
  return (await projectHasExpertClass(deps.correctorGroups, tenantId, projectId, agentId))
    ? 'experts-only'
    : 'as-recorded';
}

/**
 * Whether an expert group — one restricted to named asserters
 * (`assertableBy` set) — applies to this pass: one in tenant scope, in the
 * pass's project, or on the agent being improved (that agent, in that
 * project). A tenant-wide expert group names experts for every project;
 * another agent's group, or another project's, doesn't count.
 *
 * Exported so a caller that resolves the default outside the improve route
 * — a pass started from a schedule — decides it exactly the same way.
 */
export async function projectHasExpertClass(
  registry: Pick<CorrectionRegistryBinding, 'listGroups'>,
  tenantId: TenantId,
  projectId: ProjectId | undefined,
  agentId?: string,
): Promise<boolean> {
  const scopes: CorrectorGroupScope[] = [
    ...(projectId !== undefined ? [{ kind: 'project', projectId } as const] : []),
    ...(projectId !== undefined && agentId !== undefined
      ? [{ kind: 'agent', projectId, agentId } as const]
      : []),
    { kind: 'tenant' } as const,
  ];
  for (const scope of scopes) {
    let cursor: Cursor | undefined;
    do {
      const page = await registry.listGroups({
        tenantId,
        scope,
        limit: 100,
        ...(cursor !== undefined && { cursor }),
      });
      if (page.data.some((c) => c.assertableBy !== undefined)) return true;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return false;
}

/**
 * The project a pass reads its corrections from, which the `groupWeights`
 * default keys off: a corrections test set's own `spec.projectId`, else the test set's
 * recorded project. Undefined when no test set binding is wired or the test set
 * records no project — the caller then falls back to the agent version's
 * project. (The two differ when the test set is an earlier environment's.)
 */
async function testSetProjectId(
  deps: ImproveDeps,
  tenantId: TenantId,
  testSetId: string,
): Promise<ProjectId | undefined> {
  if (deps.testSets === undefined) return undefined;
  const testSet = await deps.testSets.get({ tenantId, testSetId });
  if (testSet === null) return undefined;
  const specProject =
    testSet.kind === 'corrections'
      ? (testSet.spec as { projectId?: ProjectId }).projectId
      : undefined;
  return specProject ?? testSet.projectId;
}

export const DEFAULT_BUDGET: ImprovementBudget = { maxCostUsd: 5, maxCandidates: 30 };
const MAX_COST_USD = 100;
const MAX_CANDIDATES = 200;
const OBJECTIVES: readonly SuggestedChangeObjective[] = [
  'weightedYesShare',
  'weightedPrecisionAtK',
];

/**
 * `POST /improve` (under `/v1/suggested-changes`): start an improvement pass for
 * an agent version and a live scope. It answers 202 with the pass; the
 * pass carries on in the background (`GET /v1/improvement-passes/:id`).
 *
 * Checked first, as evaluating its suggested change would be: the version must be
 * active and pinned, it must pin a settings block with tunable keys, the
 * agent registry must take writes, and the agent must have a live version
 * for the whole tenant. Needs `publish` on the agent; for an agent more
 * than one project serves, `write` where its new versions are made
 * (`item-rights.ts`).
 *
 * The pass works in one project: its test set must be one that project
 * reaches, and its test runs run there. As an improve schedule's: the
 * `projectId` named, else the scope's project, else the agent version's.
 * A project or segment scope must be in it, the version must reach it,
 * and a project other than the version's needs `write` there, as the
 * pass's test runs do. Its suggested change's version is made where the agent's
 * versions are, as any suggested change's.
 */
export function mountImproveRoute(
  r: Hono<AppEnv>,
  deps: ImproveDeps,
  authorizer?: Authorizer,
  itemRights?: ItemRights,
) {
  r.post('/improve', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseImproveBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const denied = await deny(c, authorizer, 'publish', parsed.agentId, itemRights);
    if (denied !== undefined) return denied;
    if (deps.passes === undefined) return unsupported(c);
    // A read-only registry takes a pass only when it takes its candidates.
    if (deps.agents.readOnly !== undefined && refusesCandidates(deps.agents.readOnly)) {
      return fail(c, 'registry-read-only', {
        code: 'registry-read-only',
        message: deps.agents.readOnly.reason,
      });
    }
    const narrower = refusesScope(deps.agents.readOnly, parsed.scope);
    if (narrower !== undefined) {
      return fail(c, 'registry-read-only', { code: 'registry-read-only', message: narrower });
    }
    const target = await resolveImproveTarget(c, deps, authorizer, tenantId, parsed);
    if (target instanceof Response) return target;
    const { from, projectId } = target;
    if (
      projectId !== undefined &&
      deps.projectSuspended !== undefined &&
      (await deps.projectSuspended(tenantId, projectId))
    ) {
      return fail(c, 'project-suspended', {
        code: 'project-suspended',
        message:
          "The pass's project is suspended, so nothing new runs in it until it's restored; the pass wasn't started",
      });
    }
    const nothing = await nothingToTune(deps.blocks, tenantId, from, parsed.tiers[0]);
    if (nothing !== undefined) {
      return fail(c, 'validation-failed', {
        code: 'validation-failed',
        message: nothing.message,
        reason: nothing.reason,
        issues: [],
      });
    }
    if ((await deps.releases.live.resolve({ tenantId, agentId: parsed.agentId })) === null) {
      return fail(c, 'suggested-change-needs-pin', {
        code: 'suggested-change-needs-pin',
        message: `${parsed.agentId} has no live version for the whole tenant, so the version a pass suggests would serve every scope nothing is pinned for. Promote its current version for the tenant first (scope { "kind": "tenant" }), then start the pass.`,
      });
    }
    // The `groupWeights` default keys off the project the pass READS its
    // corrections from — its test set's project — not where the agent is made;
    // the two differ when the test set is an earlier environment's. Only the
    // default needs it, so skip the test set read when `groupWeights` is
    // explicit, or when no corrector-group registry is wired (the default is
    // fixed at `experts-only` either way).
    const readProjectId =
      parsed.groupWeights === undefined && deps.correctorGroups !== undefined
        ? ((await testSetProjectId(deps, tenantId, parsed.testSetId)) ?? from.projectId)
        : from.projectId;
    const pass = await deps.passes.start({
      tenantId,
      ...(projectId !== undefined && { projectId }),
      agentId: parsed.agentId,
      fromVersion: from.version as unknown as string,
      scope: parsed.scope,
      testSetId: parsed.testSetId,
      tiers: parsed.tiers,
      objective: parsed.objective,
      groupWeights: await resolveGroupWeights(
        deps,
        tenantId,
        readProjectId,
        parsed.agentId,
        parsed.groupWeights,
      ),
      ...(parsed.model !== undefined && { model: parsed.model }),
      ...(parsed.candidates !== undefined && { candidates: parsed.candidates }),
      budget: parsed.budget,
      requestedBy: actorOf(c),
    });
    c.status(202);
    return c.json(serializePass(pass));
  });

  r.post('/improve/estimate', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readBody(c);
    if (body === undefined) return badInput(c, 'Request body must be a JSON object');
    const parsed = parseImproveBody(body);
    if (typeof parsed === 'string') return badInput(c, parsed);
    const denied = await deny(c, authorizer, 'publish', parsed.agentId, itemRights);
    if (denied !== undefined) return denied;
    const passes = deps.passes;
    if (passes === undefined || passes.estimateBasis === undefined) return unsupported(c);
    // Resolve and reach-check the same body `/improve` would, so a bad body
    // fails the same way here; the estimate is a read, so it stops there and
    // doesn't take `/improve`'s run-gating refusals.
    const resolved = await resolveImproveTarget(c, deps, authorizer, tenantId, parsed);
    if (resolved instanceof Response) return resolved;
    const basis = await passes.estimateBasis({
      tenantId,
      agentId: parsed.agentId,
      fromVersion: resolved.from.version as string,
      scope: parsed.scope,
      testSetId: parsed.testSetId,
      tiers: parsed.tiers,
      ...(parsed.model !== undefined && { model: parsed.model }),
      ...(parsed.candidates !== undefined && { candidates: parsed.candidates }),
    });
    const estimatedCostUsd =
      basis.meanRunCostUsd === undefined
        ? undefined
        : usd(Math.min(parsed.budget.maxCostUsd, basis.replays * Number(basis.meanRunCostUsd)));
    return c.json({
      ...(estimatedCostUsd !== undefined && { estimatedCostUsd }),
      maxCostUsd: usd(parsed.budget.maxCostUsd),
      basis: {
        replays: basis.replays,
        ...(basis.meanRunCostUsd !== undefined && { meanRunCostUsd: basis.meanRunCostUsd }),
      },
    });
  });
}

/**
 * `/v1/improvement-passes`: read passes back, and cancel one.
 *
 *   GET  /               newest first; `?agentId=` narrows
 *   GET  /:passId        one
 *   POST /:passId/cancel stop a running pass (it writes no suggested change)
 *
 * Authorized on the pass's agent: `read`, and `publish` to cancel. A pass
 * the caller can't read answers 404. For an agent more than one project
 * serves (`item-rights.ts`): `read` on the agent or any of its projects,
 * and `write` where its new versions are made to cancel.
 */
export function improvementPassesRouter(
  passes: ImprovementPassBinding | undefined,
  authorizer?: Authorizer,
  itemRights?: ItemRights,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function load(c: Ctx): Promise<ImprovementPass | Response> {
    if (passes === undefined) return unsupported(c);
    const passId = c.req.param('passId') ?? '';
    const pass = await passes.get({ tenantId: c.get('tenantId') as TenantId, passId });
    const hidden = pass !== null && !(await readable(c, pass.agentId));
    if (pass === null || hidden) {
      return fail(c, 'improvement-pass-not-found', {
        code: 'improvement-pass-not-found',
        message: `No improvement pass ${passId}`,
        passId,
      });
    }
    return pass;
  }

  /** Whether the caller reads the agent: `read` on it, or for one more than one project serves, on any of them. */
  async function readable(c: Ctx, agentId: string): Promise<boolean> {
    if (authorizer === undefined) return true;
    const projects = await itemRights?.multi(c, 'agent', agentId);
    return itemRights !== undefined && projects !== undefined
      ? (await itemRights.read(c, 'agent', agentId, projects)) === undefined
      : authorizer.can(c, 'read', ref('agent', agentId));
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
    const shown =
      authorizer === undefined
        ? page.data
        : itemRights === undefined
          ? await authorizer.filterByCan(c, 'read', page.data, (p) => ref('agent', p.agentId))
          : await itemRights.filterItems(c, 'agent', page.data, {
              idOf: (p) => p.agentId,
              todayRef: (p) => ref('agent', p.agentId),
            });
    return c.json({
      data: shown.map(serializePass),
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
    const denied = await deny(c, authorizer, 'publish', pass.agentId, itemRights);
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

/**
 * Resolve and reach-check an improve body the way `/improve` does before it
 * runs — so `/improve` and `/improve/estimate`, which take the same body,
 * fail it the same way. Resolves the from-version (given, or the one serving
 * the scope), 404s an unknown or inactive one, then the pass's project
 * (`passProject`). Returns the version and the project, or the response to
 * send.
 */
async function resolveImproveTarget(
  c: Ctx,
  deps: ImproveDeps,
  authorizer: Authorizer | undefined,
  tenantId: TenantId,
  parsed: ImproveBody,
): Promise<
  { readonly from: AgentVersionRecord; readonly projectId: ProjectId | undefined } | Response
> {
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
  if (fromVersion === undefined) {
    return fail(c, 'agent-version-not-found', {
      code: 'agent-version-not-found',
      message: `No version of agent "${parsed.agentId}" runs in this scope: none is pinned there, and none is its Latest. Name \`fromVersion\`, or deploy or publish a version into the project first (into a later environment, promote a build that ships one).`,
    });
  }
  if (from === null || from.unregisteredAt !== undefined) {
    return fail(c, 'agent-version-not-found', {
      code: 'agent-version-not-found',
      message: `${parsed.agentId} has no active version ${fromVersion}`,
    });
  }
  const project = await passProject(c, deps, authorizer, tenantId, parsed, from);
  if (project instanceof Response) return project;
  return { from, projectId: project.projectId };
}

/**
 * The project a pass works in, as an improve schedule's (`schedules.ts`):
 * the one named, else the scope's, else the version's. A project or
 * segment scope must be in it; a project other than the version's needs
 * `write` there and must reach the version; it must reach the test set, and
 * the scope the agent. The project, or the refusal. Whether it's suspended
 * is `/improve`'s to ask, since the estimate starts nothing.
 */
async function passProject(
  c: Ctx,
  deps: ImproveDeps,
  authorizer: Authorizer | undefined,
  tenantId: TenantId,
  parsed: ImproveBody,
  from: AgentVersionRecord,
): Promise<{ readonly projectId: ProjectId | undefined } | Response> {
  const scopeProject = scopeProjectOf(parsed.scope);
  const projectId = (parsed.projectId as ProjectId | undefined) ?? scopeProject ?? from.projectId;
  if (scopeProject !== undefined && projectId !== scopeProject) {
    return badInput(
      c,
      "An improve pass's scope must be in its project (`projectId`): it learns from that project's runs",
    );
  }
  const elsewhere = projectId !== undefined && projectId !== from.projectId;
  if (elsewhere) {
    const refused = await deniedBy(authorizer, c, 'write', ref('project', projectId as string));
    if (refused !== undefined) return refused;
  }
  // The scope must reach the agent; then the pass's project must reach
  // the version (when it isn't the version's own) and the test set
  // (`reference-scope.ts`).
  const outOfScope =
    (await liveScopeOutOfScope(deps.referenceScope, tenantId, parsed.agentId, parsed.scope)) ??
    (projectId === undefined
      ? undefined
      : await referencesOutOfScope(deps.referenceScope, tenantId, projectId, [
          ...(elsewhere
            ? [
                {
                  path: '/fromVersion',
                  kind: 'agent' as const,
                  id: parsed.agentId,
                  version: from.version as unknown as string,
                },
              ]
            : []),
          { path: '/testSetId', kind: 'test-set', id: parsed.testSetId },
        ]));
  if (outOfScope !== undefined) return outOfScopeResponse(c, c.get('requestId'), outOfScope);
  return { projectId };
}

/** A project or segment scope's project; `undefined` for the tenant or an org. */
function scopeProjectOf(scope: ImprovementPass['scope']): ProjectId | undefined {
  return scope.kind === 'project' || scope.kind === 'segment' ? scope.projectId : undefined;
}

/** What serves the scope now: its live version, else Latest (`whatRuns`). */
async function servingVersion(
  deps: ImproveDeps,
  tenantId: TenantId,
  agentId: string,
  scope: ImprovementPass['scope'],
): Promise<string | undefined> {
  const runs = await whatRuns(deps.releases, { tenantId, agentId, ...coordinatesOf(scope) });
  return runs?.version as unknown as string | undefined;
}

/**
 * Why a pass of a tier has nothing to work on in a version. `reason` is
 * the refusal's `details.reason`, for a client to tell the two apart
 * without reading `message`.
 */
interface NothingToTune {
  readonly reason: 'no-pinned-prompt-block' | 'no-tunable-keys';
  readonly message: string;
}

/** Why a pass of this tier has nothing to work on in this version; `undefined` when it has. */
async function nothingToTune(
  blocks: BlockRegistryBinding,
  tenantId: TenantId,
  version: AgentVersionRecord,
  tier: ImprovementTier | undefined,
): Promise<NothingToTune | undefined> {
  const named = `${version.id as unknown as string} ${version.version as unknown as string}`;
  if (tier === 'prompt') {
    const prompt =
      typeof version.instructions === 'object' ? version.instructions.prompt : undefined;
    return prompt !== undefined && version.pins?.prompts[prompt] !== undefined
      ? undefined
      : {
          reason: 'no-pinned-prompt-block',
          message: `${named} doesn't take its instructions from a pinned prompt block: there's no template for a prompt pass to draft. Move the instructions into a prompt block and publish the agent again.`,
        };
  }
  // Why the model-settings block's model keys aren't tried, if they aren't.
  let skipped: string | undefined;
  for (const [blockId, pinned] of Object.entries(version.pins?.settings ?? {})) {
    const block = await blocks.getVersion({ tenantId, blockId, version: pinned });
    if (block?.kind !== 'settings') continue;
    const tunable: { readonly keys: readonly unknown[]; readonly skipped?: string } =
      version.modelSettings?.id === blockId
        ? modelSettingsTunableKeys(block.content.schema, version)
        : { keys: tunableKeys(block.content.schema) };
    if (tunable.keys.length > 0) return undefined;
    skipped ??= tunable.skipped;
  }
  const why = skipped === undefined ? '' : ` In its model-settings block, ${skipped}.`;
  return {
    reason: 'no-tunable-keys',
    message: `${named} pins no settings block with keys marked "x-kindgi-tunable": there's nothing for a pass to tune. Mark the keys it may tune in the block's schema (a number or integer with a minimum and maximum, or an enum) and publish it.${why}`,
  };
}

export function serializePass(p: ImprovementPass): Record<string, unknown> {
  return {
    id: p.id,
    agentId: p.agentId,
    fromVersion: p.fromVersion,
    scope: liveScopeToWire(p.scope),
    testSetId: p.testSetId,
    tiers: p.tiers,
    objective: p.objective,
    groupWeights: p.groupWeights,
    ...(p.model !== undefined && { model: p.model }),
    ...(p.candidates !== undefined && { candidates: p.candidates }),
    budget: p.budget,
    requestedBy: p.requestedBy,
    status: p.status,
    candidatesEvaluated: p.candidatesEvaluated,
    costUsd: p.costUsd,
    ...(p.outcome !== undefined && { outcome: p.outcome }),
    ...(p.status === 'cancelled' &&
      p.cancelReason !== undefined && { cancelReason: p.cancelReason }),
    ...(p.comparisons !== undefined && { comparisons: p.comparisons }),
    ...(p.trigger !== undefined && { trigger: p.trigger }),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(p.finishedAt !== undefined && { finishedAt: p.finishedAt }),
  };
}

// ---------- parsing ----------

interface ImproveBody {
  readonly agentId: string;
  readonly fromVersion?: string;
  readonly projectId?: string;
  readonly scope: ImprovementPass['scope'];
  readonly testSetId: string;
  readonly tiers: readonly ImprovementTier[];
  readonly objective: SuggestedChangeObjective;
  readonly groupWeights?: EvalGroupWeights;
  readonly model?: ImprovementModel;
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
}

const MAX_DRAFTED = 5;

/** `model` and `candidates`, for a prompt pass only; an error message otherwise. */
function parsePromptOptions(
  b: Record<string, unknown>,
  tier: ImprovementTier,
): { model?: ImprovementModel; candidates?: number } | string {
  if (tier !== 'prompt') {
    return b.model !== undefined || b.candidates !== undefined
      ? "`model` and `candidates` are for a prompt pass (`tiers: ['prompt']`)"
      : {};
  }
  const m = b.model as Record<string, unknown> | undefined;
  if (
    typeof m !== 'object' ||
    m === null ||
    !nonEmpty(m.providerId) ||
    !nonEmpty(m.model) ||
    Object.keys(m).length !== 2
  ) {
    return "`model` is required for a prompt pass: { providerId, model }, the tenant's provider and model that drafts the templates";
  }
  const candidates = b.candidates ?? 3;
  if (
    typeof candidates !== 'number' ||
    !Number.isInteger(candidates) ||
    candidates < 1 ||
    candidates > MAX_DRAFTED
  ) {
    return `\`candidates\` is how many templates to draft: 1 to ${MAX_DRAFTED}`;
  }
  return { model: { providerId: m.providerId, model: m.model }, candidates };
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
  const known = [
    'agentId',
    'fromVersion',
    'projectId',
    'scope',
    'testSetId',
    'tiers',
    'objective',
    'groupWeights',
    'model',
    'candidates',
    'budget',
  ];
  const extra = Object.keys(b).find((k) => !known.includes(k));
  if (extra !== undefined) return `\`${extra}\` isn't a field of improve: { ${known.join(', ')} }`;
  if (!nonEmpty(b.agentId)) return '`agentId` is required';
  if (b.fromVersion !== undefined && !nonEmpty(b.fromVersion)) {
    return '`fromVersion` must be a version when given (default: the one serving the scope)';
  }
  if (
    b.projectId !== undefined &&
    (typeof b.projectId !== 'string' || !UUID_RE.test(b.projectId))
  ) {
    return '`projectId` must be a project id (a UUID)';
  }
  const scope = parseLiveScopeBody(b.scope);
  if (scope.kind === 'err') return scope.message;
  if (!nonEmpty(b.testSetId)) return '`testSetId` is required: the test set to search and prove on';
  const options = parsePassOptions(b);
  if (typeof options === 'string') return options;
  return {
    agentId: b.agentId,
    ...(typeof b.fromVersion === 'string' && { fromVersion: b.fromVersion }),
    ...(typeof b.projectId === 'string' && { projectId: b.projectId }),
    scope: scope.scope,
    testSetId: b.testSetId,
    ...options,
  };
}

type PassOptions = Pick<
  ImproveBody,
  'tiers' | 'objective' | 'groupWeights' | 'model' | 'candidates' | 'budget'
>;

/** A pass's options (`tiers`, `objective`, `groupWeights`, `model`, `candidates`, `budget`), defaults applied. */
function parsePassOptions(b: Record<string, unknown>): PassOptions | string {
  const tiers = b.tiers ?? ['settings'];
  if (
    !Array.isArray(tiers) ||
    tiers.length !== 1 ||
    (tiers[0] !== 'settings' && tiers[0] !== 'prompt')
  ) {
    return "`tiers` is ['settings'] (tunable settings values) or ['prompt'] (a drafted prompt template)";
  }
  const tier = tiers[0] as ImprovementTier;
  if (b.objective !== undefined && !OBJECTIVES.includes(b.objective as SuggestedChangeObjective)) {
    return `\`objective\` must be one of ${OBJECTIVES.join(', ')}`;
  }
  const groupWeights = b.groupWeights;
  if (
    groupWeights !== undefined &&
    groupWeights !== 'experts-only' &&
    groupWeights !== 'as-recorded'
  ) {
    return "`groupWeights` is 'experts-only' (trusted corrections) or 'as-recorded' (everyone); omit it for the project's default";
  }
  const prompt = parsePromptOptions(b, tier);
  if (typeof prompt === 'string') return prompt;
  const budget = parseBudget(b.budget);
  if (typeof budget === 'string') return budget;
  return {
    tiers: [tier],
    objective: (b.objective as SuggestedChangeObjective | undefined) ?? 'weightedYesShare',
    ...(groupWeights !== undefined && { groupWeights }),
    ...prompt,
    budget,
  };
}

const MAX_MONTHLY_CAP_USD = 1000;
const MAX_THRESHOLD = 1000;

/**
 * An `improve` schedule's input (`config.input`), defaults applied: the
 * pass options `improve` takes (no agent, scope or test set: the schedule
 * names those, and each pass builds its test set), plus `threshold` and
 * `monthlyCapUsd`.
 */
export function parseImproveScheduleInput(
  raw: unknown,
): { kind: 'ok'; input: ImproveScheduleInput } | { kind: 'err'; message: string } {
  const err = (message: string) => ({ kind: 'err' as const, message });
  const b = raw ?? {};
  if (typeof b !== 'object' || Array.isArray(b)) {
    return err("An improve schedule's `config.input` is an object of pass options");
  }
  const o = b as Record<string, unknown>;
  const known = [
    'tiers',
    'objective',
    'groupWeights',
    'model',
    'candidates',
    'budget',
    'threshold',
    'monthlyCapUsd',
  ];
  const extra = Object.keys(o).find((k) => !known.includes(k));
  if (extra !== undefined) {
    return err(
      `\`${extra}\` isn't an option of an improve schedule's \`config.input\`: { ${known.join(', ')} }`,
    );
  }
  const options = parsePassOptions(o);
  if (typeof options === 'string') return err(options);
  const threshold = parseThreshold(o.threshold);
  if (typeof threshold === 'string') return err(threshold);
  const cap = o.monthlyCapUsd ?? IMPROVE_SCHEDULE_DEFAULTS.monthlyCapUsd;
  if (typeof cap !== 'number' || !(cap > 0 && cap <= MAX_MONTHLY_CAP_USD)) {
    return err(
      `\`monthlyCapUsd\` is the most its passes may cost a month: more than 0, up to ${MAX_MONTHLY_CAP_USD}`,
    );
  }
  return { kind: 'ok', input: { ...options, threshold, monthlyCapUsd: cap } };
}

function parseThreshold(raw: unknown): ImproveThreshold | string {
  const d = IMPROVE_SCHEDULE_DEFAULTS.threshold;
  if (raw === undefined) return d;
  const o =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const t = {
    corrections: o?.corrections ?? d.corrections,
    runs: o?.runs ?? d.runs,
    correctors: o?.correctors ?? d.correctors,
  };
  const whole = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_THRESHOLD;
  if (
    o === undefined ||
    Object.keys(o).some((k) => !['corrections', 'runs', 'correctors'].includes(k)) ||
    !whole(t.corrections) ||
    !whole(t.runs) ||
    !whole(t.correctors) ||
    t.runs > t.corrections ||
    t.correctors > t.corrections
  ) {
    return `\`threshold\` is { corrections?, runs?, correctors? }: how many answers marked wrong since the last Improve run (default ${d.corrections}), across how many runs (${d.runs}) and from how many correctors (${d.correctors}); runs and correctors at most corrections`;
  }
  return t as ImproveThreshold;
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

/**
 * `undefined` when allowed; else the 403. For an agent more than one
 * project serves, `publish` is `write` where its new versions are made.
 */
async function deny(
  c: Ctx,
  authorizer: Authorizer | undefined,
  action: Action,
  agentId: string,
  itemRights?: ItemRights,
) {
  if (authorizer === undefined) return undefined;
  const projects = await itemRights?.multi(c, 'agent', agentId);
  if (itemRights !== undefined && projects !== undefined) {
    return writeWhereMade(
      c,
      itemRights,
      { kind: 'agent', id: agentId },
      projects,
      `improving agent "${agentId}"`,
    );
  }
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

/** A US-dollar amount as a decimal string: rounded to the millionth, trailing zeros dropped. */
function usd(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}
