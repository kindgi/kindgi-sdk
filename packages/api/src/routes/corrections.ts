// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AgentId, ConversationBinding } from '@kindgi/agents';
import { REVIEWER_ROLE_RANK, type ReviewerRole, ref } from '@kindgi/authz';
import type { RunBinding } from '@kindgi/runtime';
import {
  CORRECTION_ITEM,
  type Cursor,
  type ProjectId,
  type RunId,
  type ScopeSegment,
  type Semver,
  type TenantId,
} from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import { canonical } from '../corrected-items.js';
import {
  type CorrectedItem,
  type CorrectedRunContext,
  type CorrectedSubject,
  type Correction,
  type CorrectionAssertedBy,
  type CorrectionRegistryBinding,
  type CorrectionWithCopies,
  type CorrectorGroup,
  type CorrectorGroupAssertableBy,
  type CorrectorGroupScope,
  VERDICTS,
  type Verdict,
  correctorGroupApplies,
  whyNotAssertable,
} from '../correction-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { ExpectedCall, ExpectedDecisions } from '../expected-decisions.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import { callerReviewerRole } from '../reviewer-role.js';
import type { AppEnv } from '../types.js';
import { captureTurnContext } from './correction-context.js';
import { captureFlowContext } from './correction-flow-context.js';
import { type Refusal, recordRefusal, refusalError } from './denied.js';
import { clampLimit } from './pagination.js';
import { parseListScope } from './scope-params.js';

/**
 * Corrections: yes or no, with an optional reason, about one item of a
 * run's output, recorded under a corrector group.
 *
 * - `POST /v1/corrections`: correct an item of a finished run.
 * - `GET /v1/corrections`: live corrections, filtered by run, agent version,
 *   flow, verdict, group, participant or project scope.
 * - `GET /v1/corrections/:id`: one correction with the stored copies.
 * - `POST /v1/corrections/:id/remove`: remove a correction (soft).
 *
 * Authorization: correcting needs `write` on the run's project (a run
 * inherits its permissions from its project). Reading and removing go by
 * the correction's project (`read` / `write`), since a correction outlives
 * its run.
 */
export function correctionsRouter(
  binding: CorrectionRegistryBinding,
  runBinding: RunBinding,
  authorizer?: Authorizer,
  conversations?: ConversationBinding,
  flows?: FlowRegistryBinding,
  /** Whose reviewer role an expert group checks (T200). */
  reviewers?: ReviewerBinding,
  /** Resolves a corrected agent version's tools, so a correction can only name tools it has. */
  agents?: AgentRegistryBinding,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message, ...details }, requestId));
    };

    const parsed = parseCorrectionBody(await c.req.json().catch(() => null));
    if (parsed.kind === 'err') return fail('bad-input', parsed.message);
    const body = parsed.body;

    const asserted = assertedByOf(c.get('principal'));
    if (asserted === undefined) {
      return fail('permission-denied', 'Correcting needs a user or a service token.');
    }

    const prepared = await prepareCorrection(c, body, runBinding, binding, authorizer, {
      asserted,
      reviewers,
    });
    if (prepared.kind === 'err') return fail(prepared.code, prepared.message, prepared.details);
    const { run, subject, projectId, itemValue, conversationId, expert, replayOf } = prepared;
    const unknownTool = await unknownCorrectionTool(tenantId, subject, body.correction, agents);
    if (unknownTool !== undefined) {
      return fail('bad-input', `The corrected version has no tool "${unknownTool}".`);
    }
    const first = await isFirstCorrection(binding, tenantId, body.runId);
    const captured = first
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
    // A comparison's replay is stamped as one with its copy (stored with the
    // first correction), so a test set leaves it out (`isReplayCopy`).
    const context = first && replayOf !== undefined ? { ...(captured ?? {}), replayOf } : captured;

    const correction = await binding.record({
      tenantId,
      projectId,
      runId: body.runId,
      run: {
        subject,
        input: run.input,
        output: run.output,
        // Which segment the run was in, kept with the copy: a test set for a
        // segment takes only its runs.
        segments: run.segments,
        ...(context !== undefined && { context }),
      },
      item: body.item,
      ...(itemValue !== undefined && { itemValue }),
      verdict: body.verdict,
      ...(body.reason !== undefined && { reason: body.reason }),
      ...(body.correction !== undefined && { correction: body.correction }),
      ...(body.correctorGroupId !== undefined && { correctorGroupId: body.correctorGroupId }),
      ...(expert === true && { expert }),
      assertedBy: asserted,
      ...(body.participantId !== undefined && { participantId: body.participantId }),
    });
    c.status(201);
    return c.json(serializeCorrection(correction));
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
      ...optional('correctorGroupId', q('correctorGroupId')),
      ...optional('participantId', q('participantId')),
      ...(q('cursor') !== undefined && { cursor: q('cursor') as Cursor }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (j) => ref('project', j.projectId));
    return c.json({
      data: visible.map(serializeCorrection),
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:correctionId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const correctionId = c.req.param('correctionId');
    const correction = await binding.get({ tenantId, correctionId });
    if (
      correction === null ||
      (authorizer !== undefined &&
        !(await authorizer.can(c, 'read', ref('project', correction.projectId))))
    ) {
      c.status(statusFor('correction-not-found') as never);
      return c.json(
        toWireError(
          { code: 'correction-not-found', message: `No correction "${correctionId}".` },
          requestId,
        ),
      );
    }
    return c.json(serializeCorrectionWithCopies(correction));
  });

  r.post('/:correctionId/remove', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const correctionId = c.req.param('correctionId');
    const notFound = () => {
      c.status(statusFor('correction-not-found') as never);
      return c.json(
        toWireError(
          { code: 'correction-not-found', message: `No live correction "${correctionId}".` },
          requestId,
        ),
      );
    };
    const correction = await binding.get({ tenantId, correctionId });
    if (correction === null || correction.unregisteredAt !== undefined) return notFound();
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'write', ref('project', correction.projectId)))
    ) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message: `Not allowed to remove correction "${correctionId}".`,
          },
          requestId,
        ),
      );
    }
    const outcome = await binding.unregister({ tenantId, correctionId });
    if (!outcome.unregistered) return notFound();
    return c.json({ correctionId, unregistered: true });
  });

  return r;
}

