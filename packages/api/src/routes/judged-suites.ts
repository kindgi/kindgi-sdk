// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  EvalCaseStoreBinding,
  JudgedEvalCase,
  JudgedItemSummary,
} from '../eval-case-binding.js';
import type { EvalSuiteRegistryBinding } from '../eval-suite-binding.js';
import type {
  JudgedRunListInput,
  JudgedRunWithJudgments,
  Judgment,
  JudgmentRegistryBinding,
} from '../judgment-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

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

    const built = await buildCases(judgments, tenantId, body);
    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await suites.publish({
      tenantId,
      projectId: body.projectId,
      suite: {
        id: suiteId,
        tenantId,
        version: body.version,
        kind: 'judged',
        ...(body.description !== undefined && { description: body.description }),
        spec: {
          source: 'judgments',
          // Where the judgments came from: a comparison's summary names it.
          projectId: body.projectId,
          query: body.query,
          caseCount: built.cases.length,
          truncated: built.truncated,
          builtAt: new Date().toISOString(),
        },
      },
      enqueueTuples: (id) =>
        tuplesForCreate(
          { kind: 'eval_suite', id, tenantId, projectId: body.projectId },
          creatorUserId,
        ),
    });
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
    await cases.putCases({ tenantId, suiteId, version: body.version, cases: built.cases });
    c.status(201);
    return c.json({
      suiteId,
      version: body.version,
      kind: 'judged',
      caseCount: built.cases.length,
      truncated: built.truncated,
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
  readonly query: {
    readonly agentId?: string;
    readonly agentVersion?: string;
    readonly flowId?: string;
    readonly since?: string;
    readonly until?: string;
    readonly judgeClassIds?: readonly string[];
    readonly minJudgments?: number;
  };
}

/** Each class's weight, read once (an unclassified judgment counts 1; a missing class too). */
function classWeights(
  judgments: JudgmentRegistryBinding,
  tenantId: TenantId,
): (judgeClassId: string | undefined) => Promise<number> {
  const weights = new Map<string, number>();
  return async (judgeClassId) => {
    if (judgeClassId === undefined) return 1;
    const known = weights.get(judgeClassId);
    if (known !== undefined) return known;
    const k = await judgments.getClass({ tenantId, judgeClassId, includeUnregistered: true });
    const w = k?.weight ?? 1;
    weights.set(judgeClassId, w);
    return w;
  };
}

function judgedRunFilter(
  tenantId: TenantId,
  body: BuildBody,
): Omit<JudgedRunListInput, 'limit' | 'cursor'> {
  const { judgeClassIds: _ids, minJudgments: _min, ...runFilter } = body.query;
  return { tenantId, projectId: body.projectId, ...runFilter };
}

/** Pages judged runs (newest first, up to MAX_JUDGED_CASES) and turns each into a case. */
async function buildCases(
  judgments: JudgmentRegistryBinding,
  tenantId: TenantId,
  body: BuildBody,
): Promise<{ readonly cases: JudgedEvalCase[]; readonly truncated: boolean }> {
  const list = judgments.listJudgedRuns as NonNullable<JudgmentRegistryBinding['listJudgedRuns']>;
  const weightOf = classWeights(judgments, tenantId);
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
  for (const [key, list] of byKey) items.push(await summarize(key, list, weightOf));
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

async function summarize(
  key: string,
  judgments: readonly Judgment[],
  weightOf: (judgeClassId: string | undefined) => Promise<number>,
): Promise<JudgedItemSummary> {
  let yes = 0;
  let no = 0;
  let yesWeight = 0;
  let totalWeight = 0;
  // What judges a class was restricted to asserted, as it was when each judgment was recorded.
  const restricted = { yesWeight: 0, totalWeight: 0 };
  for (const j of judgments) {
    const w = await weightOf(j.judgeClassId);
    totalWeight += w;
    if (j.restricted === true) restricted.totalWeight += w;
    if (j.verdict === 'yes') {
      yes += 1;
      yesWeight += w;
      if (j.restricted === true) restricted.yesWeight += w;
    } else {
      no += 1;
    }
  }
  const first = judgments[0];
  return {
    key,
    ...(first?.item.pointer !== undefined && { pointer: first.item.pointer }),
    ...(first?.item.rank !== undefined && { rank: first.item.rank }),
    yes,
    no,
    yesWeight,
    totalWeight,
    restricted,
    reasons: judgments.flatMap((j) =>
      j.reason !== undefined ? [{ verdict: j.verdict, reason: j.reason }] : [],
    ),
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
  return { ...strings, ...counted };
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
