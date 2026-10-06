// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { ConversationBinding } from '@kindgi/agents';
import { REVIEWER_ROLE_RANK, type ReviewerRole, ref } from '@kindgi/authz';
import type { RunBinding } from '@kindgi/runtime';
import type { Cursor, ProjectId, RunId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import {
  type JudgeClass,
  type JudgeClassAssertableBy,
  type JudgeClassScope,
  type JudgedItem,
  type JudgedRunContext,
  type JudgedSubject,
  type Judgment,
  type JudgmentAssertedBy,
  type JudgmentRegistryBinding,
  type JudgmentWithCopies,
  VERDICTS,
  type Verdict,
  judgeClassApplies,
  whyNotAssertable,
} from '../judgment-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import { callerReviewerRole } from '../reviewer-role.js';
import type { AppEnv } from '../types.js';
import { captureTurnContext } from './judgment-context.js';
import { captureFlowContext } from './judgment-flow-context.js';
import { clampLimit } from './pagination.js';
import { parseListScope } from './scope-params.js';

/**
 * Judgments: yes or no, with an optional reason, about one item of a
 * run's output, recorded under a judge class.
 *
 * - `POST /v1/judgments`: judge an item of a finished run.
 * - `GET /v1/judgments`: live judgments, filtered by run, agent version,
 *   flow, verdict, class, participant or project scope.
 * - `GET /v1/judgments/:id`: one judgment with the stored copies.
 * - `POST /v1/judgments/:id/unregister`: remove a judgment (soft).
 *
 * Authorization: judging needs `write` on the run's project (a run
 * inherits its permissions from its project). Reading and removing go by
 * the judgment's project (`read` / `write`), since a judgment outlives
 * its run.
 */
export function judgmentsRouter(
  binding: JudgmentRegistryBinding,
  runBinding: RunBinding,
  authorizer?: Authorizer,
  conversations?: ConversationBinding,
  flows?: FlowRegistryBinding,
  /** Whose reviewer role a restricted judge class checks (T200). */
  reviewers?: ReviewerBinding,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const fail = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };

    const parsed = parseJudgmentBody(await c.req.json().catch(() => null));
    if (parsed.kind === 'err') return fail('bad-input', parsed.message);
    const body = parsed.body;

    const asserted = assertedByOf(c.get('principal'));
    if (asserted === undefined) {
      return fail('permission-denied', 'Judging needs a user or a service token.');
    }

    const prepared = await prepareJudgment(c, body, runBinding, binding, authorizer, {
      asserted,
      reviewers,
    });
    if (prepared.kind === 'err') return fail(prepared.code, prepared.message);
    const { run, subject, projectId, itemValue, conversationId } = prepared;
    const context = (await isFirstJudgment(binding, tenantId, body.runId))
      ? await captureContext({
          tenantId,
          runId: body.runId,
          subject,
          output: run.output,
          conversationId,
          runBinding,
          conversations,
          flows,
        })
      : undefined;

    const judgment = await binding.record({
      tenantId,
      projectId,
      runId: body.runId,
      run: {
        subject,
        input: run.input,
        output: run.output,
        ...(context !== undefined && { context }),
      },
      item: body.item,
      ...(itemValue !== undefined && { itemValue }),
      verdict: body.verdict,
      ...(body.reason !== undefined && { reason: body.reason }),
      ...(body.judgeClassId !== undefined && { judgeClassId: body.judgeClassId }),
      assertedBy: asserted,
      ...(body.participantId !== undefined && { participantId: body.participantId }),
    });
    c.status(201);
    return c.json(serializeJudgment(judgment));
  });

  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const fail = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };
    const q = (name: string) => {
      const v = c.req.query(name);
      return v !== undefined && v.length > 0 ? v : undefined;
    };

    const scope = parseListScope(c.req.query(), { tenantId });
    if (scope.kind === 'err') return fail('scope-invalid', scope.message);
    const verdict = q('verdict');
    if (verdict !== undefined && !isVerdict(verdict)) {
      return fail('bad-input', `verdict must be one of: ${VERDICTS.join(', ')}.`);
    }
    if (q('agentVersion') !== undefined && q('agentId') === undefined) {
      return fail('bad-input', 'agentVersion needs agentId.');
    }

    const page = await binding.list({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...optional('runId', q('runId')),
      ...optional('agentId', q('agentId')),
      ...optional('agentVersion', q('agentVersion')),
      ...optional('flowId', q('flowId')),
      ...(verdict !== undefined && { verdict: verdict as Verdict }),
      ...optional('judgeClassId', q('judgeClassId')),
      ...optional('participantId', q('participantId')),
      ...(q('cursor') !== undefined && { cursor: q('cursor') as Cursor }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (j) => ref('project', j.projectId));
    return c.json({
      data: visible.map(serializeJudgment),
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:judgmentId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const judgmentId = c.req.param('judgmentId');
    const judgment = await binding.get({ tenantId, judgmentId });
    if (
      judgment === null ||
      (authorizer !== undefined &&
        !(await authorizer.can(c, 'read', ref('project', judgment.projectId))))
    ) {
      c.status(statusFor('judgment-not-found') as never);
      return c.json(
        toWireError(
          { code: 'judgment-not-found', message: `No judgment "${judgmentId}".` },
          requestId,
        ),
      );
    }
    return c.json(serializeJudgmentWithCopies(judgment));
  });

  r.post('/:judgmentId/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const judgmentId = c.req.param('judgmentId');
    const notFound = () => {
      c.status(statusFor('judgment-not-found') as never);
      return c.json(
        toWireError(
          { code: 'judgment-not-found', message: `No live judgment "${judgmentId}".` },
          requestId,
        ),
      );
    };
    const judgment = await binding.get({ tenantId, judgmentId });
    if (judgment === null || judgment.unregisteredAt !== undefined) return notFound();
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'write', ref('project', judgment.projectId)))
    ) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          { code: 'permission-denied', message: `Not allowed to remove judgment "${judgmentId}".` },
          requestId,
        ),
      );
    }
    const outcome = await binding.unregister({ tenantId, judgmentId });
    if (!outcome.unregistered) return notFound();
    return c.json({ judgmentId, unregistered: true });
  });

  return r;
}

