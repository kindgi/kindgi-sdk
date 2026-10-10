// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { Cursor, TenantId, Timestamp } from '@kindgi/types';

import { callerRef } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type {
  JudgingError,
  JudgingQueueBinding,
  JudgingQueueItem,
  JudgingQueueState,
  JudgingRule,
  JudgingRuleSpec,
  JudgingRunStatus,
} from '../judging-queue-binding.js';
import {
  type JudgeClassAsserter,
  type JudgmentRegistryBinding,
  whyNotAssertable,
} from '../judgment-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import { callerReviewerRole } from '../reviewer-role.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * A project's judging rules and the queue they fill (mounted at
 * `/v1/projects`):
 *
 *   - `GET|POST  /:projectId/judging-rules`
 *   - `GET       /:projectId/judging-rules/preview`
 *   - `GET|PATCH /:projectId/judging-rules/:ruleId`, `POST …/unregister`
 *   - `GET       /:projectId/judging-rules/:ruleId/versions`, `…/results`
 *   - `GET       /:projectId/judging-queue`
 *   - `POST      /:projectId/judging-queue/:runId/dismiss`, `…/reopen`
 *
 * Reading needs `read` on the project; changing a rule, and dismissing or
 * reopening an item, need `write` there, the check that recording a
 * judgment on the run makes. The queue lists only the project's own runs,
 * and an item carries none of a run's content.
 */