/**
 * Corrector groups: the deployment's named groups of judges ("expert",
 * "user", …), each with a weight, scoped to the tenant, a project, or an
 * agent in a project.
 *
 * Managing a tenant-scoped group needs `admin` on the tenant; a project-
 * or agent-scoped group needs `admin` on its project. Listing returns the
 * groups the caller may read.
 */
export function correctorGroupsRouter(
  binding: CorrectionRegistryBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const scopeRef = (tenantId: TenantId, scope: CorrectorGroupScope) =>
    scope.kind === 'tenant' ? ref('tenant', tenantId) : ref('project', scope.projectId);

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const fail = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };
    const parsed = parseGroupBody(await c.req.json().catch(() => null));
    if (parsed.kind === 'err') return fail('bad-input', parsed.message);
    const { scope, name, weight, description, assertableBy } = parsed.body;
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'admin', scopeRef(tenantId, scope)))
    ) {
      return fail('permission-denied', 'Not allowed to manage corrector groups in this scope.');
    }
    const outcome = await binding.createGroup({
      tenantId,
      scope,
      name,
      weight,
      ...(description !== undefined && { description }),
      ...(assertableBy !== undefined && { assertableBy }),
    });
    if (outcome.kind === 'name-taken') {
      return fail(
        'corrector-group-name-taken',
        `A corrector group named "${name}" already exists here.`,
      );
    }
    c.status(201);
    // Its creator is an admin on its scope: they see whom it names.
    return c.json(serializeCorrectorGroup(outcome.correctorGroup, true));
  });

  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const scope = parseGroupScopeQuery(c.req.query());
    if (scope.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: scope.message }, requestId));
    }
    const cursor = c.req.query('cursor');
    const page = await binding.listGroups({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (k) => scopeRef(tenantId, k.scope));
    // Whom a group names (`principalIds`) is for its scope's admins only.
    const naming = visible.filter((k) => k.assertableBy?.principalIds !== undefined);
    const seenBy =
      authorizer === undefined || naming.length === 0
        ? undefined
        : new Set(
            (
              await authorizer.filterByCan(c, 'admin', naming, (k) => scopeRef(tenantId, k.scope))
            ).map((k) => k.id),
          );
    return c.json({
      data: visible.map((k) =>
        serializeCorrectorGroup(k, seenBy === undefined || seenBy.has(k.id)),
      ),
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  const loadGroup = async (
    c: Context<AppEnv>,
    action: 'read' | 'admin',
  ): Promise<CorrectorGroup | Response> => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const correctorGroupId = c.req.param('correctorGroupId') ?? '';
    const found = await binding.getGroup({
      tenantId,
      correctorGroupId,
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
              message: 'Not allowed to manage corrector groups in this scope.',
            },
            requestId,
          ),
        );
      }
      if (!allowed) return groupNotFound(c, correctorGroupId);
    }
    return found ?? groupNotFound(c, correctorGroupId);
  };

  r.get('/:correctorGroupId', async (c) => {
    const found = await loadGroup(c, 'read');
    if (found instanceof Response) return found;
    const tenantId = c.get('tenantId') as TenantId;
    // Whom it names (`principalIds`) is for its scope's admins only.
    const seesPrincipals =
      authorizer === undefined ||
      found.assertableBy?.principalIds === undefined ||
      (await authorizer.can(c, 'admin', scopeRef(tenantId, found.scope)));
    return c.json(serializeCorrectorGroup(found, seesPrincipals));
  });

  r.patch('/:correctorGroupId', async (c) => {
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
                : 'Send weight (a number ≥ 0), description (a string) and/or assertableBy (who may assert the group, or null for anyone).',
          },
          requestId,
        ),
      );
    }
    const found = await loadGroup(c, 'admin');
    if (found instanceof Response) return found;
    if (found.unregisteredAt !== undefined) return groupNotFound(c, found.id);
    const updated = await binding.updateGroup({
      tenantId,
      correctorGroupId: found.id,
      ...(weight !== undefined && { weight: weight as number }),
      ...(description !== undefined && { description: description as string }),
      ...(assertableBy !== undefined && { assertableBy }),
    });
    // Loaded as an admin: they see whom it names.
    return updated === null
      ? groupNotFound(c, found.id)
      : c.json(serializeCorrectorGroup(updated, true));
  });

  r.post('/:correctorGroupId/unregister', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const found = await loadGroup(c, 'admin');
    if (found instanceof Response) return found;
    const outcome = await binding.unregisterGroup({ tenantId, correctorGroupId: found.id });
    if (!outcome.unregistered) return groupNotFound(c, found.id);
    return c.json({ correctorGroupId: found.id, unregistered: true });
  });

  return r;
}