/**
 * Judge classes: the deployment's named classes of judges ("expert",
 * "user", …), each with a weight, scoped to the tenant, a project, or an
 * agent in a project.
 *
 * Managing a tenant-scoped class needs `admin` on the tenant; a project-
 * or agent-scoped class needs `admin` on its project. Listing returns the
 * classes the caller may read.
 */
export function judgeClassesRouter(
  binding: JudgmentRegistryBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const scopeRef = (tenantId: TenantId, scope: JudgeClassScope) =>
    scope.kind === 'tenant' ? ref('tenant', tenantId) : ref('project', scope.projectId);

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const fail = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };
    const parsed = parseClassBody(await c.req.json().catch(() => null));
    if (parsed.kind === 'err') return fail('bad-input', parsed.message);
    const { scope, name, weight, description, assertableBy } = parsed.body;
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'admin', scopeRef(tenantId, scope)))
    ) {
      return fail('permission-denied', 'Not allowed to manage judge classes in this scope.');
    }
    const outcome = await binding.createClass({
      tenantId,
      scope,
      name,
      weight,
      ...(description !== undefined && { description }),
      ...(assertableBy !== undefined && { assertableBy }),
    });
    if (outcome.kind === 'name-taken') {
      return fail('judge-class-name-taken', `A judge class named "${name}" already exists here.`);
    }
    c.status(201);
    return c.json(serializeJudgeClass(outcome.judgeClass));
  });

  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const scope = parseClassScopeQuery(c.req.query());
    if (scope.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: scope.message }, requestId));
    }
    const cursor = c.req.query('cursor');
    const page = await binding.listClasses({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (k) => scopeRef(tenantId, k.scope));
    return c.json({
      data: visible.map(serializeJudgeClass),
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  const loadClass = async (
    c: Context<AppEnv>,
    action: 'read' | 'admin',
  ): Promise<JudgeClass | Response> => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const judgeClassId = c.req.param('judgeClassId') ?? '';
    const found = await binding.getClass({
      tenantId,
      judgeClassId,
      includeUnregistered: action === 'read',
    });
    if (found !== null && authorizer !== undefined) {
      const allowed = await authorizer.can(c, action, scopeRef(tenantId, found.scope));
      if (
        !allowed &&
        action === 'admin' &&
        (await authorizer.can(c, 'read', scopeRef(tenantId, found.scope)))
      ) {
        c.status(statusFor('permission-denied') as never);
        return c.json(
          toWireError(
            {
              code: 'permission-denied',
              message: 'Not allowed to manage judge classes in this scope.',
            },
            requestId,
          ),
        );
      }
      if (!allowed) return classNotFound(c, judgeClassId);
    }
    return found ?? classNotFound(c, judgeClassId);
  };

  r.get('/:judgeClassId', async (c) => {
    const found = await loadClass(c, 'read');
    return found instanceof Response ? found : c.json(serializeJudgeClass(found));
  });

  r.patch('/:judgeClassId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const weight = raw?.weight;
    const description = raw?.description;
    const assertableBy =
      raw?.assertableBy === undefined ? undefined : parseAssertableBy(raw.assertableBy);
    if (
      raw === null ||
      typeof raw !== 'object' ||
      (weight === undefined && description === undefined && assertableBy === undefined) ||
      (weight !== undefined && !isWeight(weight)) ||
      (description !== undefined && typeof description !== 'string') ||
      typeof assertableBy === 'string'
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message:
              typeof assertableBy === 'string'
                ? assertableBy
                : 'Send weight (a number ≥ 0), description (a string) and/or assertableBy (who may assert the class, or null for anyone).',
          },
          requestId,
        ),
      );
    }
    const found = await loadClass(c, 'admin');
    if (found instanceof Response) return found;
    if (found.unregisteredAt !== undefined) return classNotFound(c, found.id);
    const updated = await binding.updateClass({
      tenantId,
      judgeClassId: found.id,
      ...(weight !== undefined && { weight: weight as number }),
      ...(description !== undefined && { description: description as string }),
      ...(assertableBy !== undefined && { assertableBy }),
    });
    return updated === null ? classNotFound(c, found.id) : c.json(serializeJudgeClass(updated));
  });

  r.post('/:judgeClassId/unregister', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const found = await loadClass(c, 'admin');
    if (found instanceof Response) return found;
    const outcome = await binding.unregisterClass({ tenantId, judgeClassId: found.id });
    if (!outcome.unregistered) return classNotFound(c, found.id);
    return c.json({ judgeClassId: found.id, unregistered: true });
  });

  return r;
}

