// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import { type Cursor, type TenantId, type Timestamp, hasHiddenCharacters } from '@kindgi/types';

import { callerRef } from '../caller.js';
import {
  type CorrectionRegistryBinding,
  type CorrectorGroupAsserter,
  whyNotAssertable,
} from '../correction-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type {
  ExpertQueueBinding,
  ExpertQueueError,
  ExpertQueueItem,
  ExpertQueueRunStatus,
  ExpertQueueState,
  QueueRule,
  QueueRulePatch,
  QueueRuleSpec,
} from '../expert-queue-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import { callerReviewerRole } from '../reviewer-role.js';
import type { AppEnv } from '../types.js';
import { hiddenCharactersMessage } from './hidden-characters.js';
import { clampLimit } from './pagination.js';

/**
 * A project's queue rules and the queue they fill (mounted at
 * `/v1/projects`):
 *
 *   - `GET|POST  /:projectId/queue-rules`
 *   - `GET       /:projectId/queue-rules/preview`
 *   - `GET|PATCH /:projectId/queue-rules/:ruleId`, `POST …/unregister`
 *   - `GET       /:projectId/queue-rules/:ruleId/versions`, `…/results`
 *   - `POST      /:projectId/queue-rules/:ruleId/queue-recent`
 *   - `GET       /:projectId/expert-queue`
 *   - `POST      /:projectId/expert-queue/:runId/dismiss`, `…/reopen`
 *
 * Reading needs `read` on the project; changing a rule, and dismissing or
 * reopening an item, need `write` there, the check that recording a
 * correction on the run makes. The queue lists only the project's own runs,
 * and an item carries none of a run's content.
 */