type Prepared =
  | {
      readonly kind: 'ok';
      readonly run: {
        readonly input: unknown;
        readonly output: unknown;
        readonly segments: readonly ScopeSegment[];
      };
      readonly subject: CorrectedSubject;
      readonly projectId: ProjectId;
      readonly itemValue?: unknown;
      readonly conversationId?: string;
      /** The group was restricted and the caller met it. */
      readonly expert?: true;
      /** The run a comparison's replay re-ran, when the corrected run is one. */
      readonly replayOf?: string;
    }
  | {
      readonly kind: 'err';
      readonly code: string;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

/**
 * Everything a correction needs from its run, or why it can't be recorded:
 * the run exists, the caller may correct it, it has finished with an output,
 * the group (if any) applies to it, and the pointer (if any) resolves.
 */
async function prepareCorrection(
  c: Context<AppEnv>,
  body: CorrectionBody,
  runBinding: RunBinding,
  binding: CorrectionRegistryBinding,
  authorizer: Authorizer | undefined,
  who: { readonly asserted: CorrectionAssertedBy; readonly reviewers: ReviewerBinding | undefined },
): Promise<Prepared> {
  const err = (code: string, message: string): Prepared => ({ kind: 'err', code, message });
  const tenantId = c.get('tenantId') as TenantId;
  const run = await runBinding.getRun(tenantId, body.runId as RunId);
  if (run === null) return err('run-not-found', `No run "${body.runId}".`);
  // A run inherits its permissions from its project (as cancelling one
  // does): correcting it needs `write` there.
  if (
    authorizer !== undefined &&
    !(await authorizer.can(c, 'write', ref('project', run.projectId as unknown as string)))
  ) {
    return err('permission-denied', `Not allowed to correct run "${body.runId}".`);
  }
  // An erasure cleared its content: there's nothing to correct (T273 M-5).
  if (run.contentErasedAt !== undefined) {
    return err(
      'run-erased',
      `Run "${body.runId}" was erased (a person's words were removed): there's nothing to correct.`,
    );
  }
  if (run.status !== 'completed' || run.output === undefined || run.output === null) {
    return err(
      'run-not-finished',
      `Run "${body.runId}" has no output to correct yet (status ${run.status}).`,
    );
  }
  const subject = subjectOf(run);
  const projectId = run.projectId as unknown as ProjectId;
  let expert = false;
  if (body.correctorGroupId !== undefined) {
    const correctorGroup = await applicableGroup(binding, tenantId, body.correctorGroupId, {
      projectId,
      subject,
    });
    if (correctorGroup === null) {
      return err(
        'corrector-group-not-applicable',
        `Corrector group "${body.correctorGroupId}" doesn't exist or doesn't apply to this run's project or agent.`,
      );
    }
    if (correctorGroup.assertableBy !== undefined) {
      const reviewerRole = await callerReviewerRole(c, who.reviewers);
      const why = whyNotAssertable(correctorGroup.assertableBy, {
        ...who.asserted,
        ...(reviewerRole !== undefined && { reviewerRole }),
      });
      if (why !== undefined) {
        // Who the caller is rules it out: recorded, as every refusal the
        // API decides itself is.
        const refusal: Refusal = {
          action: 'write',
          resource: ref('project', run.projectId as unknown as string),
          message: `You can't correct as "${correctorGroup.name}": ${why}.`,
          failing: 'actor',
          code: 'corrector-group-not-allowed',
        };
        recordRefusal(c, authorizer, refusal);
        const { code, message, ...details } = refusalError(refusal);
        return { kind: 'err', code, message, details };
      }
      expert = true;
    }
  }
  const copy = { input: run.input, output: run.output, segments: run.segments ?? [] };
  const extra = {
    ...(run.agent !== undefined && { conversationId: run.agent.conversationId as string }),
    ...(expert && { expert: true as const }),
    ...(run.replayOf != null && { replayOf: run.replayOf as unknown as string }),
  };
  if (body.item.pointer === undefined)
    return { kind: 'ok', run: copy, subject, projectId, ...extra };
  const found = resolvePointer(run.output, body.item.pointer);
  if (!found.found) {
    return err(
      'item-not-found',
      `Nothing at "${body.item.pointer}" in run "${body.runId}"'s output.`,
    );
  }
  return { kind: 'ok', run: copy, subject, projectId, itemValue: found.value, ...extra };
}

/** Whether the run has no live correction yet (its copy is stored with the first). */
/**
 * What a run's first correction keeps so the run can be replayed later: a
 * turn's history and retrieved context; a flow run's tool calls with
 * their results.
 */
function captureContext(input: {
  readonly tenantId: TenantId;
  readonly runId: string;
  readonly subject: CorrectedSubject;
  readonly output: unknown;
  readonly conversationId: string | undefined;
  readonly runBinding: RunBinding;
  readonly conversations: ConversationBinding | undefined;
  readonly flows: FlowRegistryBinding | undefined;
}): Promise<CorrectedRunContext | undefined> {
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

async function isFirstCorrection(
  binding: CorrectionRegistryBinding,
  tenantId: TenantId,
  runId: string,
): Promise<boolean> {
  const page = await binding.list({ tenantId, runId, limit: 1 });
  return page.data.length === 0;
}

/** The live group, when it exists and its scope covers the run; else `null`. */
async function applicableGroup(
  binding: CorrectionRegistryBinding,
  tenantId: TenantId,
  correctorGroupId: string,
  run: { readonly projectId: ProjectId; readonly subject: CorrectedSubject },
): Promise<CorrectorGroup | null> {
  const correctorGroup = await binding.getGroup({ tenantId, correctorGroupId });
  return correctorGroup !== null && correctorGroupApplies(correctorGroup.scope, run)
    ? correctorGroup
    : null;
}

// ---------- request parsing ----------

interface CorrectionBody {
  readonly runId: string;
  readonly item: CorrectedItem;
  readonly verdict: Verdict;
  readonly reason?: string;
  readonly correction?: ExpectedDecisions;
  readonly correctorGroupId?: string;
  readonly participantId?: string;
}

type Parsed<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'err'; readonly message: string };

const MAX_REASON = 4000;

function parseCorrectionBody(raw: unknown): Parsed<CorrectionBody> {
  const err = (message: string): Parsed<CorrectionBody> => ({ kind: 'err', message });
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
  const correction = parseExpectedDecisionsField(b.correction, item);
  if (typeof correction === 'string') return err(correction);
  return {
    kind: 'ok',
    body: {
      runId: b.runId,
      item,
      verdict: b.verdict,
      ...(correction !== undefined && { correction }),
      ...(typeof b.correctorGroupId === 'string' && { correctorGroupId: b.correctorGroupId }),
      ...(typeof b.reason === 'string' && b.reason.length > 0 && { reason: b.reason }),
      ...(typeof b.participantId === 'string' && { participantId: b.participantId }),
    },
  };
}

const MAX_CORRECTION_CALLS = 50;
const MAX_CORRECTION_ARGS = 100;
const MAX_CORRECTION_ARGS_SIZE = 4000;
const MAX_TOOL_LEN = 200;

/** One expected call `{ tool, args }`, or a message saying what's wrong. */
function parseExpectedCall(call: unknown): ExpectedCall | string {
  if (call === null || typeof call !== 'object' || Array.isArray(call)) {
    return 'each correction.calls entry is an object { tool, args }.';
  }
  const cc = call as Record<string, unknown>;
  if (!nonEmpty(cc.tool)) return 'each correction call needs a non-empty tool.';
  if (cc.tool.length > MAX_TOOL_LEN) {
    return `a correction call's tool name is at most ${MAX_TOOL_LEN} characters.`;
  }
  if (cc.args === null || typeof cc.args !== 'object' || Array.isArray(cc.args)) {
    return 'each correction call needs an args object ({} asks only that the tool was called).';
  }
  if (Object.keys(cc.args).length > MAX_CORRECTION_ARGS) {
    return `a correction call's args hold at most ${MAX_CORRECTION_ARGS} fields.`;
  }
  // A value is copied onto the correction, the case and every eval run's
  // differences, so cap each call's args by their canonical size.
  if (canonical(cc.args).length > MAX_CORRECTION_ARGS_SIZE) {
    return `a correction call's args are at most ${MAX_CORRECTION_ARGS_SIZE} characters.`;
  }
  return { tool: cc.tool, args: cc.args as Record<string, unknown> };
}

/**
 * The expected decisions in a `correction` field, or a message saying
 * what's wrong. A tool can't be in both `calls` and `notCalled`, and at least
 * one of them must be non-empty (both empty is a 400). Argument values aren't
 * checked here; the comparator compares them on the replay.
 */
function parseExpectedDecisions(raw: unknown): ExpectedDecisions | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'correction must be an object { calls, notCalled }.';
  }
  const b = raw as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== 'calls' && k !== 'notCalled')) {
    return 'correction has only calls and notCalled.';
  }
  const { calls, notCalled } = b;
  if (!Array.isArray(calls) || !Array.isArray(notCalled)) {
    return 'correction.calls and correction.notCalled are both arrays.';
  }
  if (calls.length > MAX_CORRECTION_CALLS || notCalled.length > MAX_CORRECTION_CALLS) {
    return `correction.calls and correction.notCalled hold at most ${MAX_CORRECTION_CALLS} each.`;
  }
  const parsedCalls: ExpectedCall[] = [];
  for (const call of calls) {
    const parsed = parseExpectedCall(call);
    if (typeof parsed === 'string') return parsed;
    parsedCalls.push(parsed);
  }
  if (notCalled.some((t) => !nonEmpty(t))) {
    return 'each correction.notCalled entry is a non-empty tool name.';
  }
  if ((notCalled as string[]).some((t) => t.length > MAX_TOOL_LEN)) {
    return `each correction.notCalled tool name is at most ${MAX_TOOL_LEN} characters.`;
  }
  if (parsedCalls.length === 0 && notCalled.length === 0) {
    return 'correction needs at least one of calls or notCalled.';
  }
  const named = new Set(parsedCalls.map((call) => call.tool));
  const inBoth = (notCalled as string[]).find((t) => named.has(t));
  if (inBoth !== undefined) {
    return `"${inBoth}" can't be in both correction.calls and correction.notCalled.`;
  }
  return { calls: parsedCalls, notCalled: notCalled as string[] };
}

