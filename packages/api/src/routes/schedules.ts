// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import { type Action, type ResourceRef, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, TenantId, TriggerId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type CronTriggerRecord,
  type RegisterCronTriggerInput,
  SCHEDULE_DEFAULTS,
  type ScheduleCatchUp,
  type ScheduleOverlap,
  type TriggerFire,
  type TriggerRegistryBinding,
  type TriggerTarget,
  type UpdateCronTriggerInput,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { parseImproveScheduleInput } from './improvement-passes.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';
import { type TriggerOwnerNames, ownerJson, ownerNamesOf, ownerOf } from './trigger-owners.js';
import { UUID_RE } from './uuid-param.js';

/**
 * Schedules: cron-kind triggers that start a run of an agent or a flow.
 *
 *   POST /v1/schedules                          register
 *   GET  /v1/schedules                          list (cursor-paginated)
 *   GET  /v1/schedules/:triggerId[?upcoming=N]  get, with its next N occurrences
 *   PATCH /v1/schedules/:triggerId              update
 *   POST /v1/schedules/:triggerId/pause | resume | unregister
 *   GET  /v1/schedules/:triggerId/fires         its fire history, newest first
 *   POST /v1/schedules/:triggerId/run-now       fire it now, outside the schedule
 *   POST /v1/schedules/:triggerId/owner         the caller becomes the owner
 *
 * A schedule's runs act as its owner (whoever registered it, until an
 * admin takes it over), checked again at every fire. With an authorizer:
 * reads need `read` on the schedule's project, changes `write`, taking
 * ownership `admin`, and registering or retargeting also needs `execute`
 * on what it runs, as starting that run does. The `triggerId` is aliased
 * as `scheduleId` in bodies.
 */
