// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, ProjectId, ScopeSegment, TenantId, UserId } from '@kindgi/types';

import { classWeightReader, summarizeCorrections } from '../corrected-summary.js';
import {
  type CorrectedRunListInput,
  type CorrectedRunWithCorrections,
  type Correction,
  type CorrectionRegistryBinding,
  isReplayCopy,
} from '../correction-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type {
  CorrectedEvalCase,
  CorrectedItemSummary,
  EvalCaseStoreBinding,
  TestCaseExpectedDecisions,
} from '../eval-case-binding.js';
import type { EvalSuiteRegistryBinding } from '../eval-suite-binding.js';
import type { ItemRights } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseSegmentsBody } from './segments.js';
import { parseTimeInput } from './time-input.js';

/** The most cases a test set built from corrections holds. */
export const MAX_CORRECTED_CASES = 1000;
const PAGE = 100;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Test sets built from corrections: `judged` eval suites.
 *
 * - `POST /v1/eval-suites/:suiteId/versions/from-corrections` builds and
 *   publishes a version whose cases are copies of corrected runs (input,
 *   what the turn read, the corrected output) with each item's corrections
 *   summed up, weighted by judge class (an unclassified correction counts
 *   1). Needs `admin` on the project, as publishing a suite does.
 * - `GET /v1/eval-suites/:suiteId/versions/:version/cases` lists them.
 */
