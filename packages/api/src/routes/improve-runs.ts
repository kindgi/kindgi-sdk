// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type Action, ref } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type { CorrectionRegistryBinding, CorrectorGroupScope } from '../correction-binding.js';
import { statusFor, toWireError } from '../errors.js';
import {
  IMPROVE_SCHEDULE_DEFAULTS,
  type ImproveRun,
  type ImproveRunBinding,
  type ImproveRunCheck,
  type ImproveRunStatus,
  type ImproveScheduleInput,
  type ImprovementBudget,
  type ImprovementModel,
  type ImprovementTier,
} from '../improve-run-binding.js';
import { type ItemRights, writeWhereMade } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { refuseReadOnly } from '../registry-read-only.js';
import type { SuggestedChangeObjective } from '../supervisor-binding.js';
import type { TestRunGroupWeights } from '../test-run-binding.js';
import type { AppEnv } from '../types.js';
import { actorOf } from './agent-pins.js';
import { clampLimit } from './pagination.js';
import { UUID_RE } from './uuid-param.js';

type Ctx = Context<AppEnv>;

/** What `POST /v1/improve-runs` checks an Improve run against before it starts. */
export interface ImproveDeps {
  readonly improveRuns?: ImproveRunBinding;
  /** The agent registry: read-only under `kindgi dev`, where no Improve run starts (`readOnly`). */
  readonly agents: AgentRegistryBinding;
  /** Whether a project is suspended: no Improve run starts in one. Absent: no check. */
  readonly projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;
  /**
   * The tenant's corrector groups. The `groupWeights` default counts everyone
   * (`as-recorded`) until an expert group (one with `assertableBy`) is named
   * in the tenant, the Improve run's project, or on the agent improved, then
   * it's `experts-only`. Absent: the default stays `experts-only`. Only
   * `listGroups` is used.
   */
  readonly correctorGroups?: Pick<CorrectionRegistryBinding, 'listGroups'>;
}

/**
 * The Improve run default for `groupWeights` when the caller doesn't set one.
 * Until an expert group (one with `assertableBy`) is named — in the
 * tenant, the project the Improve run reads its corrections from (`projectId`), or on
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
  explicit: TestRunGroupWeights | undefined,
): Promise<TestRunGroupWeights> {
  if (explicit !== undefined) return explicit;
  if (deps.correctorGroups === undefined) return 'experts-only';
  return (await projectHasExpertClass(deps.correctorGroups, tenantId, projectId, agentId))
    ? 'experts-only'
    : 'as-recorded';
}

/**
 * Whether an expert group — one restricted to named asserters
 * (`assertableBy` set) — applies to this Improve run: one in tenant scope, in the
 * Improve run's project, or on the agent being improved (that agent, in that
 * project). A tenant-wide expert group names experts for every project;
 * another agent's group, or another project's, doesn't count.
 *
 * Exported so a caller that resolves the default outside the improve route
 * — an Improve run started from a schedule — decides it exactly the same way.
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

export const DEFAULT_BUDGET: ImprovementBudget = { maxCostUsd: 5, maxCandidates: 30 };
const MAX_COST_USD = 100;
const MAX_CANDIDATES = 200;
const OBJECTIVES: readonly SuggestedChangeObjective[] = ['passRate', 'weightedPrecisionAtK'];
const STATUSES: readonly ImproveRunStatus[] = ['running', 'completed', 'failed', 'cancelled'];

/**
 * `POST /` (under `/v1/improve-runs`): start an Improve run for an agent in
 * a project. It answers 202 with the Improve run; the Improve run carries on
 * in the background (`GET /v1/improve-runs/:id`). It starts from the version
 * the project runs, takes the project's corrections and searches and proves
 * on the project's test set.
 *
 * The readiness check (`POST /check`) runs first: a run that isn't ready is
 * refused with `409 improve-not-ready`, listing every missing item at once,
 * and one while the agent already has a running run in the project with
 * `409 improve-run-running`. Needs `publish` on the agent; for an agent
 * more than one project serves, `write` where its new versions are made
 * (`item-rights.ts`).
 */
