// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, ProjectId, ScopeSegment, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  EvalCaseStoreBinding,
  JudgedEvalCase,
  JudgedItemSummary,
} from '../eval-case-binding.js';
import type { EvalSuiteRegistryBinding } from '../eval-suite-binding.js';
import { classWeightReader, summarizeJudgments } from '../judged-summary.js';
import {
  type JudgedRunListInput,
  type JudgedRunWithJudgments,
  type Judgment,
  type JudgmentRegistryBinding,
  isReplayCopy,
} from '../judgment-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseSegmentsBody } from './segments.js';

/** The most cases a test set built from judgments holds. */
export const MAX_JUDGED_CASES = 1000;
const PAGE = 100;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Test sets built from judgments: `judged` eval suites.
 *
 * - `POST /v1/eval-suites/:suiteId/versions/from-judgments` builds and
 *   publishes a version whose cases are copies of judged runs (input,
 *   what the turn read, the judged output) with each item's judgments
 *   summed up, weighted by judge class (an unclassified judgment counts
 *   1). Needs `admin` on the project, as publishing a suite does.
 * - `GET /v1/eval-suites/:suiteId/versions/:version/cases` lists them.
 */
export function judgedSuitesRouter(
  suites: EvalSuiteRegistryBinding,
  judgments: JudgmentRegistryBinding,
  cases: EvalCaseStoreBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/:suiteId/versions/from-judgments', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const parsed = parseBuildBody(await c.req.json().catch(() => null));
    if (parsed.kind === 'err') return fail(c, 'bad-input', parsed.message);
    const body = parsed.body;
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'admin', ref('project', body.projectId)))
    ) {
      return fail(c, 'permission-denied', 'Building a test set needs admin on the project.');
    }
    if (judgments.listJudgedRuns === undefined) {
      return fail(
        c,
        'test-sets-not-supported',
        'This deployment cannot build test sets from judgments.',
      );
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await buildJudgedSuite(
      { suites, judgments, cases },
      { tenantId, suiteId, ...body, ...(creatorUserId !== undefined && { creatorUserId }) },
    );
    if (outcome.kind === 'already-registered') {
      return fail(
        c,
        'eval-suite-already-registered',
        `Eval suite "${suiteId}" version "${body.version}" is already registered.`,
      );
    }
    if (outcome.kind === 'project-not-found') {
      return fail(c, 'bad-input', `\`projectId\` "${body.projectId}" is not a project here.`);
    }
    c.status(201);
    return c.json({
      suiteId,
      version: body.version,
      kind: 'judged',
      caseCount: outcome.caseCount,
      truncated: outcome.truncated,
    });
  });

  r.get('/:suiteId/versions/:version/cases', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const version = c.req.param('version');
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'read', ref('eval_suite', suiteId)))
    ) {
      return fail(c, 'eval-suite-not-found', `No eval suite "${suiteId}".`);
    }
    const cursor = c.req.query('cursor');
    const page = await cases.listCases({
      tenantId,
      suiteId,
      version,
      limit: clampLimit(c.req.query('limit'), 25, 100),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    return c.json({
      data: page.data,
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  return r;
}

/** Which judged runs a test set is built from, and which of their judgments count. */
export interface JudgedSuiteQuery {
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly judgeClassIds?: readonly string[];
  readonly minJudgments?: number;
  /** Only runs started in this segment path or below it. */
  readonly segments?: readonly ScopeSegment[];
}

export interface BuildJudgedSuiteInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly version: string;
  /** The project whose judged runs it takes, and the suite's project. */
  readonly projectId: ProjectId;
  readonly description?: string;
  readonly query: JudgedSuiteQuery;
  /** The user who built it, made the suite's creator. */
  readonly creatorUserId?: UserId;
}

export type BuildJudgedSuiteOutcome =
  | { readonly kind: 'ok'; readonly caseCount: number; readonly truncated: boolean }
  | { readonly kind: 'already-registered' }
  | { readonly kind: 'project-not-found' };

/**
 * Build a test set and publish it as a `judged` suite version, as
 * `POST /v1/eval-suites/{suiteId}/versions/from-judgments` does: the
 * judged runs the query picks (newest first, at most `MAX_JUDGED_CASES`),
 * each a case with its items' judgments summed up. The binding must list
 * judged runs (`listJudgedRuns`).
 */
export async function buildJudgedSuite(
  deps: {
    readonly suites: EvalSuiteRegistryBinding;
    readonly judgments: JudgmentRegistryBinding;
    readonly cases: EvalCaseStoreBinding;
  },
  input: BuildJudgedSuiteInput,
): Promise<BuildJudgedSuiteOutcome> {
  const { tenantId, suiteId, version, projectId } = input;
  const built = await buildCases(deps.judgments, tenantId, input);
  const outcome = await deps.suites.publish({
    tenantId,
    projectId,
    suite: {
      id: suiteId,
      tenantId,
      version,
      kind: 'judged',
      ...(input.description !== undefined && { description: input.description }),
      spec: {
        source: 'judgments',
        // Where the judgments came from: a comparison's summary names it.
        projectId,
        query: input.query,
        caseCount: built.cases.length,
        truncated: built.truncated,
        builtAt: new Date().toISOString(),
      },
    },
    enqueueTuples: (id) =>
      tuplesForCreate({ kind: 'eval_suite', id, tenantId, projectId }, input.creatorUserId),
  });
  if (outcome.kind === 'already-registered' || outcome.kind === 'project-not-found') {
    return { kind: outcome.kind };
  }
  await deps.cases.putCases({ tenantId, suiteId, version, cases: built.cases });
  return { kind: 'ok', caseCount: built.cases.length, truncated: built.truncated };
}

function fail(c: Context<AppEnv>, code: string, message: string): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, c.get('requestId')));
}

