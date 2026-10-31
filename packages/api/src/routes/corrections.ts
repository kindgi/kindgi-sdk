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
  CORRECTION_SORTED_TO,
  CORRECTION_STATUSES,
  type CorrectedAnswerItem,
  type CorrectedRunContext,
  type CorrectedSubject,
  type Correction,
  type CorrectionLink,
  type CorrectionListInput,
  type CorrectionMadeBy,
  type CorrectionRegistryBinding,
  type CorrectionSortedTo,
  type CorrectionStatus,
  type CorrectionWithCopies,
  type CorrectorGroup,
  type CorrectorGroupAssertableBy,
  type CorrectorGroupScope,
  NOT_FIXED_STATUSES,
  VERDICTS,
  type Verdict,
  correctorGroupApplies,
  whyNotAssertable,
} from '../correction-binding.js';
import {
  type CorrectionChange,
  parseCorrectionLink,
  planChange,
  sortAtSave,
} from '../correction-sorting.js';
import { statusFor, toWireError } from '../errors.js';
import type { ExpectedCall } from '../expected-decisions.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import { type ItemRights, forbidden } from '../item-rights.js';
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
 * Corrections: whether a finished run's decisions and answer were right,
 * and what was right instead, each with a status and sorted to whoever
 * fixes it.
 *
 * - `POST /v1/corrections`: correct a finished run; it's sorted at save.
 * - `GET /v1/corrections`: corrections, filtered by run, agent version,
 *   flow, status, sorting, who made them, when, group, participant or
 *   project scope.
 * - `GET /v1/corrections/counts`: how many are in each status, in a project.
 * - `GET /v1/corrections/:id`: one correction with the stored copies.
 * - `PATCH /v1/corrections/:id`: re-sort it or change its status.
 * - `POST /v1/corrections/:id/remove`: remove a correction; it can't come back.
 *
 * Authorization: correcting needs `write` on the run's project (a run
 * inherits its permissions from its project). Reading goes by the
 * correction's project (`read`), since a correction outlives its run.
 * Changing one needs `publish` on its agent (or flow); removing one, being
 * its author or `admin` on its project.
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
  /** For an agent or flow more than one project serves, a change takes write on the correction's project. */
  itemRights?: ItemRights,
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

    const asserted = madeByOf(c.get('principal'));
    if (asserted === undefined) {
      return fail('permission-denied', 'Correcting needs a user or a service token.');
    }

    const prepared = await prepareCorrection(c, body, runBinding, binding, authorizer, {
      asserted,
      reviewers,
    });
    if (prepared.kind === 'err') return fail(prepared.code, prepared.message, prepared.details);
    const { run, subject, projectId, conversationId, expert, replayOf } = prepared;
    const unknownTool = await unknownCorrectionTool(tenantId, subject, body, agents);
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
      run: {
        subject,
        input: run.input,
        output: run.output,
        // Which segment the run was in, kept with the copy: a test set for a
        // segment takes only its runs.
        segments: run.segments,
        ...(context !== undefined && { context }),
      },
      ...body,
      ...(expert === true && { expert }),
      madeBy: asserted,
      // Sorted at save, by the rule (`sortAtSave`).
      ...sortAtSave({ ...body, expert: expert === true }, asserted, new Date().toISOString()),
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
    if (q('verdict') !== undefined) {
      return fail('bad-input', 'verdict is gone: filter by status, sortedTo or from.');
    }
    if (q('agentVersion') !== undefined && q('agentId') === undefined) {
      return fail('bad-input', 'agentVersion needs agentId.');
    }
    const filters = parseListFilters(c);
    if (typeof filters === 'string') return fail('bad-input', filters);
    // `me` is the caller as the server stamps an author, so a client needn't know how.
    const madeBy = q('madeBy');
    if (madeBy !== undefined && madeBy !== 'me') {
      return fail('bad-input', 'madeBy takes only me: the caller.');
    }
    const me = madeBy === undefined ? undefined : madeByOf(c.get('principal'));
    if (madeBy !== undefined && me === undefined) {
      return fail('bad-input', 'madeBy=me needs a signed-in caller.');
    }

    const page = await binding.list({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...optional('runId', q('runId')),
      ...optional('agentId', q('agentId')),
      ...optional('agentVersion', q('agentVersion')),
      ...optional('flowId', q('flowId')),
      ...filters,
      ...(me !== undefined && { madeBy: me }),
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

  // The chips: how many of an agent's (or a project's) corrections are in each status.
  r.get('/counts', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const fail = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };
    const scope = parseListScope(c.req.query(), { tenantId });
    if (scope.kind === 'err') return fail('scope-invalid', scope.message);
    if (scope.scope?.kind !== 'project')
      return fail('bad-input', 'counts needs scopeKind=project and scopeId (the project).');
    const projectId = scope.scope.projectId;
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'read', ref('project', projectId as unknown as string)))
    ) {
      return fail('permission-denied', `Not allowed to read project "${projectId}".`);
    }
    const agentId = c.req.query('agentId');
    const counts = await binding.counts({
      tenantId,
      scope: scope.scope,
      ...(agentId !== undefined && agentId.length > 0 && { agentId }),
    });
    return c.json(counts);
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
    // Its author may remove it, or an admin on its project.
    const who = madeByOf(c.get('principal'));
    const isAuthor =
      who !== undefined && who.kind === correction.madeBy.kind && who.id === correction.madeBy.id;
    if (
      authorizer !== undefined &&
      !isAuthor &&
      !(await authorizer.can(c, 'admin', ref('project', correction.projectId)))
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

  // A person's re-sort or status change, by the change table (`planChange`).
  r.patch('/:correctionId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const correctionId = c.req.param('correctionId');
    const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message, ...details }, requestId));
    };
    const change = parseChangeBody(await c.req.json().catch(() => null));
    if (typeof change === 'string') return fail('bad-input', change);
    const who = madeByOf(c.get('principal'));
    if (who === undefined) {
      return fail('permission-denied', 'Changing a correction needs a user or a service token.');
    }
    const read = await binding.get({ tenantId, correctionId });
    const notFound = () => fail('correction-not-found', `No live correction "${correctionId}".`);
    if (
      read === null ||
      (read.unregisteredAt !== undefined && read.status !== 'removed') ||
      (authorizer !== undefined &&
        !(await authorizer.can(c, 'read', ref('project', read.projectId))))
    ) {
      return notFound();
    }
    if (authorizer !== undefined) {
      const { kind, id } = read.subject;
      // An item more than one project serves: the change is in the
      // correction's project, so it takes the right there, never the item's
      // (item-rights.ts, rule 3). An agent's `publish` is its project's
      // `write`, as suggested changes take it.
      const projects = await itemRights?.multi(c, kind, id);
      if (itemRights !== undefined && projects !== undefined) {
        const refused = await itemRights.on(c, read.projectId, 'write');
        if (refused !== undefined) {
          return forbidden(
            c,
            refused,
            `Permission denied: this needs write on project ${read.projectId}, where the correction was made (${refused.decision.reason})`,
          );
        }
      } else {
        const decision = await authorizer.check(c, 'publish', ref(kind, id));
        if (!decision.allowed) {
          return fail(
            'permission-denied',
            `Permission denied: this needs publish on ${kind} "${id}" (${decision.reason})`,
          );
        }
      }
    }
    let current: Correction = read;
    // Planned against what was read; when it changed meanwhile, planned once
    // more against what it is now.
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = planChange(current, change, who, new Date().toISOString());
      if (plan.kind === 'bad-input') return fail('bad-input', plan.message);
      if (plan.kind === 'not-allowed') {
        return fail(
          'correction-status-change-not-allowed',
          `A correction that's ${plan.from} can't become ${plan.to}.`,
          { from: plan.from, to: plan.to },
        );
      }
      const outcome = await binding.update({
        tenantId,
        correctionId,
        expected: { status: current.status, sortedTo: current.sortedTo ?? null },
        ...plan.change,
      });
      if (outcome.kind === 'not-found') return notFound();
      if (outcome.kind === 'updated') return c.json(serializeCorrection(outcome.correction));
      // What it is now, as the store answers it: a field it left out is cleared.
      current = outcome.correction;
    }
    return fail(
      'correction-status-change-not-allowed',
      `Correction "${correctionId}" changed while this change was made: read it and try again.`,
      { from: current.status, to: change.status ?? current.status },
    );
  });

  return r;
}

