// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AgentId, ConversationBinding } from '@kindgi/agents';
import { type Action, type ResourceRef, ref } from '@kindgi/authz';
import type { RunBinding } from '@kindgi/runtime';
import type { Cursor, ProjectId, RunId, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type { CorrectionRegistryBinding } from '../correction-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import {
  type HeldProjects,
  type ItemRights,
  type ItemServing,
  forbidden,
  heldProjects,
  recordedProjects,
} from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { limitedCallerRefusal } from '../middleware/key-project.js';
import { TEST_CASE_KINDS, type TestCaseKind } from '../test-case-binding.js';
import { type TestSetRegistryBinding, agentTestSetId } from '../test-set-binding.js';
import type { AppEnv } from '../types.js';
import {
  captureContext,
  isFirstCorrection,
  madeByOf,
  missingItem,
  parseCorrectionBody,
  subjectOf,
  unfinishedRun,
  unknownCorrectionTool,
} from './corrections.js';
import { includeListOf } from './include-list.js';
import { clampLimit } from './pagination.js';
import { UUID_RE } from './uuid-param.js';

type Ctx = Context<AppEnv>;

/** The most characters in a retired case's `reason`. */
const MAX_REASON = 4000;

/**
 * `/agents/:agentId/test-set` and the paths under it. Their routes check
 * their own permissions, so the agents router's gate leaves them.
 */
export function isTestSetPath(path: string): boolean {
  return /\/agents\/[^/]+\/test-set(\/|$)/.test(path);
}

/**
 * An agent's test set (`test-case-binding.ts`), one project at a time,
 * under `/v1/agents/:agentId/test-set`:
 *
 * - `GET /` (read on `?projectId=`): how many cases it has;
 * - `GET /cases` (read on `?projectId=`): the cases, newest added first;
 * - `POST /cases`: adds a case by hand, from a correction's body on one of
 *   the agent's runs;
 * - `POST /cases/:caseId/retire`: retires a case, with its `reason`.
 *
 * Adding and retiring are fixing, so they need publish on the agent, and
 * read on the case's project. For an agent more than one project serves,
 * they need write on the case's project instead, as a correction's change
 * does (`item-rights.ts`, rule 3). Without a store, a key or session
 * limited to a project is held to those projects (`heldFixRefusal`).
 */