function mountStartRoutes(
  r: Hono<AppEnv>,
  deps: ImproveDeps,
  authorizer?: Authorizer,
  itemRights?: ItemRights,
) {
  r.post('/', async (c) => {
    const asked = await askCheck(c, deps, authorizer, itemRights);
    if (asked instanceof Response) return asked;
    const { tenantId, parsed, improveRuns, groupWeights, check, readiness } = asked;
    const missing = blocking(readiness.items, parsed.tiers);
    // The running run alone is `improve-run-running`, with its id; anything else
    // missing is `improve-not-ready`, listing every missing item at once.
    if (missing.length === 1 && check.runningId !== undefined) {
      return running(c, parsed, check.runningId);
    }
    if (missing.length > 0) {
      const keys = missing.map((item) => item.key).join(', ');
      return fail(c, 'improve-not-ready', {
        code: 'improve-not-ready',
        message: `${parsed.agentId} isn't ready for an Improve run in this project: ${keys} missing (\`items\` says how to fix each)`,
        items: missing,
      });
    }
    const started = await improveRuns.start({
      tenantId,
      projectId: parsed.projectId,
      agentId: parsed.agentId,
      ...(parsed.tiers !== undefined && { tiers: parsed.tiers }),
      objective: parsed.objective,
      groupWeights,
      ...(parsed.model !== undefined && { model: parsed.model }),
      ...(parsed.candidates !== undefined && { candidates: parsed.candidates }),
      budget: parsed.budget,
      requestedBy: actorOf(c),
    });
    if (started.kind === 'running') return running(c, parsed, started.improveRunId);
    c.status(202);
    return c.json(serializeImproveRun(started.improveRun));
  });

  r.post('/check', async (c) => {
    const asked = await askCheck(c, deps, authorizer, itemRights);
    if (asked instanceof Response) return asked;
    const { parsed, check, readiness } = asked;
    const { basis } = check;
    const costUsd =
      basis.meanRunCostUsd === undefined
        ? undefined
        : usd(Math.min(parsed.budget.maxCostUsd, basis.replays * Number(basis.meanRunCostUsd)));
    return c.json({
      ready: readiness.ready,
      ...(check.startsFrom !== undefined && { startsFrom: check.startsFrom }),
      items: readiness.items,
      estimate: {
        ...(costUsd !== undefined && { costUsd }),
        maxCostUsd: usd(parsed.budget.maxCostUsd),
        basis: {
          replays: basis.replays,
          ...(basis.meanRunCostUsd !== undefined && { meanRunCostUsd: basis.meanRunCostUsd }),
        },
      },
      ...(check.month !== undefined && { month: check.month }),
    });
  });
}

/** What the binding's check reads, from a parsed start body. */
function checkInput(
  tenantId: TenantId,
  parsed: StartImproveRunBody,
  groupWeights: TestRunGroupWeights,
) {
  return {
    tenantId,
    projectId: parsed.projectId,
    agentId: parsed.agentId,
    ...(parsed.tiers !== undefined && { tiers: parsed.tiers }),
    ...(parsed.model !== undefined && { model: parsed.model }),
    ...(parsed.candidates !== undefined && { candidates: parsed.candidates }),
    groupWeights,
  };
}

/** The `409 improve-run-running` refusal: the agent's running run in the project. */
function running(c: Ctx, parsed: StartImproveRunBody, improveRunId: string) {
  return fail(c, 'improve-run-running', {
    code: 'improve-run-running',
    message: `Improve run ${improveRunId} is running for ${parsed.agentId} in this project: one runs at a time. Wait for it to end, or cancel it.`,
    improveRunId,
  });
}

/**
 * What a start and a check both do first: read the body, ask for `publish` on
 * the agent and for Improve in this runtime, and refuse under `kindgi dev`,
 * where an Improve run is refused as any suggested change is: its change is
 * for one project, and the pack's files serve every one. Then the runtime's
 * check, as the readiness list. The response to send, or what the route
 * goes on with.
 */
async function askCheck(
  c: Ctx,
  deps: ImproveDeps,
  authorizer: Authorizer | undefined,
  itemRights: ItemRights | undefined,
): Promise<
  | Response
  | {
      readonly tenantId: TenantId;
      readonly parsed: StartImproveRunBody;
      readonly improveRuns: ImproveRunBinding;
      readonly groupWeights: TestRunGroupWeights;
      readonly check: ImproveRunCheck;
      readonly readiness: Awaited<ReturnType<typeof readinessOf>>;
    }