type Prepared =
  | {
      readonly kind: 'ok';
      readonly run: { readonly input: unknown; readonly output: unknown };
      readonly subject: JudgedSubject;
      readonly projectId: ProjectId;
      readonly itemValue?: unknown;
      readonly conversationId?: string;
    }
  | { readonly kind: 'err'; readonly code: string; readonly message: string };

/**
 * Everything a judgment needs from its run, or why it can't be recorded:
 * the run exists, the caller may judge it, it has finished with an output,
 * the class (if any) applies to it, and the pointer (if any) resolves.
 */
async function prepareJudgment(
  c: Context<AppEnv>,
  body: JudgmentBody,
  runBinding: RunBinding,
  binding: JudgmentRegistryBinding,
  authorizer: Authorizer | undefined,
  who: { readonly asserted: JudgmentAssertedBy; readonly reviewers: ReviewerBinding | undefined },
): Promise<Prepared> {
  const err = (code: string, message: string): Prepared => ({ kind: 'err', code, message });
  const tenantId = c.get('tenantId') as TenantId;
  const run = await runBinding.getRun(tenantId, body.runId as RunId);
  if (run === null) return err('run-not-found', `No run "${body.runId}".`);
  // A run inherits its permissions from its project (as cancelling one
  // does): judging it needs `write` there.
  if (
    authorizer !== undefined &&
    !(await authorizer.can(c, 'write', ref('project', run.projectId as unknown as string)))
  ) {
    return err('permission-denied', `Not allowed to judge run "${body.runId}".`);
  }
  if (run.status !== 'completed' || run.output === undefined || run.output === null) {
    return err(
      'run-not-finished',
      `Run "${body.runId}" has no output to judge yet (status ${run.status}).`,
    );
  }
  const subject = subjectOf(run);
  const projectId = run.projectId as unknown as ProjectId;
  if (body.judgeClassId !== undefined) {
    const judgeClass = await applicableClass(binding, tenantId, body.judgeClassId, {
      projectId,
      subject,
    });
    if (judgeClass === null) {
      return err(
        'judge-class-not-applicable',
        `Judge class "${body.judgeClassId}" doesn't exist or doesn't apply to this run's project or agent.`,
      );
    }
    if (judgeClass.assertableBy !== undefined) {
      const reviewerRole = await callerReviewerRole(c, who.reviewers);
      const why = whyNotAssertable(judgeClass.assertableBy, {
        ...who.asserted,
        ...(reviewerRole !== undefined && { reviewerRole }),
      });
      if (why !== undefined) {
        return err('judge-class-not-allowed', `You can't judge as "${judgeClass.name}": ${why}.`);
      }
    }
  }
  const copy = { input: run.input, output: run.output };
  const turn =
    run.agent !== undefined ? { conversationId: run.agent.conversationId as string } : {};
  if (body.item.pointer === undefined)
    return { kind: 'ok', run: copy, subject, projectId, ...turn };
  const found = resolvePointer(run.output, body.item.pointer);
  if (!found.found) {
    return err(
      'item-not-found',
      `Nothing at "${body.item.pointer}" in run "${body.runId}"'s output.`,
    );
  }
  return { kind: 'ok', run: copy, subject, projectId, itemValue: found.value, ...turn };
}