export function agentTestSetRouter(deps: {
  readonly corrections: CorrectionRegistryBinding;
  readonly runs: RunBinding;
  readonly authorizer?: Authorizer;
  readonly itemRights?: ItemRights;
  /** With no authorizer: which projects serve the agent (`itemServingOf`). */
  readonly itemServing?: ItemServing;
  /** Answers an unknown agent's 404, and resolves its version's tools. */
  readonly agents?: AgentRegistryBinding;
  readonly conversations?: ConversationBinding;
  readonly flows?: FlowRegistryBinding;
  /** Where a freeze publishes the project's versions (`agentTestSetId`): the summary's `frozenVersion`. */
  readonly testSets?: TestSetRegistryBinding;
}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { corrections } = deps;
  // What adding or retiring a case asks (`fixRefusal`). Without a store,
  // the agent's projects: the host's, else its record's.
  const fixDeps = {
    ...deps,
    held: heldProjects(deps.itemServing, 'agent', async (c, id) =>
      deps.agents === undefined
        ? []
        : recordedProjects(
            deps.agents.listVersions({
              tenantId: c.get('tenantId') as TenantId,
              agentId: id as AgentId,
              limit: 1,
              includeTombstoned: true,
            }),
          ),
    ),
  };

  r.get('/:agentId/test-set', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const projectId = projectOf(c);
    if (typeof projectId !== 'string') return projectId;
    const refused =
      (await refusal(
        c,
        deps.authorizer,
        'read',
        ref('project', projectId),
        `project ${projectId}`,
      )) ?? (await unknownAgent(c, deps.agents, agentId));
    if (refused !== undefined) return refused;
    const counts = await corrections.testSet({ tenantId, agentId, projectId });
    const frozen = await deps.testSets?.get({
      tenantId,
      testSetId: agentTestSetId(agentId as AgentId, projectId),
    });
    return c.json({
      agentId,
      projectId,
      cases: { active: counts.active, retired: counts.retired },
      ...(counts.lastAddedAt !== undefined && { lastAddedAt: counts.lastAddedAt }),
      ...(frozen != null && { frozenVersion: { testSetId: frozen.id, version: frozen.version } }),
    });
  });

  r.get('/:agentId/test-set/cases', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const projectId = projectOf(c);
    if (typeof projectId !== 'string') return projectId;
    const include = includeListOf(c.req.queries('include'), ['retired']);
    if (include.kind === 'err') return fail(c, 'bad-input', include.message);
    const kinds = parseKinds(c.req.query('kind'));
    if (typeof kinds === 'string') return fail(c, 'bad-input', kinds);
    const refused =
      (await refusal(
        c,
        deps.authorizer,
        'read',
        ref('project', projectId),
        `project ${projectId}`,
      )) ?? (await unknownAgent(c, deps.agents, agentId));
    if (refused !== undefined) return refused;
    const cursor = c.req.query('cursor');
    const page = await corrections.listCases({
      tenantId,
      agentId,
      projectId,
      ...(kinds !== undefined && { kinds }),
      ...(include.value.has('retired') && { includeRetired: true }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
      limit: clampLimit(c.req.query('limit')),
    });
    return c.json({
      data: page.data,
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.post('/:agentId/test-set/cases', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const parsed = parseCorrectionBody(await c.req.json().catch(() => null));
    if (parsed.kind === 'err') return fail(c, 'bad-input', parsed.message);
    const { correctorGroupId, participantId, ...said } = parsed.body;
    if (correctorGroupId !== undefined || participantId !== undefined) {
      return fail(
        c,
        'bad-input',
        "A hand case has no correctorGroupId or participantId: it isn't a correction, so nothing counts it.",
      );
    }
    const addedBy = madeByOf(c.get('principal'));
    if (addedBy === undefined) {
      return fail(c, 'permission-denied', 'Adding a case needs a user or a service token.');
    }
    const run = await deps.runs.getRun(tenantId, said.runId as RunId);
    // A run in a project the caller can't read is no run, as `GET /v1/runs/{runId}` answers.
    if (run === null || !(await canRead(c, deps.authorizer, run.projectId as unknown as string))) {
      return fail(c, 'run-not-found', `No run "${said.runId}".`);
    }
    const projectId = run.projectId as unknown as ProjectId;
    const refused = await fixRefusal(c, fixDeps, agentId, projectId);
    if (refused !== undefined) return refused;
    const subject = subjectOf(run);
    if (subject.kind !== 'agent' || subject.id !== agentId) {
      return fail(c, 'bad-input', `Run "${said.runId}" isn't a run of agent "${agentId}".`);
    }
    const unfinished = unfinishedRun(run, said.runId);
    if (unfinished !== undefined) return fail(c, unfinished.code, unfinished.message);
    // A comparison's replay is evidence for its comparison, never a case (`isReplayCopy`).
    if (run.replayOf != null) {
      return fail(
        c,
        'bad-input',
        `Run "${said.runId}" is a comparison's replay: it can't be a case.`,
      );
    }
    const missing = missingItem(run.output, said.runId, said.items);
    if (missing !== undefined) return fail(c, missing.code, missing.message);
    const unknownTool = await unknownCorrectionTool(tenantId, subject, said, deps.agents);
    if (unknownTool !== undefined) {
      return fail(c, 'bad-input', `The corrected version has no tool "${unknownTool}".`);
    }
    // The run's copy is stored with its first correction or case.
    const context = (await isFirstCorrection(corrections, tenantId, said.runId))
      ? await captureContext({
          tenantId,
          runId: said.runId,
          subject,
          output: run.output,
          conversationId: run.agent?.conversationId as string | undefined,
          runBinding: deps.runs,
          conversations: deps.conversations,
          flows: deps.flows,
        })
      : undefined;
    const testCase = await corrections.addCase({
      tenantId,
      projectId,
      run: {
        subject,
        input: run.input,
        output: run.output,
        segments: run.segments ?? [],
        ...(context !== undefined && { context }),
      },
      ...said,
      madeBy: addedBy,
    });
    c.status(201);
    return c.json(testCase);
  });

  r.post('/:agentId/test-set/cases/:caseId/retire', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const caseId = c.req.param('caseId');
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const reason = body !== null && typeof body === 'object' ? body.reason : undefined;
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON) {
      return fail(
        c,
        'bad-input',
        `reason is required: why the case no longer applies, at most ${MAX_REASON} characters.`,
      );
    }
    const by = madeByOf(c.get('principal'));
    if (by === undefined) {
      return fail(c, 'permission-denied', 'Retiring a case needs a user or a service token.');
    }
    const notFound = () =>
      fail(c, 'test-case-not-found', `Agent "${agentId}"'s test set has no case "${caseId}".`);
    const found = await corrections.getCase({ tenantId, agentId, caseId });
    // A case in a project the caller can't read is no case, as a correction is.
    if (found === null || !(await canRead(c, deps.authorizer, found.projectId))) return notFound();
    const refused = await fixRefusal(c, fixDeps, agentId, found.projectId);
    if (refused !== undefined) return refused;
    const outcome = await corrections.retireCase({ tenantId, agentId, caseId, reason, by });
    if (outcome.kind === 'not-found') return notFound();
    if (outcome.kind === 'already-retired') {
      return fail(c, 'test-case-retired', `Case "${caseId}" is retired already.`, {
        retired: outcome.testCase.retired,
      });
    }
    return c.json(outcome.testCase);
  });

  return r;
}