// ---------- building ----------

interface BuildBody {
  readonly version: string;
  readonly projectId: ProjectId;
  readonly description?: string;
  /** The judged-run filter, as recorded in the suite's spec. */
  readonly query: JudgedSuiteQuery;
}

function judgedRunFilter(
  tenantId: TenantId,
  body: Pick<BuildBody, 'projectId' | 'query'>,
): Omit<JudgedRunListInput, 'limit' | 'cursor'> {
  const { judgeClassIds: _ids, minJudgments: _min, ...runFilter } = body.query;
  return { tenantId, projectId: body.projectId, ...runFilter };
}

/** Pages judged runs (newest first, up to MAX_JUDGED_CASES) and turns each into a case. */
async function buildCases(
  judgments: JudgmentRegistryBinding,
  tenantId: TenantId,
  body: Pick<BuildBody, 'projectId' | 'query'>,
): Promise<{ readonly cases: JudgedEvalCase[]; readonly truncated: boolean }> {
  const list = judgments.listJudgedRuns as NonNullable<JudgmentRegistryBinding['listJudgedRuns']>;
  const weightOf = classWeightReader(judgments, tenantId);
  const filter = judgedRunFilter(tenantId, body);
  const cases: JudgedEvalCase[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await list({ ...filter, limit: PAGE, ...(cursor !== undefined && { cursor }) });
    for (const judged of page.data) {
      const built = await toCase(judged, body.query, weightOf);
      if (built !== undefined) cases.push(built);
      if (cases.length >= MAX_JUDGED_CASES) return { cases, truncated: true };
    }
    if (!page.hasMore || page.nextCursor === undefined) return { cases, truncated: false };
    cursor = page.nextCursor;
  }
}