export function expertQueueRouter(
  binding: ExpertQueueBinding,
  deps: {
    readonly authorizer?: Authorizer;
    readonly corrections?: CorrectionRegistryBinding;
    readonly reviewers?: ReviewerBinding;
    readonly projects?: ProjectBinding;
  } = {},
): Hono<AppEnv> {
  const { authorizer, corrections, reviewers, projects } = deps;
  const r = new Hono<AppEnv>();

  const projectGate: MiddlewareHandler<AppEnv> = async (c, next) => {
    const projectId = c.req.param('projectId') as string;
    if (!UUID.test(projectId)) {
      return fail(c, 'bad-input', `"${projectId}" isn't a project id`);
    }
    if (authorizer !== undefined) {
      const action = c.req.method === 'GET' ? 'read' : 'write';
      let allowed = false;
      const answer = await authorizer.authorize(action, () => ref('project', projectId))(
        c,
        async () => {
          allowed = true;
        },
      );
      if (!allowed) return answer as Response;
    }
    if (
      projects !== undefined &&
      (await projects.get(c.get('tenantId') as TenantId, projectId as never)) === undefined
    ) {
      return fail(c, 'project-not-found', `No project with id "${projectId}"`, { projectId });
    }
    await next();
    return undefined;
  };
  // A trailing '/*' matches the bare path too ('/:projectId/queue-rules'
  // itself): each gate is registered once, so a request is checked once.
  r.use('/:projectId/queue-rules/*', projectGate);
  r.use('/:projectId/expert-queue/*', projectGate);

  const inProject = (c: Context<AppEnv>) => ({
    tenantId: c.get('tenantId') as TenantId,
    projectId: c.req.param('projectId') as string,
  });
  const by = (c: Context<AppEnv>) => {
    const who = callerRef(c);
    return who === undefined ? {} : { by: who };
  };

  // ---------- rules ----------
  r.get('/:projectId/queue-rules', async (c) => {
    const cursor = c.req.query('cursor');
    const page = await binding.listRules({
      ...inProject(c),
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
    });
    return c.json(rulePage(page));
  });

  r.post('/:projectId/queue-rules', async (c) => {
    const parsed = parseSpec(await c.req.json().catch(() => undefined), 'create');
    if (typeof parsed === 'string') return fail(c, 'bad-input', parsed);
    const known = await groupKnown(c, parsed.correctorGroupId ?? undefined);
    if (known !== undefined) return known;
    const created = await binding.createRule({
      ...inProject(c),
      spec: parsed as QueueRuleSpec,
      ...by(c),
    });
    if (created.kind === 'err') return expertQueueFail(c, created.error);
    c.status(201);
    return c.json(serializeRule(created.value));
  });

  r.get('/:projectId/queue-rules/preview', async (c) => {
    const spec = parseSpec(specFromQuery(c), 'preview');
    if (typeof spec === 'string') return fail(c, 'bad-input', spec);
    const lastRaw = c.req.query('last');
    const last = lastRaw === undefined ? 100 : Number(lastRaw);
    if (!Number.isInteger(last) || last < 1 || last > MAX_PREVIEW) {
      return fail(c, 'bad-input', `\`last\` must be a whole number from 1 to ${MAX_PREVIEW}`);
    }
    const ruleId = c.req.query('ruleId');
    if (ruleId !== undefined && (ruleId === '' || ruleId.length > MAX_TEXT)) {
      return fail(c, 'bad-input', '`ruleId` must be a rule id');
    }
    return c.json(
      await binding.preview({
        ...inProject(c),
        spec: { name: 'preview', ...spec } as QueueRuleSpec,
        last,
        ...(ruleId !== undefined && { ruleId }),
      }),
    );
  });

  r.get('/:projectId/queue-rules/:ruleId', async (c) => {
    const rule = await binding.getRule({ ...inProject(c), ruleId: c.req.param('ruleId') });
    if (rule === null) return ruleNotFound(c);
    return c.json(serializeRule(rule));
  });

  r.patch('/:projectId/queue-rules/:ruleId', async (c) => {
    const parsed = parseSpec(await c.req.json().catch(() => undefined), 'patch');
    if (typeof parsed === 'string') return fail(c, 'bad-input', parsed);
    const known = await groupKnown(c, parsed.correctorGroupId ?? undefined);
    if (known !== undefined) return known;
    const updated = await binding.updateRule({
      ...inProject(c),
      ruleId: c.req.param('ruleId'),
      patch: parsed,
      ...by(c),
    });
    if (updated.kind === 'err') return expertQueueFail(c, updated.error);
    return c.json(serializeRule(updated.value));
  });

  r.post('/:projectId/queue-rules/:ruleId/unregister', async (c) => {
    const ruleId = c.req.param('ruleId');
    const done = await binding.unregisterRule({ ...inProject(c), ruleId, ...by(c) });
    if (!done.unregistered && (await binding.getRule({ ...inProject(c), ruleId })) === null) {
      const retired = await binding.getRule({ ...inProject(c), ruleId, includeUnregistered: true });
      if (retired === null) return ruleNotFound(c);
    }
    return c.json({ ruleId, unregistered: done.unregistered });
  });

  r.get('/:projectId/queue-rules/:ruleId/versions', async (c) => {
    const cursor = c.req.query('cursor');
    const page = await binding.ruleVersions({
      ...inProject(c),
      ruleId: c.req.param('ruleId'),
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
    });
    if (page.data.length === 0 && cursor === undefined) return ruleNotFound(c);
    return c.json(rulePage(page));
  });

  r.get('/:projectId/queue-rules/:ruleId/results', async (c) => {
    const since = c.req.query('since');
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      return fail(c, 'bad-input', '`since` must be a date-time');
    }
    const out = await binding.results({
      ...inProject(c),
      ruleId: c.req.param('ruleId'),
      ...(since !== undefined && { since: new Date(since).toISOString() as Timestamp }),
    });
    if (out.kind === 'err') return expertQueueFail(c, out.error);
    return c.json(out.value);
  });

  r.post('/:projectId/queue-rules/:ruleId/queue-recent', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      last?: unknown;
      since?: unknown;
    } | null;
    if (body !== null && typeof body !== 'object') {
      return fail(c, 'bad-input', 'The body must be a JSON object');
    }
    let last: number | undefined;
    if (body?.last !== undefined) {
      const raw = body.last;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 1000) {
        return fail(c, 'bad-input', '`last` must be an integer from 1 to 1000');
      }
      last = raw;
    }
    let since: Timestamp | undefined;
    if (body?.since !== undefined) {
      const raw = body.since;
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
        return fail(c, 'bad-input', '`since` must be a date-time');
      }
      since = new Date(raw).toISOString() as Timestamp;
    }
    if (last === undefined && since === undefined) {
      return fail(c, 'bad-input', 'Give `last`, `since`, or both.');
    }
    const out = await binding.queueRecent({
      ...inProject(c),
      ruleId: c.req.param('ruleId'),
      ...(last !== undefined && { last }),
      ...(since !== undefined && { since }),
      ...by(c),
    });
    if (out.kind === 'err') return expertQueueFail(c, out.error);
    return c.json(out.value);
  });

  // ---------- the queue ----------
  r.get('/:projectId/expert-queue', async (c) => {
    const q = (name: string) => {
      const v = c.req.query(name);
      return v === undefined || v === '' ? undefined : v;
    };
    const state = q('state');
    if (state !== undefined && !STATES.includes(state as ExpertQueueState)) {
      return fail(c, 'bad-input', `\`state\` must be one of: ${STATES.join(', ')}`);
    }
    for (const name of ['addedAfter', 'closedAfter']) {
      const v = q(name);
      if (v !== undefined && Number.isNaN(Date.parse(v))) {
        return fail(c, 'bad-input', `\`${name}\` must be a date-time`);
      }
    }
    const forMe = q('forMe');
    if (forMe !== undefined && forMe !== 'true' && forMe !== 'false') {
      return fail(c, 'bad-input', '`forMe` must be true or false');
    }
    const wantedFrom = forMe === 'true' ? await groupsTheCallerMayAssert(c) : undefined;
    const limit = q('limit') === '0' ? 0 : clampLimit(c.req.query('limit'));
    const iso = (v: string | undefined) =>
      v === undefined ? undefined : (new Date(v).toISOString() as Timestamp);
    const addedAfter = iso(q('addedAfter'));
    const closedAfter = iso(q('closedAfter'));
    const page = await binding.listQueue({
      ...inProject(c),
      limit,
      ...(state !== undefined && { state: state as ExpertQueueState }),
      ...(q('agentId') !== undefined && { agentId: q('agentId') as string }),
      ...(q('ruleId') !== undefined && { ruleId: q('ruleId') as string }),
      ...(q('correctorGroupId') !== undefined && {
        correctorGroupId: q('correctorGroupId') as string,
      }),
      ...(wantedFrom !== undefined && { wantedFrom }),
      ...(addedAfter !== undefined && { addedAfter }),
      ...(closedAfter !== undefined && { closedAfter }),
      ...(q('cursor') !== undefined && { cursor: q('cursor') as Cursor }),
    });
    const write = await mayWrite(c);
    return c.json({
      data: page.data.map((item) => serializeItem(item, write)),
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
      total: page.total,
    });
  });

  for (const action of ['dismiss', 'reopen'] as const) {
    r.post(`/:projectId/expert-queue/:runId/${action}`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown } | null;
      if (body !== null && typeof body !== 'object')
        return fail(c, 'bad-input', 'The body must be a JSON object');
      const reason = body?.reason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
        return fail(c, 'bad-input', '`reason` must be a string of at most 500 characters');
      }
      const input = { ...inProject(c), runId: c.req.param('runId'), ...by(c) };
      const out =
        action === 'dismiss'
          ? await binding.dismiss({ ...input, ...(typeof reason === 'string' && { reason }) })
          : await binding.reopen(input);
      if (out.kind === 'err') return expertQueueFail(c, out.error);
      return c.json(serializeItem(out.value, true));
    });
  }

  /** Whether the caller may change the queue: `write` on the project, as correcting the run needs. */
  async function mayWrite(c: Context<AppEnv>): Promise<boolean> {
    if (authorizer === undefined) return true;
    return authorizer.can(c, 'write', ref('project', c.req.param('projectId') as string));
  }

  /** The live corrector groups the caller may assert (`forMe`), by the check recording a correction makes. */
  async function groupsTheCallerMayAssert(c: Context<AppEnv>): Promise<string[]> {
    if (corrections === undefined) return [];
    const actor = c.get('principal')?.actor;
    if (actor === undefined) return [];
    const reviewerRole = await callerReviewerRole(c, reviewers);
    const asserter: CorrectorGroupAsserter = {
      kind: actor.kind === 'user' ? 'user' : 'service',
      id: actor.id,
      ...(reviewerRole !== undefined && { reviewerRole }),
    };
    const out: string[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await corrections.listGroups({
        tenantId: c.get('tenantId') as TenantId,
        limit: 100,
        ...(cursor !== undefined && { cursor }),
      });
      for (const cls of page.data) {
        if (
          cls.assertableBy === undefined ||
          whyNotAssertable(cls.assertableBy, asserter) === undefined
        ) {
          out.push(cls.id);
        }
      }
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return out;
  }

  /** `undefined` when the group is unset or live; else the answer to send. */
  async function groupKnown(c: Context<AppEnv>, correctorGroupId: string | undefined) {
    if (correctorGroupId === undefined || corrections === undefined) return undefined;
    const cls = await corrections.getGroup({
      tenantId: c.get('tenantId') as TenantId,
      correctorGroupId,
    });
    if (cls !== null) return undefined;
    return expertQueueFail(c, {
      code: 'corrector-group-not-found',
      message: `No live corrector group "${correctorGroupId}".`,
    });
  }

  return r;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES: readonly ExpertQueueState[] = ['open', 'corrected', 'dismissed', 'erased'];
/**
 * The run endings a rule may match today: a correction needs a completed run
 * (`routes/corrections.ts`, `run-not-finished`), and an item that can't be
 * corrected could only ever be dismissed. `ExpertQueueRunStatus` keeps `failed`
 * and `cancelled`, so allowing them later changes no response type.
 */
const JUDGEABLE: readonly ExpertQueueRunStatus[] = ['completed'];
const MAX_PREVIEW = 500;
const MAX_LIST = 50;
const MAX_TEXT = 200;
/** A `when.versions` entry: an exact agent or flow version, or `pinned`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_OPEN = 10_000;

/** The query's rule fields, as a spec body (`preview`). */
function specFromQuery(c: Context<AppEnv>): Record<string, unknown> {
  const list = (name: string) => {
    const v = c.req.query(name);
    return v === undefined || v === '' ? undefined : v.split(',');
  };
  const when: Record<string, unknown> = {};
  for (const name of ['agentIds', 'flowIds', 'versions', 'status']) {
    const v = list(name);
    if (v !== undefined) when[name] = v;
  }
  const dry = c.req.query('includeDryRuns');
  if (dry !== undefined) when.includeDryRuns = dry === 'true';
  const sample = c.req.query('sample');
  return { when, ...(sample !== undefined && { sample: Number(sample) }) };
}

/** A rule body, or why not. `patch`: every field optional; `preview`: no name. */
function parseSpec(raw: unknown, mode: 'create' | 'patch' | 'preview'): QueueRulePatch | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'The body must be a JSON object';
  }
  const b = raw as Record<string, unknown>;
  const allowed = ['name', 'when', 'sample', 'maxOpen', 'correctorGroupId', 'enabled'];
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return `Unknown field(s): ${extra.join(', ')}`;
  const out: { -readonly [K in keyof QueueRulePatch]?: QueueRulePatch[K] } = {};

  if (b.name !== undefined || mode === 'create') {
    if (typeof b.name !== 'string' || b.name.trim() === '' || b.name.length > MAX_TEXT) {
      return `\`name\` must be a non-empty string of at most ${MAX_TEXT} characters`;
    }
    if (mode === 'create' && hasHiddenCharacters(b.name)) return hiddenCharactersMessage('name');
    out.name = b.name.trim();
  }
  if (b.when !== undefined || mode !== 'patch') {
    const when = b.when ?? {};
    if (typeof when !== 'object' || when === null || Array.isArray(when)) {
      return '`when` must be an object';
    }
    const w = when as Record<string, unknown>;
    const wAllowed = ['agentIds', 'flowIds', 'versions', 'status', 'includeDryRuns'];
    const wExtra = Object.keys(w).filter((k) => !wAllowed.includes(k));
    if (wExtra.length > 0) return `Unknown \`when\` field(s): ${wExtra.join(', ')}`;
    const parsed: Record<string, unknown> = {};
    for (const name of ['agentIds', 'flowIds', 'versions', 'status'] as const) {
      const v = w[name];
      if (v === undefined) continue;
      if (
        !Array.isArray(v) ||
        v.length === 0 ||
        v.length > MAX_LIST ||
        v.some((x) => typeof x !== 'string' || x === '' || x.length > MAX_TEXT)
      ) {
        return `\`when.${name}\` must be a list of 1 to ${MAX_LIST} non-empty strings`;
      }
      if (name === 'status' && v.some((x) => !JUDGEABLE.includes(x as ExpertQueueRunStatus))) {
        return 'Only a completed run can be corrected, so `when.status` takes `completed` only';
      }
      if (name === 'versions' && v.some((x) => x !== 'pinned' && !EXACT_VERSION.test(x))) {
        return '`when.versions` takes exact versions, such as `1.2.0`, or `pinned`';
      }
      parsed[name] = [...new Set(v as string[])];
    }
    if (w.includeDryRuns !== undefined) {
      if (typeof w.includeDryRuns !== 'boolean') return '`when.includeDryRuns` must be a boolean';
      parsed.includeDryRuns = w.includeDryRuns;
    }
    // An agent's turn runs the turn flow, so both together would match nothing.
    if (parsed.agentIds !== undefined && parsed.flowIds !== undefined) {
      return '`when` names agents (`agentIds`) or flows (`flowIds`), not both';
    }
    out.when = parsed;
  }
  if (b.sample !== undefined) {
    if (typeof b.sample !== 'number' || !(b.sample > 0 && b.sample <= 1)) {
      return '`sample` must be a number greater than 0 and at most 1';
    }
    out.sample = b.sample;
  }
  // A change may remove the cap or the group: `null`.
  const removable = mode === 'patch' ? ', or `null` to remove it' : '';
  if (b.maxOpen !== undefined && mode !== 'preview') {
    if (b.maxOpen === null && mode === 'patch') out.maxOpen = null;
    else if (
      !Number.isInteger(b.maxOpen) ||
      (b.maxOpen as number) < 1 ||
      (b.maxOpen as number) > MAX_OPEN
    ) {
      return `\`maxOpen\` must be a whole number from 1 to ${MAX_OPEN}${removable}`;
    } else out.maxOpen = b.maxOpen as number;
  }
  if (b.correctorGroupId !== undefined && mode !== 'preview') {
    if (b.correctorGroupId === null && mode === 'patch') out.correctorGroupId = null;
    else if (typeof b.correctorGroupId !== 'string' || b.correctorGroupId === '') {
      return `\`correctorGroupId\` must be a non-empty string${removable}`;
    } else out.correctorGroupId = b.correctorGroupId;
  }
  if (b.enabled !== undefined && mode !== 'preview') {
    if (typeof b.enabled !== 'boolean') return '`enabled` must be a boolean';
    out.enabled = b.enabled;
  }
  return out;
}