// ---------- helpers ----------

function fail(
  c: Ctx,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message, ...details }, c.get('requestId')));
}

/** `?projectId=`, which every read takes: a test set is read one project at a time. */
function projectOf(c: Ctx): ProjectId | Response {
  const projectId = c.req.query('projectId');
  if (projectId === undefined || projectId.length === 0) {
    return fail(c, 'bad-input', 'projectId is required: a test set is read one project at a time.');
  }
  if (!UUID_RE.test(projectId)) {
    return fail(c, 'bad-input', '`projectId` is not a project id (a UUID).');
  }
  return projectId as ProjectId;
}

/** `?kind=correction,hand`: absent is both. */
function parseKinds(raw: string | undefined): readonly TestCaseKind[] | undefined | string {
  if (raw === undefined || raw.length === 0) return undefined;
  const kinds = raw.split(',');
  const bad = kinds.find((k) => !(TEST_CASE_KINDS as readonly string[]).includes(k));
  if (bad !== undefined) return `kind takes ${TEST_CASE_KINDS.join(' and ')}, not "${bad}".`;
  return kinds as TestCaseKind[];
}

async function refusal(
  c: Ctx,
  authorizer: Authorizer | undefined,
  action: Action,
  resource: ResourceRef,
  what: string,
): Promise<Response | undefined> {
  if (authorizer === undefined) return undefined;
  const decision = await authorizer.check(c, action, resource);
  if (decision.allowed) return undefined;
  return fail(
    c,
    'permission-denied',
    `Permission denied: this needs ${action} on ${what} (${decision.reason})`,
  );
}

async function unknownAgent(
  c: Ctx,
  agents: AgentRegistryBinding | undefined,
  agentId: string,
): Promise<Response | undefined> {
  if (agents === undefined) return undefined;
  const tenantId = c.get('tenantId') as TenantId;
  if (await agents.headExists({ tenantId, agentId: agentId as AgentId })) return undefined;
  return fail(c, 'agent-not-found', `No agent "${agentId}".`);
}

/** The caller may read the project (anyone may, without an authorizer). */
async function canRead(
  c: Ctx,
  authorizer: Authorizer | undefined,
  projectId: string,
): Promise<boolean> {
  return authorizer === undefined || (await authorizer.can(c, 'read', ref('project', projectId)));
}

/**
 * Adding or retiring a case, once the caller can read its project (a run
 * or case it can't read is a 404): publish on the agent; for an agent more
 * than one project serves, write on the case's project.
 */
async function fixRefusal(
  c: Ctx,
  deps: {
    readonly authorizer?: Authorizer;
    readonly itemRights?: ItemRights;
    readonly held: HeldProjects;
  },
  agentId: string,
  projectId: ProjectId,
): Promise<Response | undefined> {
  if (deps.authorizer === undefined) return heldFixRefusal(c, deps.held, agentId, projectId);
  const projects = await deps.itemRights?.multi(c, 'agent', agentId);
  if (deps.itemRights !== undefined && projects !== undefined) {
    const refused = await deps.itemRights.on(c, projectId, 'write');
    if (refused === undefined) return undefined;
    return forbidden(
      c,
      refused,
      `Permission denied: this needs write on project ${projectId}, where the case is (${refused.decision.reason})`,
    );
  }
  return await refusal(c, deps.authorizer, 'publish', ref('agent', agentId), `agent "${agentId}"`);
}

/**
 * `fixRefusal` without a store, for a key or session limited to a
 * project: refused where a store would refuse it for that limit alone
 * (`limitedCallerRefusal`). For an agent more than one project serves,
 * that's the case's project; else the agent's own. An agent that records
 * no project passes, and so does one that isn't there (its 404).
 */
async function heldFixRefusal(
  c: Ctx,
  held: HeldProjects,
  agentId: string,
  projectId: ProjectId,
): Promise<Response | undefined> {
  if (c.get('tokenProjectId') === undefined) return undefined;
  const projects = await held.projects(c, agentId);
  const own = projects?.[0];
  if (projects === undefined || own === undefined) return undefined;
  return projects.length > 1
    ? limitedCallerRefusal(c, 'write', ref('project', projectId as unknown as string), 'the case')
    : limitedCallerRefusal(c, 'publish', ref('project', own as unknown as string), 'the agent');
}