async function toCase(
  judged: JudgedRunWithJudgments,
  q: BuildBody['query'],
  weightOf: (judgeClassId: string | undefined) => Promise<number>,
): Promise<JudgedEvalCase | undefined> {
  // A comparison's replay is never a case, whatever the binding lists.
  if (isReplayCopy(judged.run)) return undefined;
  const kept =
    q.judgeClassIds === undefined
      ? judged.judgments
      : judged.judgments.filter(
          (j) => j.judgeClassId !== undefined && q.judgeClassIds?.includes(j.judgeClassId),
        );
  if (kept.length === 0 || kept.length < (q.minJudgments ?? 1)) return undefined;
  const byKey = new Map<string, Judgment[]>();
  for (const j of kept) byKey.set(j.item.key, [...(byKey.get(j.item.key) ?? []), j]);
  const items: JudgedItemSummary[] = [];
  for (const [key, list] of byKey) items.push(await summarizeJudgments(key, list, weightOf));
  items.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  const run = judged.run;
  return {
    caseId: run.runId,
    subject: run.subject,
    input: run.input,
    ...(run.context !== undefined && { context: run.context }),
    output: run.output,
    items,
  };
}

// ---------- parsing ----------

type Parsed<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'err'; readonly message: string };

const STRING_FILTERS = ['agentId', 'agentVersion', 'flowId', 'since', 'until'] as const;

/** The string filters (agent, version, flow, time window); a message when one is malformed. */
function parseStringFilters(b: Record<string, unknown>): Record<string, string> | string {
  const query: Record<string, string> = {};
  for (const field of STRING_FILTERS) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0) return `${field} must be a non-empty string.`;
    if ((field === 'since' || field === 'until') && Number.isNaN(Date.parse(v))) {
      return `${field} must be an ISO 8601 time.`;
    }
    query[field] = v;
  }
  if (query.agentVersion !== undefined && query.agentId === undefined) {
    return 'agentVersion needs agentId.';
  }
  return query;
}

/** Which judgments count: by class, and how many a run needs. */
function parseJudgmentFilters(
  b: Record<string, unknown>,
): Pick<BuildBody['query'], 'judgeClassIds' | 'minJudgments'> | string {
  const ids = b.judgeClassIds;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string' || i.length === 0))
  ) {
    return 'judgeClassIds must be a list of judge class ids.';
  }
  const min = b.minJudgments;
  if (min !== undefined && !(Number.isInteger(min) && (min as number) >= 1)) {
    return 'minJudgments must be a whole number ≥ 1.';
  }
  return {
    ...(ids !== undefined && { judgeClassIds: ids as string[] }),
    ...(min !== undefined && { minJudgments: min as number }),
  };
}

/** The optional judged-run filters; a message when one is malformed. */
function parseQuery(b: Record<string, unknown>): BuildBody['query'] | string {
  const strings = parseStringFilters(b);
  if (typeof strings === 'string') return strings;
  const counted = parseJudgmentFilters(b);
  if (typeof counted === 'string') return counted;
  const segments = parseSegmentsBody(b.segments);
  if (segments.kind === 'err') return segments.message;
  return {
    ...strings,
    ...counted,
    ...(segments.segments !== undefined && { segments: segments.segments }),
  };
}

function parseBuildBody(raw: unknown): Parsed<BuildBody> {
  const err = (message: string): Parsed<BuildBody> => ({ kind: 'err', message });
  if (raw === null || typeof raw !== 'object') return err('Send a JSON object.');
  const b = raw as Record<string, unknown>;
  if (typeof b.version !== 'string' || !SEMVER_RE.test(b.version)) {
    return err('version is required: a semver such as "1.0.0".');
  }
  if (typeof b.projectId !== 'string' || b.projectId.length === 0) {
    return err('projectId is required.');
  }
  if (b.agentId === undefined && b.flowId === undefined) {
    return err('Name the agent (agentId) or the flow (flowId) whose judged runs to use.');
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    return err('description must be a string.');
  }
  const query = parseQuery(b);
  if (typeof query === 'string') return err(query);
  return {
    kind: 'ok',
    body: {
      version: b.version,
      projectId: b.projectId as ProjectId,
      ...(typeof b.description === 'string' && { description: b.description }),
      query,
    },
  };
}