/** What's wrong with the optional fields (group, reason, participant), if anything. */
function optionalFieldError(b: Record<string, unknown>): string | undefined {
  if (b.correctorGroupId !== undefined && !nonEmpty(b.correctorGroupId)) {
    return 'correctorGroupId must be a corrector group id, or left out for an unclassified correction.';
  }
  if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > MAX_REASON)) {
    return `reason must be a string of at most ${MAX_REASON} characters.`;
  }
  if (b.participantId !== undefined && !nonEmpty(b.participantId)) {
    return 'participantId must be a non-empty string.';
  }
  return undefined;
}

function parseItem(raw: unknown): CorrectedItem | string {
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

/**
 * The correction item key is reserved for Kindgi. A correction on it is accepted
 * only when it carries a correction at pointer `""`; any other correction there,
 * at any pointer, is a 400. And a correction is accepted only there — so every
 * correction for a run by one expert lands on the same item and counts once, and
 * no caller's own item can collide with it. Returns the message for a correction
 * that breaks either rule, else `undefined`.
 */
function reservedItemError(item: CorrectedItem, hasCorrection: boolean): string | undefined {
  if (item.key === CORRECTION_ITEM.key) {
    if (!hasCorrection) {
      return `the item "${CORRECTION_ITEM.key}" is reserved for expected decisions; correct an item of the output instead.`;
    }
    if (item.pointer !== undefined && item.pointer !== CORRECTION_ITEM.pointer) {
      return 'expected decisions cover the whole output; leave item.pointer as "" or unset.';
    }
    return undefined;
  }
  if (hasCorrection) {
    return `a correction is recorded under the item "${CORRECTION_ITEM.key}", not "${item.key}".`;
  }
  return undefined;
}

/**
 * The expected decisions in a correction's `correction` field, an error
 * message, or `undefined` when there are none. They must parse; and whether or
 * not they are present, the item must obey the reserved-key rule.
 */
function parseExpectedDecisionsField(
  raw: unknown,
  item: CorrectedItem,
): ExpectedDecisions | string | undefined {
  const correction = raw === undefined ? undefined : parseExpectedDecisions(raw);
  if (typeof correction === 'string') return correction;
  return reservedItemError(item, correction !== undefined) ?? correction;
}

interface GroupBody {
  readonly scope: CorrectorGroupScope;
  readonly name: string;
  readonly weight: number;
  readonly description?: string;
  readonly assertableBy?: CorrectorGroupAssertableBy;
}

const ASSERTABLE_BY_USAGE =
  'assertableBy says who may assert the group: { minReviewerRole?: "standard" | "senior" | "admin", principalKinds?: ["user" | "service", …], principalIds?: [id, …] }, with at least one of them.';

/** `assertableBy`: a restriction, `null` (on an update: lift it), or what's wrong. */
function parseAssertableBy(raw: unknown): CorrectorGroupAssertableBy | null | string {
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

function parseGroupBody(raw: unknown): Parsed<GroupBody> {
  const err = (message: string): Parsed<GroupBody> => ({ kind: 'err', message });
  if (raw === null || typeof raw !== 'object') return err('Send a JSON object.');
  const b = raw as Record<string, unknown>;
  if (!nonEmpty(b.name) || b.name.length > 100)
    return err('name is required (at most 100 characters).');
  if (!isWeight(b.weight)) return err('weight is required: a number ≥ 0.');
  if (b.description !== undefined && typeof b.description !== 'string') {
    return err('description must be a string.');
  }
  const scope = parseGroupScope(b.scope);
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

function parseGroupScope(raw: unknown): CorrectorGroupScope | string {
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

/** `?scopeKind=tenant|project|agent&projectId=&agentId=` on the group list. */
function parseGroupScopeQuery(
  query: Record<string, string>,
):
  | { readonly kind: 'ok'; readonly scope?: CorrectorGroupScope }
  | { readonly kind: 'err'; readonly message: string } {
  const kind = query.scopeKind;
  if (kind === undefined || kind.length === 0) return { kind: 'ok' };
  const scope = parseGroupScope({ kind, projectId: query.projectId, agentId: query.agentId });
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

function groupNotFound(c: Context<AppEnv>, id: string): Response {
  c.status(statusFor('corrector-group-not-found') as never);
  return c.json(
    toWireError(
      { code: 'corrector-group-not-found', message: `No corrector group "${id}".` },
      c.get('requestId'),
    ),
  );
}

/** The caller as a correction records it, from the request's principal. */
function assertedByOf(
  principal: AppEnv['Variables']['principal'] | undefined,
): CorrectionAssertedBy | undefined {
  if (principal === undefined) return undefined;
  const actor = principal.actor;
  return { kind: actor.kind === 'user' ? 'user' : 'service', id: actor.id };
}

/**
 * Best-effort: a correction may only name tools the corrected agent version
 * has. Returns the first offending tool, or `undefined` when all are known
 * or the check cannot run. It is skipped for flow subjects (a flow has no
 * single tool list) and when the version cannot be resolved — a correction
 * outlives its version — so it never blocks an otherwise valid correction.
 */
async function unknownCorrectionTool(
  tenantId: TenantId,
  subject: CorrectedSubject,
  correction: ExpectedDecisions | undefined,
  agents: AgentRegistryBinding | undefined,
): Promise<string | undefined> {
  if (correction === undefined || agents === undefined || subject.kind !== 'agent')
    return undefined;
  const version = await agents.getVersion({
    tenantId,
    agentId: subject.id as AgentId,
    version: subject.version as Semver,
  });
  if (version === null) return undefined;
  const have = new Set(version.tools.map((t) => t.id as string));
  for (const tool of [...correction.calls.map((call) => call.tool), ...correction.notCalled]) {
    if (!have.has(tool)) return tool;
  }
  return undefined;
}

/** What a run ran: its agent at a version (agent turns), else its flow. */
function subjectOf(run: {
  readonly flowId: string;
  readonly flowVersion: string;
  readonly agent?: { readonly id: string; readonly version: string };
}): CorrectedSubject {
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

function serializeCorrection(j: Correction): Record<string, unknown> {
  return {
    id: j.id,
    tenantId: j.tenantId,
    projectId: j.projectId,
    runId: j.runId,
    subject: j.subject,
    item: j.item,
    verdict: j.verdict,
    ...(j.reason !== undefined && { reason: j.reason }),
    ...(j.correction !== undefined && { correction: j.correction }),
    ...(j.correctorGroupId !== undefined && { correctorGroupId: j.correctorGroupId }),
    ...(j.expert === true && { expert: true }),
    assertedBy: j.assertedBy,
    ...(j.participantId !== undefined && { participantId: j.participantId }),
    createdAt: j.createdAt,
    ...(j.unregisteredAt !== undefined && { unregisteredAt: j.unregisteredAt }),
    ...(j.supersededBy !== undefined && { supersededBy: j.supersededBy }),
  };
}

function serializeCorrectionWithCopies(j: CorrectionWithCopies): Record<string, unknown> {
  return {
    ...serializeCorrection(j),
    run: j.run,
    ...(j.itemValue !== undefined && { itemValue: j.itemValue }),
  };
}

/**
 * A corrector group as the caller sees it. `assertableBy.principalIds` names
 * people and tokens: only an admin on the group's scope gets it
 * (`seesPrincipals`); every reader gets `principalCount`.
 */
function serializeCorrectorGroup(
  k: CorrectorGroup,
  seesPrincipals: boolean,
): Record<string, unknown> {
  const restriction = k.assertableBy;
  const assertableBy =
    restriction === undefined
      ? undefined
      : (() => {
          const { principalIds, ...rest } = restriction;
          return principalIds === undefined
            ? rest
            : {
                ...rest,
                ...(seesPrincipals && { principalIds }),
                principalCount: principalIds.length,
              };
        })();
  return {
    id: k.id,
    tenantId: k.tenantId,
    scope: k.scope,
    name: k.name,
    weight: k.weight,
    ...(k.description !== undefined && { description: k.description }),
    ...(assertableBy !== undefined && { assertableBy }),
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
    ...(k.unregisteredAt !== undefined && { unregisteredAt: k.unregisteredAt }),
  };
}