/** Whether the run has no live judgment yet (its copy is stored with the first). */
/**
 * What a run's first judgment keeps so the run can be replayed later: a
 * turn's history and retrieved context; a flow run's tool calls with
 * their results.
 */
function captureContext(input: {
  readonly tenantId: TenantId;
  readonly runId: string;
  readonly subject: JudgedSubject;
  readonly output: unknown;
  readonly conversationId: string | undefined;
  readonly runBinding: RunBinding;
  readonly conversations: ConversationBinding | undefined;
  readonly flows: FlowRegistryBinding | undefined;
}): Promise<JudgedRunContext | undefined> {
  const { tenantId, runId, subject, runBinding } = input;
  return subject.kind === 'agent'
    ? captureTurnContext({
        tenantId,
        runId,
        output: input.output,
        conversationId: input.conversationId,
        runBinding,
        conversations: input.conversations,
      })
    : captureFlowContext({
        tenantId,
        run: { runId, flowId: subject.id, flowVersion: subject.version },
        runBinding,
        flows: input.flows,
      });
}

async function isFirstJudgment(
  binding: JudgmentRegistryBinding,
  tenantId: TenantId,
  runId: string,
): Promise<boolean> {
  const page = await binding.list({ tenantId, runId, limit: 1 });
  return page.data.length === 0;
}

/** The live class, when it exists and its scope covers the run; else `null`. */
async function applicableClass(
  binding: JudgmentRegistryBinding,
  tenantId: TenantId,
  judgeClassId: string,
  run: { readonly projectId: ProjectId; readonly subject: JudgedSubject },
): Promise<JudgeClass | null> {
  const judgeClass = await binding.getClass({ tenantId, judgeClassId });
  return judgeClass !== null && judgeClassApplies(judgeClass.scope, run) ? judgeClass : null;
}

// ---------- request parsing ----------

interface JudgmentBody {
  readonly runId: string;
  readonly item: JudgedItem;
  readonly verdict: Verdict;
  readonly reason?: string;
  readonly judgeClassId?: string;
  readonly participantId?: string;
}

type Parsed<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'err'; readonly message: string };

const MAX_REASON = 4000;

function parseJudgmentBody(raw: unknown): Parsed<JudgmentBody> {
  const err = (message: string): Parsed<JudgmentBody> => ({ kind: 'err', message });
  if (raw === null || typeof raw !== 'object') return err('Send a JSON object.');
  const b = raw as Record<string, unknown>;
  if (!nonEmpty(b.runId)) return err('runId is required.');
  if (typeof b.verdict !== 'string' || !isVerdict(b.verdict)) {
    return err(`verdict must be one of: ${VERDICTS.join(', ')}.`);
  }
  const item = parseItem(b.item);
  if (typeof item === 'string') return err(item);
  const optional = optionalFieldError(b);
  if (optional !== undefined) return err(optional);
  return {
    kind: 'ok',
    body: {
      runId: b.runId,
      item,
      verdict: b.verdict,
      ...(typeof b.judgeClassId === 'string' && { judgeClassId: b.judgeClassId }),
      ...(typeof b.reason === 'string' && b.reason.length > 0 && { reason: b.reason }),
      ...(typeof b.participantId === 'string' && { participantId: b.participantId }),
    },
  };
}