/** The list's filters (2.6): status, sortedTo, from, since and until. */
function parseListFilters(
  c: Context<AppEnv>,
): Pick<CorrectionListInput, 'statuses' | 'sortedTo' | 'from' | 'since' | 'until'> | string {
  // Repeated (`status=open&status=fixed`) or comma-separated, as runs take them.
  const given = (name: string) =>
    (c.req.queries(name) ?? []).flatMap((v) => v.split(',')).map((v) => v.trim());
  const statuses: CorrectionStatus[] = [];
  for (const v of given('status')) {
    if (v === 'not-fixed') statuses.push(...NOT_FIXED_STATUSES);
    else if ((CORRECTION_STATUSES as readonly string[]).includes(v)) {
      statuses.push(v as CorrectionStatus);
    } else {
      return `status must be one of: not-fixed, ${CORRECTION_STATUSES.join(', ')}.`;
    }
  }
  const sortedTo: (CorrectionSortedTo | 'none')[] = [];
  for (const v of given('sortedTo')) {
    if (v !== 'none' && !(CORRECTION_SORTED_TO as readonly string[]).includes(v)) {
      return `sortedTo must be one of: none, ${CORRECTION_SORTED_TO.join(', ')}.`;
    }
    sortedTo.push(v as CorrectionSortedTo | 'none');
  }
  const from = c.req.query('from');
  if (from !== undefined && from !== 'experts' && from !== 'end-users' && from !== 'all') {
    return 'from must be one of: experts, end-users, all.';
  }
  const times: { since?: string; until?: string } = {};
  for (const name of ['since', 'until'] as const) {
    const v = c.req.query(name);
    if (v === undefined) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return `${name} must be a date or a time (ISO 8601).`;
    times[name] = new Date(t).toISOString();
  }
  return {
    ...(statuses.length > 0 && { statuses: [...new Set(statuses)] }),
    ...(sortedTo.length > 0 && { sortedTo: [...new Set(sortedTo)] }),
    ...(from !== undefined && from !== 'all' && { from }),
    ...times,
  };
}