function serializeRule(rule: QueueRule): Record<string, unknown> {
  return {
    ruleId: rule.ruleId,
    projectId: rule.projectId,
    version: rule.version,
    name: rule.name,
    when: rule.when,
    sample: rule.sample,
    ...(rule.maxOpen !== undefined && { maxOpen: rule.maxOpen }),
    ...(rule.correctorGroupId !== undefined && { correctorGroupId: rule.correctorGroupId }),
    enabled: rule.enabled,
    ...(rule.createdBy !== undefined && { createdBy: rule.createdBy }),
    createdAt: rule.createdAt,
    ...(rule.unregisteredAt !== undefined && { unregisteredAt: rule.unregisteredAt }),
  };
}

function rulePage(page: {
  readonly data: readonly QueueRule[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}): Record<string, unknown> {
  return {
    data: page.data.map(serializeRule),
    hasMore: page.hasMore,
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
  };
}

/** An item, with what the caller may do with it (`write`: the project check correcting needs). */
function serializeItem(item: ExpertQueueItem, write: boolean): Record<string, unknown> {
  return {
    runId: item.runId,
    projectId: item.projectId,
    ...(item.agentId !== undefined && { agentId: item.agentId }),
    ...(item.agentVersion !== undefined && { agentVersion: item.agentVersion }),
    flowId: item.flowId,
    runStatus: item.runStatus,
    completedAt: item.completedAt,
    rules: item.rules.map((x) => ({ ruleId: x.ruleId, version: x.version })),
    wantedGroupIds: item.wantedGroupIds,
    anyCorrection: item.anyCorrection,
    progress: item.progress,
    addedAt: item.addedAt,
    state: item.state,
    ...(item.closedAt !== undefined && { closedAt: item.closedAt }),
    ...(item.closedBy !== undefined && { closedBy: item.closedBy }),
    ...(item.reason !== undefined && { reason: item.reason }),
    can: { dismiss: write && item.state === 'open', reopen: write && item.state === 'dismissed' },
  };
}

function fail(
  c: Context<AppEnv>,
  code: 'bad-input' | 'project-not-found',
  message: string,
  extra: Record<string, unknown> = {},
) {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message, ...extra }, c.get('requestId')));
}

function expertQueueFail(c: Context<AppEnv>, error: ExpertQueueError) {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError({ code: error.code, message: error.message }, c.get('requestId')));
}

function ruleNotFound(c: Context<AppEnv>) {
  return expertQueueFail(c, {
    code: 'queue-rule-not-found',
    message: `No queue rule "${c.req.param('ruleId')}" in this project.`,
  });
}