/** What's wrong with the optional fields (class, reason, participant), if anything. */
function optionalFieldError(b: Record<string, unknown>): string | undefined {
  if (b.judgeClassId !== undefined && !nonEmpty(b.judgeClassId)) {
    return 'judgeClassId must be a judge class id, or left out for an unclassified judgment.';
  }
  if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > MAX_REASON)) {
    return `reason must be a string of at most ${MAX_REASON} characters.`;
  }
  if (b.participantId !== undefined && !nonEmpty(b.participantId)) {
    return 'participantId must be a non-empty string.';
  }
  return undefined;
}

function parseItem(raw: unknown): JudgedItem | string {
  if (raw === null || typeof raw !== 'object') return 'item is required: { key, pointer?, rank? }.';
  const i = raw as Record<string, unknown>;
  if (!nonEmpty(i.key)) return 'item.key is required.';
  if (i.pointer !== undefined && (typeof i.pointer !== 'string' || !isPointer(i.pointer))) {
    return 'item.pointer must be a JSON Pointer such as "/matches/2" (or "" for the whole output).';
  }
  if (i.rank !== undefined && !(Number.isInteger(i.rank) && (i.rank as number) >= 0)) {
    return 'item.rank must be a whole number ≥ 0.';
  }
  return {
    key: i.key,
    ...(typeof i.pointer === 'string' && { pointer: i.pointer }),
    ...(typeof i.rank === 'number' && { rank: i.rank }),
  };
}

interface ClassBody {
  readonly scope: JudgeClassScope;
  readonly name: string;
  readonly weight: number;
  readonly description?: string;
  readonly assertableBy?: JudgeClassAssertableBy;
}

const ASSERTABLE_BY_USAGE =
  'assertableBy says who may assert the class: { minReviewerRole?: "standard" | "senior" | "admin", principalKinds?: ["user" | "service", …], principalIds?: [id, …] }, with at least one of them.';

/** `assertableBy`: a restriction, `null` (on an update: lift it), or what's wrong. */
function parseAssertableBy(raw: unknown): JudgeClassAssertableBy | null | string {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return ASSERTABLE_BY_USAGE;
  const b = raw as Record<string, unknown>;
  const keys = Object.keys(b);
  const known = ['minReviewerRole', 'principalKinds', 'principalIds'];
  if (keys.length === 0 || keys.some((k) => !known.includes(k))) return ASSERTABLE_BY_USAGE;
  const role = b.minReviewerRole;
  if (role !== undefined && !(typeof role === 'string' && role in REVIEWER_ROLE_RANK)) {
    return ASSERTABLE_BY_USAGE;
  }
  const kinds = b.principalKinds;
  if (
    kinds !== undefined &&
    !(
      Array.isArray(kinds) &&
      kinds.length > 0 &&
      kinds.every((k) => k === 'user' || k === 'service')
    )
  ) {
    return ASSERTABLE_BY_USAGE;
  }
  const ids = b.principalIds;
  if (
    ids !== undefined &&
    !(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every(nonEmpty))
  ) {
    return ASSERTABLE_BY_USAGE;
  }
  return {
    ...(role !== undefined && { minReviewerRole: role as ReviewerRole }),
    ...(kinds !== undefined && { principalKinds: kinds as ('user' | 'service')[] }),
    ...(ids !== undefined && { principalIds: ids as string[] }),
  };
}

function parseClassBody(raw: unknown): Parsed<ClassBody> {
  const err = (message: string): Parsed<ClassBody> => ({ kind: 'err', message });
  if (raw === null || typeof raw !== 'object') return err('Send a JSON object.');
  const b = raw as Record<string, unknown>;
  if (!nonEmpty(b.name) || b.name.length > 100)
    return err('name is required (at most 100 characters).');
  if (!isWeight(b.weight)) return err('weight is required: a number ≥ 0.');
  if (b.description !== undefined && typeof b.description !== 'string') {
    return err('description must be a string.');
  }
  const scope = parseClassScope(b.scope);
  if (typeof scope === 'string') return err(scope);
  const assertableBy = b.assertableBy === undefined ? undefined : parseAssertableBy(b.assertableBy);
  if (typeof assertableBy === 'string') return err(assertableBy);
  return {
    kind: 'ok',
    body: {
      scope,
      name: b.name,
      weight: b.weight,
      ...(typeof b.description === 'string' && { description: b.description }),
      ...(assertableBy !== undefined && assertableBy !== null && { assertableBy }),
    },
  };
}