> {
  const tenantId = c.get('tenantId') as TenantId;
  const body = await readBody(c);
  if (body === undefined) return badInput(c, 'Request body must be a JSON object');
  const parsed = parseStartImproveRunBody(body);
  if (typeof parsed === 'string') return badInput(c, parsed);
  const denied = await deny(c, authorizer, 'publish', parsed.agentId, itemRights);
  if (denied !== undefined) return denied;
  const improveRuns = deps.improveRuns;
  if (improveRuns === undefined) return unsupported(c);
  if (deps.agents.readOnly !== undefined) return refuseReadOnly(c, deps.agents.readOnly);
  const groupWeights = await resolveGroupWeights(
    deps,
    tenantId,
    parsed.projectId,
    parsed.agentId,
    parsed.groupWeights,
  );
  const check = await improveRuns.check(checkInput(tenantId, parsed, groupWeights));
  const readiness = await readinessOf(deps, tenantId, parsed, check);
  return { tenantId, parsed, improveRuns, groupWeights, check, readiness };
}

/** One line of the readiness list (`POST /v1/improve-runs/check`). */
interface ReadinessItem {
  readonly key: 'wording' | 'settings' | 'test-cases' | 'permission' | 'one-at-a-time' | 'project';
  readonly missing: boolean;
  /** For `test-cases`: the project's active cases of the agent's test set. */
  readonly count?: number;
  /** For a missing `one-at-a-time`: the running Improve run. */
  readonly improveRunId?: string;
  /** For a missing item: where it's fixed (the agent's code, or Kindgi) and how. */
  readonly fix?: { readonly where: 'repo' | 'kindgi'; readonly text: string };
}

/**
 * The readiness list, in its fixed order, from what the runtime knows
 * (`check`) and what the route does: the registry and the project's state.
 * `permission` is never missing here, since both routes refuse a caller
 * without `publish` first.
 */
async function readinessOf(
  deps: ImproveDeps,
  tenantId: TenantId,
  parsed: StartImproveRunBody,
  check: ImproveRunCheck,
): Promise<{ readonly ready: boolean; readonly items: readonly ReadinessItem[] }> {
  const suspended =
    deps.projectSuspended !== undefined &&
    (await deps.projectSuspended(tenantId, parsed.projectId));
  const items: ReadinessItem[] = [
    check.wording
      ? { key: 'wording', missing: false }
      : { key: 'wording', missing: true, fix: { where: 'repo', text: FIX.wording } },
    check.settings
      ? { key: 'settings', missing: false }
      : { key: 'settings', missing: true, fix: { where: 'repo', text: FIX.settings } },
    check.testCases > 0
      ? { key: 'test-cases', missing: false, count: check.testCases }
      : {
          key: 'test-cases',
          missing: true,
          count: check.testCases,
          fix: { where: 'kindgi', text: FIX.testCases },
        },
    { key: 'permission', missing: false },
    check.runningId === undefined
      ? { key: 'one-at-a-time', missing: false }
      : {
          key: 'one-at-a-time',
          missing: true,
          improveRunId: check.runningId,
          fix: {
            where: 'kindgi',
            text: `Improve run ${check.runningId} is running for this agent in this project. Wait for it to end, or cancel it.`,
          },
        },
    suspended
      ? { key: 'project', missing: true, fix: { where: 'kindgi', text: FIX.suspended } }
      : check.startsFrom === undefined
        ? { key: 'project', missing: true, fix: { where: 'repo', text: FIX.notRunning } }
        : { key: 'project', missing: false },
  ];
  return { ready: blocking(items, parsed.tiers).length === 0, items };
}

/**
 * The missing items that keep the Improve run from starting. Wording and
 * settings are its two tiers: with none named, either one is enough; a
 * named tier needs its own. Every other item is needed.
 */
function blocking(
  items: readonly ReadinessItem[],
  tiers: readonly ImprovementTier[] | undefined,
): readonly ReadinessItem[] {
  const missing = (key: ReadinessItem['key']) => items.some((i) => i.key === key && i.missing);
  const noTier = missing('wording') && missing('settings');
  return items.filter((item) => {
    if (!item.missing) return false;
    if (item.key === 'wording') return tiers === undefined ? noTier : tiers.includes('prompt');
    if (item.key === 'settings') return tiers === undefined ? noTier : tiers.includes('settings');
    return true;
  });
}