/** A PATCH body: `{ sortedTo?, status?, link?, reason? }`, at least one of the first two. */
function parseChangeBody(raw: unknown): CorrectionChange | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'Send a JSON object.';
  const b = raw as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !['sortedTo', 'status', 'link', 'reason'].includes(k));
  if (unknown !== undefined)
    return `A change has sortedTo, status, link and reason, not ${unknown}.`;
  if (
    b.sortedTo !== undefined &&
    !(
      typeof b.sortedTo === 'string' &&
      (CORRECTION_SORTED_TO as readonly string[]).includes(b.sortedTo)
    )
  ) {
    return `sortedTo must be one of: ${CORRECTION_SORTED_TO.join(', ')}.`;
  }
  if (
    b.status !== undefined &&
    !(typeof b.status === 'string' && (CORRECTION_STATUSES as readonly string[]).includes(b.status))
  ) {
    return `status must be one of: ${CORRECTION_STATUSES.join(', ')}.`;
  }
  let link: CorrectionLink | undefined;
  if (b.link !== undefined) {
    link = typeof b.link === 'string' ? parseCorrectionLink(b.link) : undefined;
    if (link === undefined)
      return 'link must be a URL, an Improve run (ir-<its id>) or a suggested change (sc-<its id>).';
  }
  if (b.reason !== undefined && (!nonEmpty(b.reason) || b.reason.length > MAX_TEXT)) {
    return `reason must be a string of 1 to ${MAX_TEXT} characters.`;
  }
  return {
    ...(typeof b.sortedTo === 'string' && { sortedTo: b.sortedTo as CorrectionSortedTo }),
    ...(typeof b.status === 'string' && { status: b.status as CorrectionStatus }),
    ...(link !== undefined && { link }),
    ...(typeof b.reason === 'string' && { reason: b.reason }),
  };
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
 * the group (if any) applies to it, and each item's pointer resolves.
 */