export function correctedSuitesRouter(
  suites: EvalSuiteRegistryBinding,
  corrections: CorrectionRegistryBinding,
  cases: EvalCaseStoreBinding,
  authorizer?: Authorizer,
  /** Rights on a suite more than one project serves (`item-rights.ts`); absent → the suite's own. */
  itemRights?: ItemRights,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/:suiteId/versions/from-corrections', async (c) => {
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
    if (corrections.listCorrectedRuns === undefined) {
      return fail(
        c,
        'test-sets-not-supported',
        'This deployment cannot build test sets from corrections.',
      );
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await buildCorrectedSuite(
      { suites, corrections, cases },
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
    if (outcome.kind === 'project-mismatch') {
      return projectMismatch(c, 'eval-suite', suiteId, outcome.projectId, 'build');
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
    // A suite more than one project serves was checked on those projects,
    // this version among them (`item-rights.ts`, the suites' middleware).
    if (
      authorizer !== undefined &&
      (await itemRights?.multi(c, 'eval_suite', suiteId)) === undefined &&
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

/** Which corrected runs a test set is built from, and which of their corrections count. */
export interface CorrectedSuiteQuery {
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly judgeClassIds?: readonly string[];
  readonly minCorrections?: number;
  /** Only runs started in this segment path or below it. */
  readonly segments?: readonly ScopeSegment[];
}

export interface BuildCorrectedSuiteInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly version: string;
  /** The project whose corrected runs it takes, and the suite's project. */
  readonly projectId: ProjectId;
  readonly description?: string;
  readonly query: CorrectedSuiteQuery;
  /** The user who built it, made the suite's creator. */
  readonly creatorUserId?: UserId;
}

export type BuildCorrectedSuiteOutcome =
  | { readonly kind: 'ok'; readonly caseCount: number; readonly truncated: boolean }
  | { readonly kind: 'already-registered' }
  | { readonly kind: 'project-not-found' }
  /** The suite belongs to another project: nothing is written. */
  | { readonly kind: 'project-mismatch'; readonly projectId: ProjectId };

/**
 * Build a test set and publish it as a `judged` suite version, as
 * `POST /v1/eval-suites/{suiteId}/versions/from-corrections` does: the
 * corrected runs the query picks (newest first, at most `MAX_CORRECTED_CASES`),
 * each a case with its items' corrections summed up. The binding must list
 * corrected runs (`listCorrectedRuns`).
 */
export async function buildCorrectedSuite(
  deps: {
    readonly suites: EvalSuiteRegistryBinding;
    readonly corrections: CorrectionRegistryBinding;
    readonly cases: EvalCaseStoreBinding;
  },
  input: BuildCorrectedSuiteInput,
): Promise<BuildCorrectedSuiteOutcome> {
  const { tenantId, suiteId, version, projectId } = input;
  const built = await buildCases(deps.corrections, tenantId, input);
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
        source: 'corrections',
        // Where the corrections came from: a comparison's summary names it.
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
  if (outcome.kind === 'project-mismatch') {
    return { kind: 'project-mismatch', projectId: outcome.projectId };
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
  /** The corrected-run filter, as recorded in the suite's spec. */
  readonly query: CorrectedSuiteQuery;
}

function correctedRunFilter(
  tenantId: TenantId,
  body: Pick<BuildBody, 'projectId' | 'query'>,
): Omit<CorrectedRunListInput, 'limit' | 'cursor'> {
  const { judgeClassIds: _ids, minCorrections: _min, ...runFilter } = body.query;
  return { tenantId, projectId: body.projectId, ...runFilter };
}

/** Pages corrected runs (newest first, up to MAX_CORRECTED_CASES) and turns each into a case. */
async function buildCases(
  corrections: CorrectionRegistryBinding,
  tenantId: TenantId,
  body: Pick<BuildBody, 'projectId' | 'query'>,
): Promise<{ readonly cases: CorrectedEvalCase[]; readonly truncated: boolean }> {
  const list = corrections.listCorrectedRuns as NonNullable<
    CorrectionRegistryBinding['listCorrectedRuns']
  >;
  const weightOf = classWeightReader(corrections, tenantId);
  const filter = correctedRunFilter(tenantId, body);
  const cases: CorrectedEvalCase[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await list({ ...filter, limit: PAGE, ...(cursor !== undefined && { cursor }) });
    for (const corrected of page.data) {
      const built = await toCase(corrected, body.query, weightOf);
      if (built !== undefined) cases.push(built);
      if (cases.length >= MAX_CORRECTED_CASES) return { cases, truncated: true };
    }
    if (!page.hasMore || page.nextCursor === undefined) return { cases, truncated: false };
    cursor = page.nextCursor;
  }
}

async function toCase(
  corrected: CorrectedRunWithCorrections,
  q: BuildBody['query'],
  weightOf: (judgeClassId: string | undefined) => Promise<number>,
): Promise<CorrectedEvalCase | undefined> {
  // A comparison's replay is never a case, whatever the binding lists.
  if (isReplayCopy(corrected.run)) return undefined;
  const kept =
    q.judgeClassIds === undefined
      ? corrected.corrections
      : corrected.corrections.filter(
          (j) => j.judgeClassId !== undefined && q.judgeClassIds?.includes(j.judgeClassId),
        );
  if (kept.length === 0 || kept.length < (q.minCorrections ?? 1)) return undefined;
  const byKey = new Map<string, Correction[]>();
  for (const j of kept) byKey.set(j.item.key, [...(byKey.get(j.item.key) ?? []), j]);
  const items: CorrectedItemSummary[] = [];
  for (const [key, list] of byKey) items.push(await summarizeCorrections(key, list, weightOf));
  items.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  // Each kept correction's expected decisions ride onto the case, keyed by
  // its correction and carrying its judge class and restriction, so a
  // restricted-only comparison filters them the way it filters items.
  const corrections: TestCaseExpectedDecisions[] = kept.flatMap((j) =>
    j.correction === undefined
      ? []
      : [
          {
            ...j.correction,
            correctionId: j.id,
            ...(j.judgeClassId !== undefined && { judgeClassId: j.judgeClassId }),
            ...(j.restricted === true && { restricted: true as const }),
          },
        ],
  );
  const run = corrected.run;
  return {
    caseId: run.runId,
    subject: run.subject,
    input: run.input,
    ...(run.context !== undefined && { context: run.context }),
    output: run.output,
    items,
    ...(corrections.length > 0 && { corrections }),
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
    if ((field === 'since' || field === 'until') && parseTimeInput(v) === null) {
      return `${field} must be an ISO 8601 time.`;
    }
    query[field] = v;
  }
  if (query.agentVersion !== undefined && query.agentId === undefined) {
    return 'agentVersion needs agentId.';
  }
  return query;
}

/** Which corrections count: by class, and how many a run needs. */
function parseCorrectionFilters(
  b: Record<string, unknown>,
): Pick<BuildBody['query'], 'judgeClassIds' | 'minCorrections'> | string {
  const ids = b.judgeClassIds;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string' || i.length === 0))
  ) {
    return 'judgeClassIds must be a list of judge class ids.';
  }
  const min = b.minCorrections;
  if (min !== undefined && !(Number.isInteger(min) && (min as number) >= 1)) {
    return 'minCorrections must be a whole number ≥ 1.';
  }
  return {
    ...(ids !== undefined && { judgeClassIds: ids as string[] }),
    ...(min !== undefined && { minCorrections: min as number }),
  };
}

/** The optional corrected-run filters; a message when one is malformed. */
function parseQuery(b: Record<string, unknown>): BuildBody['query'] | string {
  const strings = parseStringFilters(b);
  if (typeof strings === 'string') return strings;
  const counted = parseCorrectionFilters(b);
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
    return err('Name the agent (agentId) or the flow (flowId) whose corrected runs to use.');
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