function parseClassScope(raw: unknown): JudgeClassScope | string {
  const usage =
    'scope is required: { kind: "tenant" }, { kind: "project", projectId }, or { kind: "agent", projectId, agentId }.';
  if (raw === null || typeof raw !== 'object') return usage;
  const s = raw as Record<string, unknown>;
  if (s.kind === 'tenant') return { kind: 'tenant' };
  if (!nonEmpty(s.projectId)) return usage;
  const projectId = s.projectId as ProjectId;
  if (s.kind === 'project') return { kind: 'project', projectId };
  if (s.kind === 'agent' && nonEmpty(s.agentId))
    return { kind: 'agent', projectId, agentId: s.agentId };
  return usage;
}

/** `?scopeKind=tenant|project|agent&projectId=&agentId=` on the class list. */
function parseClassScopeQuery(
  query: Record<string, string>,
):
  | { readonly kind: 'ok'; readonly scope?: JudgeClassScope }
  | { readonly kind: 'err'; readonly message: string } {
  const kind = query.scopeKind;
  if (kind === undefined || kind.length === 0) return { kind: 'ok' };
  const scope = parseClassScope({ kind, projectId: query.projectId, agentId: query.agentId });
  return typeof scope === 'string' ? { kind: 'err', message: scope } : { kind: 'ok', scope };
}

// ---------- helpers ----------

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isVerdict(v: string): v is Verdict {
  return (VERDICTS as readonly string[]).includes(v);
}

function isWeight(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

function classNotFound(c: Context<AppEnv>, id: string): Response {
  c.status(statusFor('judge-class-not-found') as never);
  return c.json(
    toWireError(
      { code: 'judge-class-not-found', message: `No judge class "${id}".` },
      c.get('requestId'),
    ),
  );
}

/** The caller as a judgment records it, from the request's principal. */
function assertedByOf(
  principal: AppEnv['Variables']['principal'] | undefined,
): JudgmentAssertedBy | undefined {
  if (principal === undefined) return undefined;
  const actor = principal.actor;
  return { kind: actor.kind === 'user' ? 'user' : 'service', id: actor.id };
}

/** What a run ran: its agent at a version (agent turns), else its flow. */
function subjectOf(run: {
  readonly flowId: string;
  readonly flowVersion: string;
  readonly agent?: { readonly id: string; readonly version: string };
}): JudgedSubject {
  return run.agent !== undefined
    ? { kind: 'agent', id: run.agent.id, version: run.agent.version }
    : { kind: 'flow', id: run.flowId, version: run.flowVersion };
}

const POINTER_RE = /^(\/([^~/]|~[01])*)*$/;

function isPointer(p: string): boolean {
  return POINTER_RE.test(p);
}

/** RFC 6901: the value at `pointer` in `doc`. "" is the whole document. */
export function resolvePointer(
  doc: unknown,
  pointer: string,
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  if (pointer === '') return { found: true, value: doc };
  let current: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) return { found: false };
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

// ---------- serialization ----------

function serializeJudgment(j: Judgment): Record<string, unknown> {
  return {
    id: j.id,
    tenantId: j.tenantId,
    projectId: j.projectId,
    runId: j.runId,
    subject: j.subject,
    item: j.item,
    verdict: j.verdict,
    ...(j.reason !== undefined && { reason: j.reason }),
    ...(j.judgeClassId !== undefined && { judgeClassId: j.judgeClassId }),
    assertedBy: j.assertedBy,
    ...(j.participantId !== undefined && { participantId: j.participantId }),
    createdAt: j.createdAt,
    ...(j.unregisteredAt !== undefined && { unregisteredAt: j.unregisteredAt }),
    ...(j.supersededBy !== undefined && { supersededBy: j.supersededBy }),
  };
}

function serializeJudgmentWithCopies(j: JudgmentWithCopies): Record<string, unknown> {
  return {
    ...serializeJudgment(j),
    run: j.run,
    ...(j.itemValue !== undefined && { itemValue: j.itemValue }),
  };
}

function serializeJudgeClass(k: JudgeClass): Record<string, unknown> {
  return {
    id: k.id,
    tenantId: k.tenantId,
    scope: k.scope,
    name: k.name,
    weight: k.weight,
    ...(k.description !== undefined && { description: k.description }),
    ...(k.assertableBy !== undefined && { assertableBy: k.assertableBy }),
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
    ...(k.unregisteredAt !== undefined && { unregisteredAt: k.unregisteredAt }),
  };
}