async function prepareCorrection(
  c: Context<AppEnv>,
  body: CorrectionBody,
  runBinding: RunBinding,
  binding: CorrectionRegistryBinding,
  authorizer: Authorizer | undefined,
  who: { readonly asserted: CorrectionMadeBy; readonly reviewers: ReviewerBinding | undefined },
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
  const unfinished = unfinishedRun(run, body.runId);
  if (unfinished !== undefined) return err(unfinished.code, unfinished.message);
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
  const missing = missingItem(run.output, body.runId, body.items);
  if (missing !== undefined) return err(missing.code, missing.message);
  return { kind: 'ok', run: copy, subject, projectId, ...extra };
}

type CorrectedRun = NonNullable<Awaited<ReturnType<RunBinding['getRun']>>>;

/** Why a run can't be corrected, or made a test case: an erasure cleared it, or it has no output yet. */
export function unfinishedRun(
  run: CorrectedRun,
  runId: string,
): { readonly code: string; readonly message: string } | undefined {
  // An erasure cleared its content: there's nothing to correct (T273 M-5).
  if (run.contentErasedAt !== undefined) {
    return {
      code: 'run-erased',
      message: `Run "${runId}" was erased (a person's words were removed): there's nothing to correct.`,
    };
  }
  if (run.status !== 'completed' || run.output === undefined || run.output === null) {
    return {
      code: 'run-not-finished',
      message: `Run "${runId}" has no output to correct yet (status ${run.status}).`,
    };
  }
  return undefined;
}

/** The first item whose pointer finds nothing in the run's output, as its refusal. */
export function missingItem(
  output: unknown,
  runId: string,
  items: readonly CorrectedAnswerItem[] | undefined,
): { readonly code: string; readonly message: string } | undefined {
  const missing = (items ?? []).find(
    (item) => item.pointer !== undefined && !resolvePointer(output, item.pointer).found,
  );
  if (missing?.pointer === undefined) return undefined;
  return {
    code: 'item-not-found',
    message: `Nothing at "${missing.pointer}" in run "${runId}"'s output.`,
  };
}

/**
 * What a run's first correction keeps so the run can be replayed later: a
 * turn's history and retrieved context; a flow run's tool calls with
 * their results.
 */