export function schedulesRouter(
  binding: TriggerRegistryBinding,
  authorizer?: Authorizer,
  /** The tenant's Default project: where a schedule that names no project goes. */
  projects?: Pick<ProjectBinding, 'getDefault'>,
  /** Where an owner's name is read (`owner.displayName`); see `TriggerOwnerNames`. */
  names?: TriggerOwnerNames,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const ownerNames = (tenantId: TenantId, rows: readonly CronTriggerRecord[]) =>
    ownerNamesOf(
      names,
      tenantId,
      rows.map((row) => row.owner),
    );

  /** A schedule as the wire carries it, its owner named. */
  async function scheduleJson(c: Context<AppEnv>, row: CronTriggerRecord): Promise<Response> {
    const named = await ownerNames(c.get('tenantId') as TenantId, [row]);
    return c.json(serializeSchedule(row, named));
  }

  /** Nothing, when allowed; else the authorizer's own 403. */
  async function denied(
    c: Context<AppEnv>,
    action: Action,
    resource: ResourceRef,
  ): Promise<Response | undefined> {
    if (authorizer === undefined) return undefined;
    let allowed = false;
    const answer = await authorizer.authorize(action, async () => resource)(c, async () => {
      allowed = true;
    });
    return allowed ? undefined : (answer as Response);
  }

  /** The schedule, if it is one (another kind's id is not found here), and the caller may `action` it. */
  async function scheduleFor(
    c: Context<AppEnv>,
    action: Action,
  ): Promise<{ kind: 'ok'; value: CronTriggerRecord } | { kind: 'err'; response: Response }> {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const rec = UUID_RE.test(triggerId) ? await binding.get({ tenantId, triggerId }) : null;
    if (rec === null || rec.kind !== 'cron') {
      return { kind: 'err', response: notFound(c, requestId, triggerId) };
    }
    const refused = await denied(c, action, ref('project', rec.projectId as unknown as string));
    if (refused !== undefined) return { kind: 'err', response: refused };
    return { kind: 'ok', value: rec };
  }

  // ---------- POST / (register) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;

    const target = parseTarget(body);
    if (target.kind === 'err') return bad(c, requestId, target.message);
    const cronExpression = requireString(body, 'config.cronExpression');
    if (cronExpression.kind === 'err') return bad(c, requestId, cronExpression.message);
    const policy = parsePolicy(body);
    if (policy.kind === 'err') return bad(c, requestId, policy.message);
    const projectId = body.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !UUID_RE.test(projectId))) {
      return bad(c, requestId, '`projectId` must be a project id (a UUID)');
    }
    const rawConfig = (body.config ?? {}) as Record<string, unknown>;
    const input = targetInput(target.value, rawConfig.input);
    if (input.kind === 'err') return bad(c, requestId, input.message);

    // A schedule that names no project goes in its improve scope's
    // project, else the tenant's Default project: checked and stored as
    // that project. With no Default to find, the registry picks it, and
    // only a tenant admin may.
    const project =
      (projectId as string | undefined) ??
      scopeProjectOf(target.value) ??
      ((await projects?.getDefault(tenantId))?.id as string | undefined);
    const scopeProblem = improveScopeProblem(target.value, project);
    if (scopeProblem !== undefined) return bad(c, requestId, scopeProblem);
    const refused =
      (project === undefined
        ? await denied(c, 'admin', ref('tenant', tenantId as unknown as string))
        : await denied(c, 'write', ref('project', project))) ??
      (await denied(c, ...targetAccess(target.value)));
    if (refused !== undefined) return refused;

    const registerInput: RegisterCronTriggerInput = {
      kind: 'cron',
      tenantId,
      target: target.value,
      ...(project !== undefined && { projectId: project as ProjectId }),
      owner: ownerOf(c),
      config: {
        cronExpression: cronExpression.value,
        ...(typeof rawConfig.timezone === 'string' && { timezone: rawConfig.timezone }),
        ...(input.input !== undefined && { input: input.input }),
      },
      ...policy.value,
      ...(typeof body.label === 'string' && body.label.length > 0 && { label: body.label }),
    };

    const result = await binding.register(registerInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message }, requestId),
      );
    }
    c.status(201);
    return scheduleJson(c, result.value as CronTriggerRecord);
  });

  // ---------- GET / (list) ----------
  // The tenant's schedules, then only those whose project the caller may
  // read (`read` on it, as reading one schedule needs): a schedule's input
  // and target are its project's. The page and its cursor are the
  // tenant's, so a page can hold fewer than `limit` rows and still have more.
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const statusRaw = c.req.query('status');
    const projectRaw = c.req.query('projectId');
    if (projectRaw !== undefined && !UUID_RE.test(projectRaw)) {
      return bad(c, c.get('requestId'), '`projectId` must be a project id (a UUID)');
    }
    const projectId = projectRaw as ProjectId | undefined;
    // A project filter needs read on that project, as the agents' and tools'
    // lists do: else an empty page (with `hasMore` and a cursor into that
    // project's rows) would say whether it has schedules.
    if (projectId !== undefined) {
      const refused = await denied(c, 'read', ref('project', projectId as unknown as string));
      if (refused !== undefined) return refused;
    }

    let statusFilter: 'active' | 'paused' | undefined;
    if (statusRaw === 'active' || statusRaw === 'paused') statusFilter = statusRaw;

    const page = await binding.list({
      tenantId,
      kind: 'cron',
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(statusFilter !== undefined && { status: statusFilter }),
      ...(projectId !== undefined && { projectId }),
    });
    // The binding narrows to the project; this keeps a page right from one that doesn't.
    const rows = (page.data as CronTriggerRecord[]).filter(
      (row) => projectId === undefined || row.projectId === projectId,
    );
    const visible =
      authorizer === undefined
        ? rows
        : await authorizer.filterByCan(c, 'read', rows, (rec) =>
            ref('project', rec.projectId as unknown as string),
          );
    const named = await ownerNames(tenantId, visible);
    return c.json({
      data: visible.map((row) => serializeSchedule(row, named)),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:triggerId (get) ----------
  r.get('/:triggerId', async (c) => {
    const requestId = c.get('requestId');
    const upcomingRaw = c.req.query('upcoming');
    const upcoming = upcomingRaw === undefined ? undefined : Number(upcomingRaw);
    if (upcoming !== undefined && (!Number.isInteger(upcoming) || upcoming < 1 || upcoming > 20)) {
      return bad(c, requestId, '`upcoming` must be a whole number from 1 to 20');
    }
    const found = await scheduleFor(c, 'read');
    if (found.kind === 'err') return found.response;
    if (upcoming === undefined) return scheduleJson(c, found.value);
    const rec = await binding.get({
      tenantId: c.get('tenantId') as TenantId,
      triggerId: found.value.triggerId,
      upcoming,
    });
    return scheduleJson(c, (rec ?? found.value) as CronTriggerRecord);
  });

  // ---------- PATCH /:triggerId (update) ----------
  r.patch('/:triggerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;

    const retarget =
      'flowId' in body ||
      'agentId' in body ||
      'flowVersion' in body ||
      'agentVersion' in body ||
      'improve' in body;
    const target = retarget ? parseTarget(body) : undefined;
    if (target?.kind === 'err') return bad(c, requestId, target.message);
    const policy = parsePolicy(body);
    if (policy.kind === 'err') return bad(c, requestId, policy.message);

    const found = await scheduleFor(c, 'write');
    if (found.kind === 'err') return found.response;
    if (target !== undefined) {
      const scopeProblem = improveScopeProblem(
        target.value,
        found.value.projectId as unknown as string,
      );
      if (scopeProblem !== undefined) return bad(c, requestId, scopeProblem);
      const refused = await denied(c, ...targetAccess(target.value));
      if (refused !== undefined) return refused;
    }

    const patchConfig = body.config as Record<string, unknown> | undefined;
    const cfg: Partial<{ cronExpression: string; timezone: string; input: unknown }> = {};
    if (patchConfig !== undefined) {
      if (typeof patchConfig.cronExpression === 'string')
        cfg.cronExpression = patchConfig.cronExpression;
      if (typeof patchConfig.timezone === 'string') cfg.timezone = patchConfig.timezone;
      if ('input' in patchConfig) cfg.input = patchConfig.input;
    }
    if (target !== undefined || 'input' in cfg) {
      const input = targetInput(
        target?.value ?? found.value.target,
        'input' in cfg ? cfg.input : found.value.config.input,
      );
      if (input.kind === 'err') return bad(c, requestId, input.message);
      if (input.input !== undefined) cfg.input = input.input;
    }

    const triggerId = found.value.triggerId;
    const updateInput: UpdateCronTriggerInput = {
      kind: 'cron',
      tenantId,
      triggerId,
      ...(Object.keys(cfg).length > 0 && { config: cfg }),
      ...(target !== undefined && { target: target.value }),
      ...policy.value,
      ...('label' in body && { label: body.label === null ? null : (body.label as string) }),
    };

    const result = await binding.update(updateInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError(
          {
            code: result.error.code,
            message: result.error.message,
            triggerId: triggerId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return scheduleJson(c, result.value as CronTriggerRecord);
  });

  // ---------- POST /:triggerId/pause | resume ----------
  for (const verb of ['pause', 'resume'] as const) {
    r.post(`/:triggerId/${verb}`, async (c) => {
      const requestId = c.get('requestId');
      const found = await scheduleFor(c, 'write');
      if (found.kind === 'err') return found.response;
      const { tenantId, triggerId } = found.value;
      const result = await binding[verb]({ tenantId, triggerId });
      if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
      return scheduleJson(c, result.value as CronTriggerRecord);
    });
  }

  // ---------- POST /:triggerId/unregister (soft delete) ----------
  r.post('/:triggerId/unregister', async (c) => {
    const found = await scheduleFor(c, 'write');
    if (found.kind === 'err') return found.response;
    const { tenantId, triggerId } = found.value;
    const outcome = await binding.unregister({ tenantId, triggerId });
    return c.json({
      scheduleId: triggerId as unknown as string,
      unregistered: outcome.unregistered,
    });
  });

  // ---------- GET /:triggerId/fires (history) ----------
  r.get('/:triggerId/fires', async (c) => {
    const requestId = c.get('requestId');
    const found = await scheduleFor(c, 'read');
    if (found.kind === 'err') return found.response;
    if (binding.listFires === undefined) return unsupported(c, requestId, 'fire history');
    const cursorRaw = c.req.query('cursor');
    const page = await binding.listFires({
      tenantId: found.value.tenantId,
      triggerId: found.value.triggerId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
    });
    return c.json({
      data: page.data.map(serializeFire),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST /:triggerId/run-now ----------
  r.post('/:triggerId/run-now', async (c) => {
    const requestId = c.get('requestId');
    const found = await scheduleFor(c, 'write');
    if (found.kind === 'err') return found.response;
    if (binding.fireNow === undefined) return unsupported(c, requestId, 'run-now');
    const { tenantId, triggerId } = found.value;
    const result = await binding.fireNow({ tenantId, triggerId });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    c.status(202);
    return c.json(serializeFire(result.value));
  });

  // ---------- POST /:triggerId/owner (take ownership) ----------
  r.post('/:triggerId/owner', async (c) => {
    const requestId = c.get('requestId');
    const found = await scheduleFor(c, 'admin');
    if (found.kind === 'err') return found.response;
    if (binding.setOwner === undefined) return unsupported(c, requestId, 'changing the owner');
    const refused = await denied(c, ...targetAccess(found.value.target));
    if (refused !== undefined) return refused;
    const { tenantId, triggerId } = found.value;
    const result = await binding.setOwner({ tenantId, triggerId, owner: ownerOf(c) });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    return scheduleJson(c, result.value as CronTriggerRecord);
  });

  return r;
}

// -----------------------------------------------------------------------
// Shared helpers (co-located to keep each router self-contained).
// -----------------------------------------------------------------------

/** A target on the wire: `flowId` + `flowVersion`, `agentId` (+ `agentVersion`), or `improve`. */
function targetFields(target: TriggerTarget): Record<string, unknown> {
  switch (target.kind) {
    case 'flow':
      return { flowId: target.flowId, flowVersion: target.flowVersion };
    case 'agent':
      return {
        agentId: target.agentId,
        ...(target.agentVersion !== undefined && { agentVersion: target.agentVersion }),
      };
    case 'improve':
      return { improve: { agentId: target.agentId, scope: liveScopeToWire(target.scope) } };
  }
}

function serializeSchedule(
  r: CronTriggerRecord,
  names: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> {
  return {
    scheduleId: r.triggerId as unknown as string,
    triggerId: r.triggerId as unknown as string,
    ...targetFields(r.target),
    projectId: r.projectId as unknown as string,
    owner: ownerJson(r.owner, names),
    cronExpression: r.config.cronExpression,
    ...(r.config.timezone !== undefined && { timezone: r.config.timezone }),
    ...(r.config.input !== undefined && { input: r.config.input }),
    catchUp: r.catchUp,
    overlap: r.overlap,
    startingDeadlineSeconds: r.startingDeadlineSeconds,
    label: r.label,
    status: r.status,
    ...(r.statusReason !== undefined && { statusReason: r.statusReason }),
    nextFireAt: r.nextFireAt,
    ...(r.upcoming !== undefined && { upcoming: r.upcoming }),
    lastFiredAt: r.lastFiredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function serializeFire(f: TriggerFire): Record<string, unknown> {
  return {
    fireId: f.fireId,
    scheduleId: f.triggerId as unknown as string,
    triggerId: f.triggerId as unknown as string,
    ...(f.scheduledFor !== undefined && { scheduledFor: f.scheduledFor }),
    firedAt: f.firedAt,
    outcome: f.outcome,
    ...(f.runId !== undefined && { runId: f.runId }),
    ...(f.passId !== undefined && { passId: f.passId }),
    ...(f.detail !== undefined && { detail: f.detail }),
    ...(f.missedCount !== undefined && { missedCount: f.missedCount }),
    ...(f.manual === true && { manual: true }),
  };
}

/**
 * What firing the target needs, as starting it by hand does: `execute` on
 * the agent or flow a run starts; `publish` on the agent an improvement
 * pass works on (as `POST /v1/proposals/improve`).
 */
function targetAccess(target: TriggerTarget): [Action, ResourceRef] {
  switch (target.kind) {
    case 'flow':
      return ['execute', ref('flow', target.flowId)];
    case 'agent':
      return ['execute', ref('agent', target.agentId)];
    case 'improve':
      return ['publish', ref('agent', target.agentId)];
  }
}

/** `flowId` + `flowVersion`, `agentId` (+ `agentVersion`), or `improve`: exactly one target. */
function parseTarget(
  body: Record<string, unknown>,
): { kind: 'ok'; value: TriggerTarget } | { kind: 'err'; message: string } {
  const { flowId, flowVersion, agentId, agentVersion, improve } = body;
  const named = (v: unknown) => typeof v === 'string' && v.length > 0;
  if ([named(flowId), named(agentId), improve !== undefined].filter(Boolean).length !== 1) {
    return {
      kind: 'err',
      message:
        'Name what the schedule runs: `flowId` (with `flowVersion`), `agentId`, or `improve` ({ agentId, scope }), one of them',
    };
  }
  if (improve !== undefined) return parseImproveTarget(improve, flowVersion, agentVersion);
  if (named(flowId)) {
    if (!named(flowVersion))
      return { kind: 'err', message: '`flowVersion` is required with `flowId`' };
    if (agentVersion !== undefined) {
      return { kind: 'err', message: '`agentVersion` goes with `agentId`, not `flowId`' };
    }
    return {
      kind: 'ok',
      value: { kind: 'flow', flowId: flowId as string, flowVersion: flowVersion as string },
    };
  }
  if (flowVersion !== undefined) {
    return { kind: 'err', message: '`flowVersion` goes with `flowId`, not `agentId`' };
  }
  if (agentVersion !== undefined && !named(agentVersion)) {
    return { kind: 'err', message: '`agentVersion` must be a version (semver)' };
  }
  return {
    kind: 'ok',
    value: {
      kind: 'agent',
      agentId: agentId as string,
      ...(agentVersion !== undefined && { agentVersion: agentVersion as string }),
    },
  };
}

/** An improve scope's project, when it names one. */
function scopeProjectOf(target: TriggerTarget): string | undefined {
  if (target.kind !== 'improve') return undefined;
  const { scope } = target;
  return scope.kind === 'project' || scope.kind === 'segment'
    ? (scope.projectId as unknown as string)
    : undefined;
}

/**
 * A pass's evidence must cover the scope it changes: an improve schedule
 * learns from its project's runs (for a segment scope, that segment's),
 * so its scope is the schedule's own project or a segment of it. The
 * tenant and an org span projects: going wider stays a promotion by hand,
 * through that scope's gate.
 */
function improveScopeProblem(
  target: TriggerTarget,
  project: string | undefined,
): string | undefined {
  if (target.kind !== 'improve') return undefined;
  if (target.scope.kind === 'tenant' || target.scope.kind === 'org') {
    return `An improve schedule's scope is a project or a segment of it, not the ${target.scope.kind === 'org' ? 'org' : 'tenant'}: a pass's evidence must cover the scope it changes, and it learns from one project's runs. Use the project (or a segment) scope; promote to the ${target.scope.kind === 'org' ? 'org' : 'tenant'} by hand after review.`;
  }
  const own = scopeProjectOf(target);
  if (own !== undefined && project !== undefined && own !== project) {
    return "An improve schedule's scope must be in the schedule's project (`projectId`): it learns from that project's runs";
  }
  return undefined;
}

function parseImproveTarget(
  improve: unknown,
  flowVersion: unknown,
  agentVersion: unknown,
): { kind: 'ok'; value: TriggerTarget } | { kind: 'err'; message: string } {
  const shape =
    'An improve schedule names `improve: { agentId, scope }`: the agent its passes work on, and the live scope they propose for';
  if (flowVersion !== undefined || agentVersion !== undefined) {
    return {
      kind: 'err',
      message: `${shape}; \`flowVersion\` and \`agentVersion\` don't go with it`,
    };
  }
  const o =
    typeof improve === 'object' && improve !== null && !Array.isArray(improve)
      ? (improve as Record<string, unknown>)
      : undefined;
  if (
    o === undefined ||
    Object.keys(o).some((k) => k !== 'agentId' && k !== 'scope') ||
    typeof o.agentId !== 'string' ||
    o.agentId.length === 0
  ) {
    return { kind: 'err', message: shape };
  }
  const scope = parseLiveScopeBody(o.scope);
  if (scope.kind === 'err') return { kind: 'err', message: `\`improve.scope\`: ${scope.message}` };
  return { kind: 'ok', value: { kind: 'improve', agentId: o.agentId, scope: scope.scope } };
}

/**
 * The input a target's fires get, or why it can't be: an agent's run takes
 * the agent payload, so an agent schedule's input must carry the message
 * each run sends (without it every fire would be refused); an improve
 * schedule's input is its pass options, kept with the defaults applied; a
 * flow's input is the flow's own.
 */
function targetInput(
  target: TriggerTarget,
  input: unknown,
): { kind: 'ok'; input?: unknown } | { kind: 'err'; message: string } {
  if (target.kind === 'improve') {
    const parsed = parseImproveScheduleInput(input);
    return parsed.kind === 'ok' ? { kind: 'ok', input: parsed.input } : parsed;
  }
  if (target.kind === 'flow') return { kind: 'ok', ...(input !== undefined && { input }) };
  const message =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>).userMessage
      : undefined;
  if (typeof message === 'string' && message.length > 0) return { kind: 'ok', input };
  return {
    kind: 'err',
    message:
      'An agent schedule needs `config.input.userMessage`: the message each run sends the agent (`{ userMessage, parameters? }`)',
  };
}

/** `catchUp`, `overlap` and `startingDeadlineSeconds`, each optional. */
function parsePolicy(body: Record<string, unknown>):
  | {
      kind: 'ok';
      value: {
        catchUp?: ScheduleCatchUp;
        overlap?: ScheduleOverlap;
        startingDeadlineSeconds?: number;
      };
    }
  | { kind: 'err'; message: string } {
  const { catchUp, overlap, startingDeadlineSeconds } = body;
  if (catchUp !== undefined && catchUp !== 'latest' && catchUp !== 'skip') {
    return { kind: 'err', message: '`catchUp` must be `latest` or `skip`' };
  }
  if (overlap !== undefined && overlap !== 'skip' && overlap !== 'allow') {
    return { kind: 'err', message: '`overlap` must be `skip` or `allow`' };
  }
  if (
    startingDeadlineSeconds !== undefined &&
    (typeof startingDeadlineSeconds !== 'number' ||
      !Number.isInteger(startingDeadlineSeconds) ||
      startingDeadlineSeconds < 1 ||
      startingDeadlineSeconds > 86_400)
  ) {
    return {
      kind: 'err',
      message: `\`startingDeadlineSeconds\` must be a whole number of seconds from 1 to 86400 (default ${SCHEDULE_DEFAULTS.startingDeadlineSeconds})`,
    };
  }
  return {
    kind: 'ok',
    value: {
      ...(catchUp !== undefined && { catchUp }),
      ...(overlap !== undefined && { overlap }),
      ...(startingDeadlineSeconds !== undefined && { startingDeadlineSeconds }),
    },
  };
}

type ParseOk<T> = { readonly kind: 'ok'; readonly value: T };
type ParseErr = { readonly kind: 'err'; readonly response: Response };

async function parseJsonObject(
  c: Context<AppEnv>,
  requestId: string,
): Promise<ParseOk<Record<string, unknown>> | ParseErr> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.status(statusFor('bad-input') as never);
    return {
      kind: 'err',
      response: c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      ),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.status(statusFor('bad-input') as never);
    return {
      kind: 'err',
      response: c.json(
        toWireError(
          { code: 'bad-input', message: 'Request body must be a JSON object' },
          requestId,
        ),
      ),
    };
  }
  return { kind: 'ok', value: body as Record<string, unknown> };
}

function requireString(
  obj: unknown,
  path: string,
):
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'err'; readonly message: string } {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') {
      return { kind: 'err', message: `\`${path}\` is required` };
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== 'string' || cur.length === 0) {
    return { kind: 'err', message: `\`${path}\` is required` };
  }
  return { kind: 'ok', value: cur };
}

function bad(c: Context<AppEnv>, requestId: string, message: string): Response {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function unsupported(c: Context<AppEnv>, requestId: string, what: string): Response {
  c.status(statusFor('trigger-operation-unsupported') as never);
  return c.json(
    toWireError(
      {
        code: 'trigger-operation-unsupported',
        message: `This deployment's schedules don't support ${what} yet.`,
      },
      requestId,
    ),
  );
}

function notFound(c: Context<AppEnv>, requestId: string, triggerId: TriggerId): Response {
  c.status(statusFor('trigger-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'trigger-not-found',
        message: `No schedule with id "${triggerId as unknown as string}"`,
        triggerId: triggerId as unknown as string,
      },
      requestId,
    ),
  );
}

function lifecycleError(
  c: Context<AppEnv>,
  requestId: string,
  error: { readonly code: string; readonly message: string },
  triggerId: TriggerId,
): Response {
  c.status(statusFor(error.code) as never);
  return c.json(
    toWireError(
      { code: error.code, message: error.message, triggerId: triggerId as unknown as string },
      requestId,
    ),
  );
}