export function judgingRouter(
  binding: JudgingQueueBinding,
  deps: {
    readonly authorizer?: Authorizer;
    readonly judgments?: JudgmentRegistryBinding;
    readonly reviewers?: ReviewerBinding;
    readonly projects?: ProjectBinding;
  } = {},
): Hono<AppEnv> {
  const { authorizer, judgments, reviewers, projects } = deps;
  const r = new Hono<AppEnv>();

  for (const path of [
    '/:projectId/judging-rules',
    '/:projectId/judging-rules/*',
    '/:projectId/judging-queue',
    '/:projectId/judging-queue/*',
  ]) {
    r.use(path, async (c, next) => {
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
    });
  }

  const inProject = (c: Context<AppEnv>) => ({
    tenantId: c.get('tenantId') as TenantId,
    projectId: c.req.param('projectId') as string,
  });
  const by = (c: Context<AppEnv>) => {
    const who = callerRef(c);
    return who === undefined ? {} : { by: who };
  };

  // ---------- rules ----------
  r.get('/:projectId/judging-rules', async (c) => {
    const cursor = c.req.query('cursor');
    const page = await binding.listRules({
      ...inProject(c),
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
    });
    return c.json(rulePage(page));
  });

  r.post('/:projectId/judging-rules', async (c) => {
    const parsed = parseSpec(await c.req.json().catch(() => undefined), 'create');
    if (typeof parsed === 'string') return fail(c, 'bad-input', parsed);
    const known = await classKnown(c, parsed.judgeClassId);
    if (known !== undefined) return known;
    const created = await binding.createRule({
      ...inProject(c),
      spec: parsed as JudgingRuleSpec,
      ...by(c),
    });
    if (created.kind === 'err') return judgingFail(c, created.error);
    c.status(201);
    return c.json(serializeRule(created.value));
  });

  r.get('/:projectId/judging-rules/preview', async (c) => {
    const spec = parseSpec(specFromQuery(c), 'preview');
    if (typeof spec === 'string') return fail(c, 'bad-input', spec);
    const lastRaw = c.req.query('last');
    const last = lastRaw === undefined ? 100 : Number(lastRaw);
    if (!Number.isInteger(last) || last < 1 || last > MAX_PREVIEW) {
      return fail(c, 'bad-input', `\`last\` must be a whole number from 1 to ${MAX_PREVIEW}`);
    }
    return c.json(
      await binding.preview({
        ...inProject(c),
        spec: { name: 'preview', ...spec } as JudgingRuleSpec,
        last,
      }),
    );
  });

  r.get('/:projectId/judging-rules/:ruleId', async (c) => {
    const rule = await binding.getRule({ ...inProject(c), ruleId: c.req.param('ruleId') });
    if (rule === null) return ruleNotFound(c);
    return c.json(serializeRule(rule));
  });

  r.patch('/:projectId/judging-rules/:ruleId', async (c) => {
    const parsed = parseSpec(await c.req.json().catch(() => undefined), 'patch');
    if (typeof parsed === 'string') return fail(c, 'bad-input', parsed);
    const known = await classKnown(c, parsed.judgeClassId);
    if (known !== undefined) return known;
    const updated = await binding.updateRule({
      ...inProject(c),
      ruleId: c.req.param('ruleId'),
      patch: parsed,
      ...by(c),
    });
    if (updated.kind === 'err') return judgingFail(c, updated.error);
    return c.json(serializeRule(updated.value));
  });

  r.post('/:projectId/judging-rules/:ruleId/unregister', async (c) => {
    const ruleId = c.req.param('ruleId');
    const done = await binding.unregisterRule({ ...inProject(c), ruleId, ...by(c) });
    if (!done.unregistered && (await binding.getRule({ ...inProject(c), ruleId })) === null) {
      const retired = await binding.getRule({ ...inProject(c), ruleId, includeUnregistered: true });
      if (retired === null) return ruleNotFound(c);
    }
    return c.json({ ruleId, unregistered: done.unregistered });
  });

  r.get('/:projectId/judging-rules/:ruleId/versions', async (c) => {
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

  r.get('/:projectId/judging-rules/:ruleId/results', async (c) => {
    const since = c.req.query('since');
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      return fail(c, 'bad-input', '`since` must be a date-time');
    }
    const out = await binding.results({
      ...inProject(c),
      ruleId: c.req.param('ruleId'),
      ...(since !== undefined && { since: new Date(since).toISOString() as Timestamp }),
    });
    if (out.kind === 'err') return judgingFail(c, out.error);
    return c.json(out.value);
  });

  // ---------- the queue ----------
  r.get('/:projectId/judging-queue', async (c) => {
    const q = (name: string) => {
      const v = c.req.query(name);
      return v === undefined || v === '' ? undefined : v;
    };
    const state = q('state');
    if (state !== undefined && !STATES.includes(state as JudgingQueueState)) {
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
    const wantedFrom = forMe === 'true' ? await classesTheCallerMayAssert(c) : undefined;
    const limit = q('limit') === '0' ? 0 : clampLimit(c.req.query('limit'));
    const iso = (v: string | undefined) =>
      v === undefined ? undefined : (new Date(v).toISOString() as Timestamp);
    const addedAfter = iso(q('addedAfter'));
    const closedAfter = iso(q('closedAfter'));
    const page = await binding.listQueue({
      ...inProject(c),
      limit,
      ...(state !== undefined && { state: state as JudgingQueueState }),
      ...(q('agentId') !== undefined && { agentId: q('agentId') as string }),
      ...(q('ruleId') !== undefined && { ruleId: q('ruleId') as string }),
      ...(q('judgeClassId') !== undefined && { judgeClassId: q('judgeClassId') as string }),
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
    r.post(`/:projectId/judging-queue/:runId/${action}`, async (c) => {
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
      if (out.kind === 'err') return judgingFail(c, out.error);
      return c.json(serializeItem(out.value, true));
    });
  }

  /** Whether the caller may change the queue: `write` on the project, as judging the run needs. */
  async function mayWrite(c: Context<AppEnv>): Promise<boolean> {
    if (authorizer === undefined) return true;
    return authorizer.can(c, 'write', ref('project', c.req.param('projectId') as string));
  }

  /** The live judge classes the caller may assert (`forMe`), by the check recording a judgment makes. */
  async function classesTheCallerMayAssert(c: Context<AppEnv>): Promise<string[]> {
    if (judgments === undefined) return [];
    const actor = c.get('principal')?.actor;
    if (actor === undefined) return [];
    const reviewerRole = await callerReviewerRole(c, reviewers);
    const asserter: JudgeClassAsserter = {
      kind: actor.kind === 'user' ? 'user' : 'service',
      id: actor.id,
      ...(reviewerRole !== undefined && { reviewerRole }),
    };
    const out: string[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await judgments.listClasses({
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

  /** `undefined` when the class is unset or live; else the answer to send. */
  async function classKnown(c: Context<AppEnv>, judgeClassId: string | undefined) {
    if (judgeClassId === undefined || judgments === undefined) return undefined;
    const cls = await judgments.getClass({ tenantId: c.get('tenantId') as TenantId, judgeClassId });
    if (cls !== null) return undefined;
    return judgingFail(c, {
      code: 'judge-class-not-found',
      message: `No live judge class "${judgeClassId}".`,
    });
  }

  return r;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES: readonly JudgingQueueState[] = ['open', 'judged', 'dismissed', 'erased'];
const RUN_STATUSES: readonly JudgingRunStatus[] = ['completed', 'failed', 'cancelled'];
const MAX_PREVIEW = 500;
const MAX_LIST = 50;
const MAX_TEXT = 200;
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
function parseSpec(
  raw: unknown,
  mode: 'create' | 'patch' | 'preview',
): Partial<JudgingRuleSpec> | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'The body must be a JSON object';
  }
  const b = raw as Record<string, unknown>;
  const allowed = ['name', 'when', 'sample', 'maxOpen', 'judgeClassId', 'enabled'];
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return `Unknown field(s): ${extra.join(', ')}`;
  const out: { -readonly [K in keyof JudgingRuleSpec]?: JudgingRuleSpec[K] } = {};

  if (b.name !== undefined || mode === 'create') {
    if (typeof b.name !== 'string' || b.name.trim() === '' || b.name.length > MAX_TEXT) {
      return `\`name\` must be a non-empty string of at most ${MAX_TEXT} characters`;
    }
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
      if (name === 'status' && v.some((x) => !RUN_STATUSES.includes(x as JudgingRunStatus))) {
        return `\`when.status\` values are: ${RUN_STATUSES.join(', ')}`;
      }
      parsed[name] = [...new Set(v as string[])];
    }
    if (w.includeDryRuns !== undefined) {
      if (typeof w.includeDryRuns !== 'boolean') return '`when.includeDryRuns` must be a boolean';
      parsed.includeDryRuns = w.includeDryRuns;
    }
    out.when = parsed;
  }
  if (b.sample !== undefined) {
    if (typeof b.sample !== 'number' || !(b.sample > 0 && b.sample <= 1)) {
      return '`sample` must be a number greater than 0 and at most 1';
    }
    out.sample = b.sample;
  }
  if (b.maxOpen !== undefined && mode !== 'preview') {
    if (
      !Number.isInteger(b.maxOpen) ||
      (b.maxOpen as number) < 1 ||
      (b.maxOpen as number) > MAX_OPEN
    ) {
      return `\`maxOpen\` must be a whole number from 1 to ${MAX_OPEN}`;
    }
    out.maxOpen = b.maxOpen as number;
  }
  if (b.judgeClassId !== undefined && mode !== 'preview') {
    if (typeof b.judgeClassId !== 'string' || b.judgeClassId === '') {
      return '`judgeClassId` must be a non-empty string';
    }
    out.judgeClassId = b.judgeClassId;
  }
  if (b.enabled !== undefined && mode !== 'preview') {
    if (typeof b.enabled !== 'boolean') return '`enabled` must be a boolean';
    out.enabled = b.enabled;
  }
  return out;
}

function serializeRule(rule: JudgingRule): Record<string, unknown> {
  return {
    ruleId: rule.ruleId,
    projectId: rule.projectId,
    version: rule.version,
    name: rule.name,
    when: rule.when,
    sample: rule.sample,
    ...(rule.maxOpen !== undefined && { maxOpen: rule.maxOpen }),
    ...(rule.judgeClassId !== undefined && { judgeClassId: rule.judgeClassId }),
    enabled: rule.enabled,
    ...(rule.createdBy !== undefined && { createdBy: rule.createdBy }),
    createdAt: rule.createdAt,
    ...(rule.unregisteredAt !== undefined && { unregisteredAt: rule.unregisteredAt }),
  };
}

function rulePage(page: {
  readonly data: readonly JudgingRule[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}): Record<string, unknown> {
  return {
    data: page.data.map(serializeRule),
    hasMore: page.hasMore,
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
  };
}

/** An item, with what the caller may do with it (`write`: the project check judging needs). */
function serializeItem(item: JudgingQueueItem, write: boolean): Record<string, unknown> {
  return {
    runId: item.runId,
    projectId: item.projectId,
    ...(item.agentId !== undefined && { agentId: item.agentId }),
    ...(item.agentVersion !== undefined && { agentVersion: item.agentVersion }),
    flowId: item.flowId,
    runStatus: item.runStatus,
    completedAt: item.completedAt,
    ruleIds: item.ruleIds,
    wantedClassIds: item.wantedClassIds,
    anyJudgment: item.anyJudgment,
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

function judgingFail(c: Context<AppEnv>, error: JudgingError) {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError({ code: error.code, message: error.message }, c.get('requestId')));
}

function ruleNotFound(c: Context<AppEnv>) {
  return judgingFail(c, {
    code: 'judging-rule-not-found',
    message: `No judging rule "${c.req.param('ruleId')}" in this project.`,
  });
}