/** The readiness items' fix texts. None names a file: where the agent's code is isn't known. */
const FIX = {
  wording:
    "Improve rewrites a prompt block's wording with a model. If the instructions are written in code, not in a prompt block, ask your coding agent to move them into one, then deploy. If no model is named to write it, give the run a provider and model, or name them in the version's model-settings block.",
  settings:
    'None of its settings is marked "Improve may tune". Ask your coding agent to mark the settings Improve may tune (a number with a minimum and maximum, or a list of choices) in a settings block, then deploy.',
  testCases:
    "This project's test set has no active case for the agent yet. Add at least one, then check again.",
  suspended:
    "The project is suspended, so nothing new runs in it until it's restored. Restore the project first.",
  notRunning:
    'No version of the agent runs in this project. Deploy the agent to the project first.',
} as const;

/**
 * `/v1/improve-runs`: start an Improve run (`POST /`), check whether one is
 * ready and what it would cost (`POST /check`), read Improve runs back, and
 * cancel one.
 *
 *   POST /                     start an Improve run (202)
 *   POST /check                whether one is ready, and what it would cost
 *   GET  /                     newest first; `?agentId=`, `?projectId=`, `?status=` narrow
 *   GET  /:improveRunId        one
 *   POST /:improveRunId/cancel stop a running Improve run (it writes no suggested change)
 *
 * Authorized on the Improve run's agent: `read`, and `publish` to cancel. An Improve run
 * the caller can't read answers 404. For an agent more than one project
 * serves (`item-rights.ts`): `read` on the agent or any of its projects,
 * and `write` where its new versions are made to cancel.
 */
export function improveRunsRouter(
  deps: ImproveDeps,
  authorizer?: Authorizer,
  itemRights?: ItemRights,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const improveRuns = deps.improveRuns;
  mountStartRoutes(r, deps, authorizer, itemRights);

  async function load(c: Ctx): Promise<ImproveRun | Response> {
    if (improveRuns === undefined) return unsupported(c);
    const improveRunId = c.req.param('improveRunId') ?? '';
    const improveRun = await improveRuns.get({
      tenantId: c.get('tenantId') as TenantId,
      improveRunId,
    });
    const hidden = improveRun !== null && !(await readable(c, improveRun.agentId));
    if (improveRun === null || hidden) {
      return fail(c, 'improve-run-not-found', {
        code: 'improve-run-not-found',
        message: `No Improve run ${improveRunId}`,
        improveRunId,
      });
    }
    return improveRun;
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
    if (improveRuns === undefined) return unsupported(c);
    const agentId = c.req.query('agentId');
    const projectId = c.req.query('projectId') || undefined;
    const status = c.req.query('status') || undefined;
    const cursor = c.req.query('cursor');
    if (projectId !== undefined && !UUID_RE.test(projectId)) {
      return badInput(c, '`projectId` must be a project id (a UUID)');
    }
    if (status !== undefined && !STATUSES.includes(status as ImproveRunStatus)) {
      return badInput(c, `\`status\` must be one of ${STATUSES.join(', ')}`);
    }
    const page = await improveRuns.list({
      tenantId: c.get('tenantId') as TenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(agentId !== undefined && agentId !== '' && { agentId }),
      ...(projectId !== undefined && { projectId: projectId as ProjectId }),
      ...(status !== undefined && { status: status as ImproveRunStatus }),
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
      data: shown.map(serializeImproveRun),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:improveRunId', async (c) => {
    const improveRun = await load(c);
    if (improveRun instanceof Response) return improveRun;
    return c.json(serializeImproveRun(improveRun));
  });

  r.post('/:improveRunId/cancel', async (c) => {
    const improveRun = await load(c);
    if (improveRun instanceof Response) return improveRun;
    const denied = await deny(c, authorizer, 'publish', improveRun.agentId, itemRights);
    if (denied !== undefined) return denied;
    const actor = actorOf(c);
    const outcome = await (improveRuns as ImproveRunBinding).cancel({
      tenantId: c.get('tenantId') as TenantId,
      improveRunId: improveRun.id,
      by: `${actor.kind}:${actor.id}`,
    });
    if (outcome.kind === 'not-found') {
      return fail(c, 'improve-run-not-found', {
        code: 'improve-run-not-found',
        message: `No Improve run ${improveRun.id}`,
        improveRunId: improveRun.id,
      });
    }
    if (outcome.kind === 'finished') {
      return fail(c, 'improve-run-finished', {
        code: 'improve-run-finished',
        message: `Improve run ${improveRun.id} has ended (${outcome.improveRun.status}): there's nothing to cancel`,
        improveRunId: improveRun.id,
        status: outcome.improveRun.status,
      });
    }
    return c.json(serializeImproveRun(outcome.improveRun));
  });

  return r;
}

export function serializeImproveRun(p: ImproveRun): Record<string, unknown> {
  return {
    id: p.id,
    agentId: p.agentId,
    ...(p.projectId !== undefined && { projectId: p.projectId }),
    startsFrom: p.startsFrom,
    ...(p.testSetVersion !== undefined && { testSetVersion: p.testSetVersion }),
    setAside: p.setAside,
    tiers: p.tiers,
    objective: p.objective,
    groupWeights: p.groupWeights,
    ...(p.model !== undefined && { model: p.model }),
    ...(p.candidates !== undefined && { candidates: p.candidates }),
    budget: p.budget,
    requestedBy: p.requestedBy,
    ...(p.trigger !== undefined && { trigger: p.trigger }),
    status: p.status,
    tried: p.tried,
    costUsd: p.costUsd,
    ...(p.outcome !== undefined && { outcome: p.outcome }),
    takes: p.takes,
    ...(p.status === 'cancelled' &&
      p.cancelReason !== undefined && { cancelReason: p.cancelReason }),
    ...(p.comparisons !== undefined && { comparisons: p.comparisons }),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(p.finishedAt !== undefined && { finishedAt: p.finishedAt }),
  };
}

// ---------- parsing ----------

interface StartImproveRunBody {
  readonly agentId: string;
  readonly projectId: ProjectId;
  readonly tiers?: readonly ImprovementTier[];
  readonly objective: SuggestedChangeObjective;
  readonly groupWeights?: TestRunGroupWeights;
  readonly model?: ImprovementModel;
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
}

const MAX_DRAFTED = 5;
const TIERS_RULE =
  "`tiers` is one or both of 'prompt' (drafted prompt templates) and 'settings' (tunable settings values), each once; omit it for every tier that's ready";

/** `tiers`: absent (every tier that's ready), or one or both tiers, each once; else the error. */
function parseTiers(raw: unknown): readonly ImprovementTier[] | undefined | string {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 2 ||
    raw.some((t) => t !== 'settings' && t !== 'prompt') ||
    new Set(raw).size !== raw.length
  ) {
    return TIERS_RULE;
  }
  return raw as ImprovementTier[];
}