export function captureContext(input: {
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

/** Whether the run has no live correction yet (its copy is stored with the first). */
export async function isFirstCorrection(
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

export interface CorrectionBody {
  readonly runId: string;
  readonly decisions?: Verdict;
  readonly shouldCall?: readonly ExpectedCall[];
  readonly mustNotCall?: readonly string[];
  readonly answer?: Verdict;
  readonly shouldSay?: string;
  readonly why?: string;
  readonly items?: readonly CorrectedAnswerItem[];
  readonly correctorGroupId?: string;
  readonly participantId?: string;
}

export type Parsed<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'err'; readonly message: string };

/** The most characters in `why` and `shouldSay`. */
const MAX_TEXT = 4000;
const MAX_CORRECTION_CALLS = 50;
const MAX_CORRECTION_ARGS = 100;
const MAX_CORRECTION_ARGS_SIZE = 4000;
const MAX_TOOL_LEN = 200;
const MAX_ITEMS = 100;
const MAX_ITEM_KEY_LEN = 200;
const MAX_ITEM_POINTER_LEN = 500;

/** The fields a correction had before statuses, refused with a pointer to their new names. */
const OLD_FIELDS: Readonly<Record<string, string>> = {
  item: 'answer and items',
  verdict: 'decisions and answer',
  reason: 'why',
  correction: 'shouldCall and mustNotCall',
};

export function parseCorrectionBody(raw: unknown): Parsed<CorrectionBody> {
  const err = (message: string): Parsed<CorrectionBody> => ({ kind: 'err', message });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err('Send a JSON object.');
  }
  const b = raw as Record<string, unknown>;
  const old = Object.keys(OLD_FIELDS).find((k) => b[k] !== undefined);
  if (old !== undefined) return err(`${old} is gone: a correction says ${OLD_FIELDS[old]}.`);
  if (!nonEmpty(b.runId)) return err('runId is required.');
  const decisions = parseVerdictField(b.decisions, 'decisions');
  if (decisions.kind === 'err') return decisions;
  const answer = parseVerdictField(b.answer, 'answer');
  if (answer.kind === 'err') return answer;
  const expected = parseExpected(b, decisions.value);
  if (typeof expected === 'string') return err(expected);
  const text = parseTexts(b, answer.value);
  if (typeof text === 'string') return err(text);
  const items = b.items === undefined ? undefined : parseItems(b.items);
  if (typeof items === 'string') return err(items);
  // Items alone are a correction: a ranked list's items are checked without a model.
  if (
    decisions.value === undefined &&
    answer.value === undefined &&
    (items === undefined || items.length === 0)
  ) {
    return err('A correction says at least one of decisions, answer and items (right or wrong).');
  }
  if (b.correctorGroupId !== undefined && !nonEmpty(b.correctorGroupId)) {
    return err(
      'correctorGroupId must be a corrector group id, or left out for an unclassified correction.',
    );
  }
  if (b.participantId !== undefined && !nonEmpty(b.participantId)) {
    return err('participantId must be a non-empty string.');
  }
  return {
    kind: 'ok',
    body: {
      runId: b.runId,
      ...(decisions.value !== undefined && { decisions: decisions.value }),
      ...expected,
      ...(answer.value !== undefined && { answer: answer.value }),
      ...text,
      ...(items !== undefined && { items }),
      ...(typeof b.correctorGroupId === 'string' && { correctorGroupId: b.correctorGroupId }),
      ...(typeof b.participantId === 'string' && { participantId: b.participantId }),
    },
  };
}

function parseVerdictField(
  raw: unknown,
  name: string,
):
  | { readonly kind: 'ok'; readonly value?: Verdict }
  | { readonly kind: 'err'; readonly message: string } {
  if (raw === undefined) return { kind: 'ok' };
  if (typeof raw === 'string' && isVerdict(raw)) return { kind: 'ok', value: raw };
  return { kind: 'err', message: `${name} must be one of: ${VERDICTS.join(', ')}.` };
}

/**
 * `shouldCall` and `mustNotCall`, only with `decisions: "wrong"`, which
 * needs at least one entry: decisions are checked exactly, without a model.
 * A tool can't be in both.
 */
function parseExpected(
  b: Record<string, unknown>,
  decisions: Verdict | undefined,
):
  | { readonly shouldCall?: readonly ExpectedCall[]; readonly mustNotCall?: readonly string[] }
  | string {
  const { shouldCall, mustNotCall } = b;
  if (decisions !== 'wrong') {
    if (shouldCall !== undefined || mustNotCall !== undefined) {
      return 'shouldCall and mustNotCall go with decisions: "wrong".';
    }
    return {};
  }
  if (shouldCall !== undefined && !Array.isArray(shouldCall)) return 'shouldCall is an array.';
  if (mustNotCall !== undefined && !Array.isArray(mustNotCall)) return 'mustNotCall is an array.';
  const calls = (shouldCall ?? []) as unknown[];
  const notCalled = (mustNotCall ?? []) as unknown[];
  if (calls.length === 0 && notCalled.length === 0) {
    return 'decisions: "wrong" needs at least one entry in shouldCall or mustNotCall.';
  }
  if (calls.length > MAX_CORRECTION_CALLS || notCalled.length > MAX_CORRECTION_CALLS) {
    return `shouldCall and mustNotCall hold at most ${MAX_CORRECTION_CALLS} each.`;
  }
  const parsedCalls: ExpectedCall[] = [];
  for (const call of calls) {
    const parsed = parseExpectedCall(call);
    if (typeof parsed === 'string') return parsed;
    parsedCalls.push(parsed);
  }
  if (notCalled.some((t) => !nonEmpty(t))) return 'each mustNotCall entry is a non-empty tool id.';
  const tools = notCalled as string[];
  if (tools.some((t) => t.length > MAX_TOOL_LEN)) {
    return `each mustNotCall tool id is at most ${MAX_TOOL_LEN} characters.`;
  }
  const named = new Set(parsedCalls.map((call) => call.tool));
  const inBoth = tools.find((t) => named.has(t));
  if (inBoth !== undefined) return `"${inBoth}" can't be in both shouldCall and mustNotCall.`;
  return {
    ...(parsedCalls.length > 0 && { shouldCall: parsedCalls }),
    ...(tools.length > 0 && { mustNotCall: tools }),
  };
}

/** One `shouldCall` entry `{ tool, args? }`; `args` only when the inputs matter. */
function parseExpectedCall(call: unknown): ExpectedCall | string {
  if (call === null || typeof call !== 'object' || Array.isArray(call)) {
    return 'each shouldCall entry is an object { tool, args? }.';
  }
  const cc = call as Record<string, unknown>;
  if (!nonEmpty(cc.tool)) return 'each shouldCall entry needs a non-empty tool.';
  if (cc.tool.length > MAX_TOOL_LEN) {
    return `a shouldCall tool id is at most ${MAX_TOOL_LEN} characters.`;
  }
  if (cc.args === undefined) return { tool: cc.tool, args: {} };
  if (cc.args === null || typeof cc.args !== 'object' || Array.isArray(cc.args)) {
    return "a shouldCall entry's args is an object of the inputs that matter.";
  }
  if (Object.keys(cc.args).length > MAX_CORRECTION_ARGS) {
    return `a shouldCall entry's args hold at most ${MAX_CORRECTION_ARGS} fields.`;
  }
  // A value is copied onto the correction, the case and every test run's
  // differences, so cap each call's args by their canonical size.
  if (canonical(cc.args).length > MAX_CORRECTION_ARGS_SIZE) {
    return `a shouldCall entry's args are at most ${MAX_CORRECTION_ARGS_SIZE} characters.`;
  }
  return { tool: cc.tool, args: cc.args as Record<string, unknown> };
}

/**
 * `why`, and `shouldSay` only with `answer: "wrong"`, which needs one of
 * them, so a judging model has something to check against.
 */
function parseTexts(
  b: Record<string, unknown>,
  answer: Verdict | undefined,
): { readonly shouldSay?: string; readonly why?: string } | string {
  for (const name of ['shouldSay', 'why'] as const) {
    const v = b[name];
    if (v !== undefined && (typeof v !== 'string' || v.length > MAX_TEXT)) {
      return `${name} must be a string of at most ${MAX_TEXT} characters.`;
    }
  }
  const shouldSay =
    typeof b.shouldSay === 'string' && b.shouldSay.length > 0 ? b.shouldSay : undefined;
  const why = typeof b.why === 'string' && b.why.length > 0 ? b.why : undefined;
  if (shouldSay !== undefined && answer !== 'wrong') return 'shouldSay goes with answer: "wrong".';
  if (answer === 'wrong' && shouldSay === undefined && why === undefined) {
    return 'answer: "wrong" needs shouldSay or why.';
  }
  return { ...(shouldSay !== undefined && { shouldSay }), ...(why !== undefined && { why }) };
}

/** A ranked answer's items `[{ key, pointer?, rank?, verdict }]`, each key once. */
function parseItems(raw: unknown): readonly CorrectedAnswerItem[] | string {
  if (!Array.isArray(raw)) return 'items is an array of { key, pointer?, rank?, verdict }.';
  if (raw.length > MAX_ITEMS) return `items holds at most ${MAX_ITEMS} entries.`;
  const items: CorrectedAnswerItem[] = [];
  const keys = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'each items entry is an object { key, pointer?, rank?, verdict }.';
    }
    const i = entry as Record<string, unknown>;
    if (!nonEmpty(i.key)) return 'each items entry needs a key.';
    if (i.key.length > MAX_ITEM_KEY_LEN) {
      return `an item's key is at most ${MAX_ITEM_KEY_LEN} characters: its id, not its text.`;
    }
    if (i.key === CORRECTION_ITEM.key) return `the item key "${CORRECTION_ITEM.key}" is reserved.`;
    if (keys.has(i.key)) return `the item key "${i.key}" is in items twice.`;
    keys.add(i.key);
    if (i.pointer !== undefined && (typeof i.pointer !== 'string' || !isPointer(i.pointer))) {
      return 'an item\'s pointer is a JSON Pointer such as "/matches/2".';
    }
    if (typeof i.pointer === 'string' && i.pointer.length > MAX_ITEM_POINTER_LEN) {
      return `an item's pointer is at most ${MAX_ITEM_POINTER_LEN} characters.`;
    }
    if (i.rank !== undefined && !(Number.isInteger(i.rank) && (i.rank as number) >= 0)) {
      return "an item's rank is a whole number ≥ 0.";
    }
    if (typeof i.verdict !== 'string' || !isVerdict(i.verdict)) {
      return `each items entry's verdict is one of: ${VERDICTS.join(', ')}.`;
    }
    items.push({
      key: i.key,
      ...(typeof i.pointer === 'string' && { pointer: i.pointer }),
      ...(typeof i.rank === 'number' && { rank: i.rank }),
      verdict: i.verdict,
    });
  }
  return items;
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
export function madeByOf(
  principal: AppEnv['Variables']['principal'] | undefined,
): CorrectionMadeBy | undefined {
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
export async function unknownCorrectionTool(
  tenantId: TenantId,
  subject: CorrectedSubject,
  body: Pick<CorrectionBody, 'shouldCall' | 'mustNotCall'>,
  agents: AgentRegistryBinding | undefined,
): Promise<string | undefined> {
  const named = [...(body.shouldCall ?? []).map((call) => call.tool), ...(body.mustNotCall ?? [])];
  if (named.length === 0 || agents === undefined || subject.kind !== 'agent') return undefined;
  const version = await agents.getVersion({
    tenantId,
    agentId: subject.id as AgentId,
    version: subject.version as Semver,
  });
  if (version === null) return undefined;
  const have = new Set(version.tools.map((t) => t.id as string));
  return named.find((tool) => !have.has(tool));
}

/** What a run ran: its agent at a version (agent turns), else its flow. */
export function subjectOf(run: {
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
    ...(j.decisions !== undefined && { decisions: j.decisions }),
    ...(j.shouldCall !== undefined && { shouldCall: j.shouldCall }),
    ...(j.mustNotCall !== undefined && { mustNotCall: j.mustNotCall }),
    ...(j.answer !== undefined && { answer: j.answer }),
    ...(j.shouldSay !== undefined && { shouldSay: j.shouldSay }),
    ...(j.why !== undefined && { why: j.why }),
    ...(j.items !== undefined && { items: j.items }),
    ...(j.correctorGroupId !== undefined && { correctorGroupId: j.correctorGroupId }),
    ...(j.expert === true && { expert: true }),
    madeBy: j.madeBy,
    ...(j.participantId !== undefined && { participantId: j.participantId }),
    status: j.status,
    ...(j.sortedTo !== undefined && { sortedTo: j.sortedTo }),
    ...(j.sorted !== undefined && { sorted: j.sorted }),
    ...(j.link !== undefined && { link: j.link }),
    ...(j.fixedIn !== undefined && { fixedIn: j.fixedIn }),
    ...(j.statusNote !== undefined && { statusNote: j.statusNote }),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    ...(j.unregisteredAt !== undefined && { unregisteredAt: j.unregisteredAt }),
    ...(j.supersededBy !== undefined && { supersededBy: j.supersededBy }),
  };
}

function serializeCorrectionWithCopies(j: CorrectionWithCopies): Record<string, unknown> {
  return { ...serializeCorrection(j), run: j.run };
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