/** `model`: absent (the version's own model), or `{ providerId, model }`; else the error. */
function parseModel(raw: unknown): ImprovementModel | undefined | string {
  if (raw === undefined) return undefined;
  const m = raw as Record<string, unknown> | null;
  if (
    typeof m !== 'object' ||
    m === null ||
    !nonEmpty(m.providerId) ||
    !nonEmpty(m.model) ||
    Object.keys(m).length !== 2
  ) {
    return "`model` is { providerId, model }: the tenant's provider and model that drafts the templates; omit it for the model of the version's own model-settings block";
  }
  return { providerId: m.providerId, model: m.model };
}

/** `model` and `candidates`, for the prompt tier only; an error message otherwise. */
function parsePromptOptions(
  b: Record<string, unknown>,
  tiers: readonly ImprovementTier[] | undefined,
): { model?: ImprovementModel; candidates?: number } | string {
  if (tiers !== undefined && !tiers.includes('prompt')) {
    return b.model !== undefined || b.candidates !== undefined
      ? "`model` and `candidates` are for the prompt tier (`tiers` with 'prompt', or no `tiers`)"
      : {};
  }
  const model = parseModel(b.model);
  if (typeof model === 'string') return model;
  const candidates = b.candidates;
  if (candidates === undefined) return model === undefined ? {} : { model };
  if (
    typeof candidates !== 'number' ||
    !Number.isInteger(candidates) ||
    candidates < 1 ||
    candidates > MAX_DRAFTED
  ) {
    return `\`candidates\` is how many templates to draft: 1 to ${MAX_DRAFTED}`;
  }
  return { ...(model !== undefined && { model }), candidates };
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

function parseStartImproveRunBody(b: Record<string, unknown>): StartImproveRunBody | string {
  const known = [
    'agentId',
    'projectId',
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
  if (b.projectId === undefined) {
    return '`projectId` is required: the project the Improve run works in (a UUID)';
  }
  // As the project-ref middleware words it, which answers first on a start.
  if (typeof b.projectId !== 'string' || !UUID_RE.test(b.projectId)) {
    return '`projectId` must be a project id (a UUID)';
  }
  const tiers = parseTiers(b.tiers);
  if (typeof tiers === 'string') return tiers;
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
  const prompt = parsePromptOptions(b, tiers);
  if (typeof prompt === 'string') return prompt;
  const budget = parseBudget(b.budget);
  if (typeof budget === 'string') return budget;
  return {
    agentId: b.agentId,
    projectId: b.projectId as ProjectId,
    ...(tiers !== undefined && { tiers }),
    objective: (b.objective as SuggestedChangeObjective | undefined) ?? 'passRate',
    ...(groupWeights !== undefined && { groupWeights }),
    ...prompt,
    budget,
  };
}

const MAX_MONTHLY_CAP_USD = 1000;
const MAX_CORRECTIONS = 1000;

/**
 * An `improve` schedule's input (`config.input`), defaults applied
 * (`IMPROVE_SCHEDULE_DEFAULTS`): how many new corrections start a run, whose
 * count, what one run and the month may cost, and the run's tiers and model.
 * The schedule's target names the agent and project.
 */
export function parseImproveScheduleInput(
  raw: unknown,
): { kind: 'ok'; input: ImproveScheduleInput } | { kind: 'err'; message: string } {
  const err = (message: string) => ({ kind: 'err' as const, message });
  const b = raw ?? {};
  if (typeof b !== 'object' || Array.isArray(b)) {
    return err("An improve schedule's `config.input` is an object of Improve run options");
  }
  const o = b as Record<string, unknown>;
  const known = ['corrections', 'from', 'runCapUsd', 'monthCapUsd', 'tiers', 'model'];
  const extra = Object.keys(o).find((k) => !known.includes(k));
  if (extra !== undefined) {
    return err(
      `\`${extra}\` isn't an option of an improve schedule's \`config.input\`: { ${known.join(', ')} }`,
    );
  }
  const d = IMPROVE_SCHEDULE_DEFAULTS;
  const corrections = o.corrections ?? d.corrections;
  if (
    typeof corrections !== 'number' ||
    !Number.isInteger(corrections) ||
    corrections < 1 ||
    corrections > MAX_CORRECTIONS
  ) {
    return err(
      `\`corrections\` is how many new corrections sorted to improve start a run: 1 to ${MAX_CORRECTIONS} (default ${d.corrections})`,
    );
  }
  const from = o.from ?? d.from;
  if (from !== 'experts' && from !== 'everyone') {
    return err(
      "`from` is whose corrections count: 'experts' (the project's experts, the default) or 'everyone'",
    );
  }
  const runCapUsd = o.runCapUsd ?? d.runCapUsd;
  if (typeof runCapUsd !== 'number' || !(runCapUsd > 0 && runCapUsd <= MAX_COST_USD)) {
    return err(
      `\`runCapUsd\` is the most one run may cost: more than 0, up to ${MAX_COST_USD} (default ${d.runCapUsd})`,
    );
  }
  const monthCapUsd = o.monthCapUsd ?? d.monthCapUsd;
  if (typeof monthCapUsd !== 'number' || !(monthCapUsd > 0 && monthCapUsd <= MAX_MONTHLY_CAP_USD)) {
    return err(
      `\`monthCapUsd\` is the most its runs may cost a month: more than 0, up to ${MAX_MONTHLY_CAP_USD} (default ${d.monthCapUsd})`,
    );
  }
  const tiers = parseTiers(o.tiers);
  if (typeof tiers === 'string') return err(tiers);
  if (o.model !== undefined && tiers !== undefined && !tiers.includes('prompt')) {
    return err("`model` is for the prompt tier (`tiers` with 'prompt', or no `tiers`)");
  }
  const model = parseModel(o.model);
  if (typeof model === 'string') return err(model);
  return {
    kind: 'ok',
    input: {
      corrections,
      from,
      runCapUsd,
      monthCapUsd,
      ...(tiers !== undefined && { tiers }),
      ...(model !== undefined && { model }),
    },
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
    message: "This runtime doesn't run Improve runs.",
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
