// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AgentId } from '@kindgi/agents';
import { type Action, ref } from '@kindgi/authz';
import type { Cursor, FlowId, ProjectId, RunId, Semver, TenantId, Timestamp } from '@kindgi/types';

import { VERSIONS_NEED_A_FLOW } from '../corrected-dispatcher.js';
import type { CorrectionRegistryBinding } from '../correction-binding.js';
import { statusFor, toWireError } from '../errors.js';
import { type ItemRights, filterOwned, ownProject, runIn } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type ReferenceScopeBinding,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import {
  type AgentRef,
  type FlowRef,
  TEST_RUN_STATUSES,
  type TestRun,
  type TestRunBinding,
  type TestRunComparison,
  type TestRunFilter,
  type TestRunStartOutcome,
  type TestRunStatus,
} from '../test-run-binding.js';
import { RESERVED_CORRELATION_PREFIXES, isReservedCorrelation } from '../test-run-outcome.js';
import { rescoreRefusal, rescoreStart } from '../test-run-rescore.js';
import {
  type TestSetFreezeBinding,
  agentTestSetId,
  isAgentTestSetId,
  nothingToCheck,
  projectHasCases,
} from '../test-set-binding.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';
import { formatSseFrame, pause, readingOf } from './sse.js';
import { parseComparison } from './test-run-comparison.js';
import { type SettingsOverridesCheck, checkSettingsOverrides } from './test-run-overrides.js';
import {
  type FlowVersionsCheck,
  checkFlowVersions,
  versionsReferences,
} from './test-run-versions.js';
import { parseTimeInput } from './time-input.js';

/**
 * Test-run resource routes — data-plane surface for the evaluation
 * harness. Follows `/v1/runs/*` structurally: `start` +
 * `get` + `list` + `cancel` + `events` (SSE). The registry surface
 * (`/v1/test-sets/*`) resolves test set definitions; this
 * router dispatches runs against them.
 *
 * The `start` route is anchored at `/v1/test-sets/:testSetId/runs`
 * because the test set is the durable definition and the caller supplies
 * an agent/flow to *evaluate against* — not a run body. Read routes
 * live under a sibling `/v1/test-runs/*` for uniform pagination /
 * filter shape across the resource.
 *
 * SSE is a lightweight projection over the binding's `get` — per-case
 * progress events + a terminal event carrying the aggregate result.
 * The binding chooses its underlying substrate (the in-process
 * reference keeps runs in memory; a durable binding can back them with
 * runs and their journal); this route only sees the surface.
 *
 * With an authorizer (T243 A): starting a run needs `write` on the
 * project it lands in and `execute` on what it evaluates (the agent or
 * flow), on top of the test-sets router's own check on the test set. A
 * test run is read through its test set: `read` on the test set to list, get or
 * follow it, `write` to cancel it. A run that isn't there is still the
 * handler's 404.
 */
export interface TestRunsRouters {
  readonly start: Hono<AppEnv>;
  readonly readback: Hono<AppEnv>;
}

/**
 * `versionsCheck`: where a flow candidate's `versions` are checked
 * against the flow version at start (without it, they're applied as
 * given).
 */
export function testRunsRouters(
  binding: TestRunBinding,
  versionsCheck?: FlowVersionsCheck,
  overridesCheck?: SettingsOverridesCheck,
  authorizer?: Authorizer,
  /** What a test run's project may run (`reference-scope.ts`); absent → as named. */
  referenceScope?: ReferenceScopeBinding,
  /** Whether a project is suspended: no test run starts in one. Absent: no check. */
  projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>,
  /**
   * Rights on a test set, agent or flow more than one project serves
   * (`item-rights.ts`): running one in one of its projects is that
   * project's `execute` (`call` for an agent), and a run of such a test set
   * is read, cancelled and rescored on its own project. Absent: every item
   * has one project.
   */
  itemRights?: ItemRights,
  /**
   * Freezes an agent's own test set (`agent.<agentId>.<projectId>`) for a
   * run of it. Absent: such a run answers 501, as a suggested change's check does.
   */
  testSetFreeze?: TestSetFreezeBinding,
  /**
   * The corrections, read for whether the project has a case before its
   * test set is frozen. Absent: the freeze alone says.
   */
  corrections?: Pick<CorrectionRegistryBinding, 'listCases'>,
): TestRunsRouters {
  return {
    start: startRouter(
      binding,
      versionsCheck,
      overridesCheck,
      authorizer,
      referenceScope,
      projectSuspended,
      itemRights,
      testSetFreeze,
      corrections,
    ),
    readback: readbackRouter(binding, authorizer, itemRights),
  };
}

// ---------- POST /v1/test-sets/:testSetId/runs ----------

/** The `validation-failed` error for a flow candidate's `versions` that don't fit the flow; `undefined` when they do. */
async function versionsRefusal(
  check: FlowVersionsCheck | undefined,
  tenantId: TenantId,
  start: ParsedStartBody,
) {
  const versions = start.comparison?.versions;
  const flowRef = start.flowRef;
  if (check === undefined || versions === undefined || flowRef?.version === undefined) {
    return undefined;
  }
  const issues = await checkFlowVersions(
    check,
    tenantId,
    { flowId: flowRef.flowId as unknown as string, version: flowRef.version },
    versions,
  );
  if (issues.length === 0) return undefined;
  return {
    code: 'validation-failed' as const,
    message: `The versions don't fit flow ${flowRef.flowId as unknown as string} ${flowRef.version} (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    issues: issues as unknown as Record<string, unknown>[],
  };
}

/** The `validation-failed` error for an agent candidate's settings `overrides` that don't fit it; `undefined` when they do. */
async function overridesRefusal(
  check: SettingsOverridesCheck | undefined,
  tenantId: TenantId,
  start: ParsedStartBody,
) {
  const overrides = start.comparison?.overrides;
  const agentRef = start.agentRef;
  if (overrides === undefined || agentRef?.version === undefined) return undefined;
  if (check === undefined) {
    return {
      code: 'validation-failed' as const,
      message: "This runtime can't check overrides (it serves no agent or block registry).",
      issues: [],
    };
  }
  const issues = await checkSettingsOverrides(
    check,
    tenantId,
    { agentId: agentRef.agentId as unknown as string, version: agentRef.version },
    overrides,
  );
  if (issues.length === 0) return undefined;
  return {
    code: 'validation-failed' as const,
    message: `The overrides don't fit ${agentRef.agentId as unknown as string} ${agentRef.version} (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    issues: issues as unknown as Record<string, unknown>[],
  };
}

/**
 * Why a run can't take an agent's own test set (`agent.<agentId>.<projectId>`):
 * it's frozen for each run of it, so it runs only its agent, in its
 * project. `undefined` when the run is its agent's in its project, and for
 * any other test set.
 */
function ownSetMismatch(
  testSetId: string,
  agentRef: AgentRef | undefined,
  projectId: ProjectId,
): string | undefined {
  if (!isAgentTestSetId(testSetId)) return undefined;
  if (agentRef === undefined) {
    return `"${testSetId}" is an agent's own test set: run it with \`agentRef\`, for its agent in its project`;
  }
  const ownId = agentTestSetId(agentRef.agentId, projectId);
  return testSetId === ownId
    ? undefined
    : `"${testSetId}" is an agent's own test set, and this run's agent and project have "${ownId}"`;
}

/**
 * An agent's own test set as it is now, for a run of it (`ownSetMismatch`
 * passed): frozen first, as a suggested change's check freezes it, so the
 * run records that version as its `testSetVersion`. Refused with 501 when
 * nothing freezes it, and with the check's 409 when it has no cases, read
 * from the corrections before the freeze when there are corrections.
 * `undefined` for any other test set, which runs its latest version.
 */
async function frozenFor(
  testSetFreeze: TestSetFreezeBinding | undefined,
  corrections: Pick<CorrectionRegistryBinding, 'listCases'> | undefined,
  tenantId: TenantId,
  testSetId: string,
  agentRef: AgentRef | undefined,
  projectId: ProjectId,
): Promise<
  | { readonly kind: 'frozen'; readonly version: string }
  | {
      readonly kind: 'refused';
      readonly error: { readonly code: string; readonly message: string };
    }
  | undefined
> {
  if (!isAgentTestSetId(testSetId) || agentRef === undefined) return undefined;
  const { agentId } = agentRef;
  if (testSetFreeze === undefined) {
    return {
      kind: 'refused',
      error: {
        code: 'suggested-change-check-unsupported',
        message:
          "This runtime can't run an agent's test set: it doesn't freeze a project's test set",
      },
    };
  }
  if (
    corrections !== undefined &&
    !(await projectHasCases(corrections, { tenantId, agentId, projectId }))
  ) {
    return { kind: 'refused', error: nothingToCheck(agentId, projectId) };
  }
  const frozen = await testSetFreeze.freezeTestSet({ tenantId, agentId, projectId });
  return frozen.cases.length === 0
    ? { kind: 'refused', error: nothingToCheck(agentId, projectId) }
    : { kind: 'frozen', version: frozen.testSetVersion };
}

function startRouter(
  binding: TestRunBinding,
  versionsCheck?: FlowVersionsCheck,
  overridesCheck?: SettingsOverridesCheck,
  authorizer?: Authorizer,
  referenceScope?: ReferenceScopeBinding,
  projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>,
  itemRights?: ItemRights,
  testSetFreeze?: TestSetFreezeBinding,
  corrections?: Pick<CorrectionRegistryBinding, 'listCases'>,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /**
   * Running `item` for a run filed in `projectId`: for an item more than
   * one project serves, with `projectId` among them, that project's right
   * (`runIn`); else `execute` on the item.
   */
  async function runRefusal(
    c: Context<AppEnv>,
    item: { readonly kind: 'agent' | 'flow' | 'test_set'; readonly id: string },
    projectId: string,
  ): Promise<Response | undefined> {
    const served =
      authorizer === undefined ? undefined : await itemRights?.multi(c, item.kind, item.id);
    return itemRights !== undefined && served?.includes(projectId as ProjectId) === true
      ? runIn(c, itemRights, item, projectId)
      : deniedBy(authorizer, c, 'execute', ref(item.kind, item.id));
  }

  r.post('/:testSetId/runs', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testSetId = c.req.param('testSetId');

    let body: unknown = {};
    const hasBody =
      (c.req.header('content-type') ?? '').includes('json') ||
      (c.req.header('content-length') !== undefined && c.req.header('content-length') !== '0');
    if (hasBody) {
      try {
        const text = await c.req.text();
        body = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
        );
      }
    }
    const parsed = parseStartBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor(parsed.error.code) as never);
      return c.json(toWireError(parsed.error, requestId));
    }
    const { projectId, agentRef, flowRef } = parsed.value;
    const own = isAgentTestSetId(testSetId);
    const notOwn = ownSetMismatch(testSetId, agentRef, projectId);
    if (notOwn !== undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: notOwn }, requestId));
    }
    const target =
      agentRef !== undefined
        ? { kind: 'agent' as const, id: agentRef.agentId as unknown as string }
        : { kind: 'flow' as const, id: flowRef?.flowId as unknown as string };
    // Running the test set takes `execute` on it (an editor of its project, or
    // an executor), whichever project the run lands in; its results land
    // in that project, which takes `write`. A test set or target more than one
    // project serves, run in one of them: that project's right instead. An
    // agent's own test set is its project's, and has no object until its first
    // freeze: `write` there and running the agent cover it.
    const refused =
      (own
        ? undefined
        : await runRefusal(
            c,
            { kind: 'test_set', id: testSetId },
            projectId as unknown as string,
          )) ??
      (await deniedBy(authorizer, c, 'write', ref('project', projectId as unknown as string))) ??
      (await runRefusal(c, target, projectId as unknown as string));
    if (refused !== undefined) return refused;
    // The test set and what it runs must be the run's project's to reach
    // (`reference-scope.ts`): at the version named, when one is, since each
    // case replays that version in the run's project. That holds for a flow
    // candidate's `versions` too, each at its own path.
    const outOfScope = await referencesOutOfScope(referenceScope, tenantId, projectId, [
      ...(own ? [] : [{ path: '/testSetId', kind: 'test-set' as const, id: testSetId }]),
      agentRef !== undefined
        ? {
            path: '/agentRef/agentId',
            kind: 'agent',
            id: agentRef.agentId as unknown as string,
            ...(agentRef.version !== undefined && { version: agentRef.version }),
          }
        : {
            path: '/flowRef/flowId',
            kind: 'flow',
            id: flowRef?.flowId as unknown as string,
            ...(flowRef?.version !== undefined && { version: flowRef.version }),
          },
      ...versionsReferences(parsed.value.comparison?.versions),
    ]);
    if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    if (projectSuspended !== undefined && (await projectSuspended(tenantId, projectId))) {
      c.status(statusFor('project-suspended') as never);
      return c.json(
        toWireError(
          {
            code: 'project-suspended',
            message:
              "The project is suspended, so nothing new runs in it until it's restored; the test run wasn't started",
          },
          requestId,
        ),
      );
    }
    const refusal =
      (await versionsRefusal(versionsCheck, tenantId, parsed.value)) ??
      (await overridesRefusal(overridesCheck, tenantId, parsed.value));
    if (refusal !== undefined) {
      c.status(statusFor(refusal.code) as never);
      return c.json(toWireError(refusal, requestId));
    }

    const frozen = await frozenFor(
      testSetFreeze,
      corrections,
      tenantId,
      testSetId,
      agentRef,
      projectId,
    );
    if (frozen?.kind === 'refused') {
      c.status(statusFor(frozen.error.code) as never);
      return c.json(toWireError(frozen.error, requestId));
    }

    const outcome = await binding.start({
      tenantId,
      projectId: parsed.value.projectId,
      testSetId,
      ...(frozen?.kind === 'frozen' && { testSetVersion: frozen.version }),
      ...(parsed.value.agentRef !== undefined && { agentRef: parsed.value.agentRef }),
      ...(parsed.value.flowRef !== undefined && { flowRef: parsed.value.flowRef }),
      ...(parsed.value.dryRun !== undefined && { dryRun: parsed.value.dryRun }),
      ...(parsed.value.correlationId !== undefined && {
        correlationId: parsed.value.correlationId,
      }),
      ...(parsed.value.comparison !== undefined && { comparison: parsed.value.comparison }),
    });
    return startAnswer(c, requestId, outcome);
  });

  return r;
}

/** A started test run's answer: 201 with its id, or why it didn't start. */
function startAnswer(
  c: Context<AppEnv>,
  requestId: string,
  outcome: TestRunStartOutcome,
): Response {
  if (outcome.kind === 'test-set-not-found') {
    c.status(statusFor('test-set-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'test-set-not-found',
          message: `No test set registered with id "${outcome.testSetId}"`,
          testSetId: outcome.testSetId,
        },
        requestId,
      ),
    );
  }
  if (outcome.kind === 'dispatcher-not-registered') {
    c.status(statusFor('dispatcher-not-registered') as never);
    return c.json(
      toWireError(
        {
          code: 'dispatcher-not-registered',
          message: `No test-run dispatcher registered for kind "${outcome.evalKind}". This kind is registry-only today.`,
          evalKind: outcome.evalKind,
        },
        requestId,
      ),
    );
  }
  if (outcome.kind === 'dispatcher-input-invalid') {
    c.status(statusFor('dispatcher-input-invalid') as never);
    return c.json(
      toWireError(
        {
          code: 'dispatcher-input-invalid',
          message: outcome.message,
        },
        requestId,
      ),
    );
  }
  if (outcome.kind === 'project-not-found') {
    // Caller supplied a `projectId` that does not resolve within
    // this tenant. Distinct signal from `dispatcher-input-invalid`
    // so the client can prompt for a valid project rather than
    // assume a dispatcher wiring problem. Answered as `400 bad-input`,
    // like the test-sets route; the caller learns from the message
    // which field was invalid.
    c.status(statusFor('bad-input') as never);
    return c.json(
      toWireError(
        {
          code: 'bad-input',
          message: `\`projectId\` "${outcome.projectId as unknown as string}" does not resolve to a project in this workspace`,
        },
        requestId,
      ),
    );
  }

  c.status(201);
  return c.json({
    testRunId: outcome.testRunId as unknown as string,
    ...(outcome.dryRunPreview !== undefined && { dryRunPreview: outcome.dryRunPreview }),
  });
}

// ---------- /v1/test-runs/* (readback + cancel + SSE) ----------

function readbackRouter(
  binding: TestRunBinding,
  authorizer?: Authorizer,
  itemRights?: ItemRights,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  /**
   * The refusal, if any, of `action` on the test set of the run named in the
   * path. A run of a test set more than one project serves is its own
   * project's: `read` on it, or to change it, `execute` (`onProject`).
   */
  const onRunTestSet = async (
    c: Context<AppEnv>,
    action: Action,
    onProject: Action = action,
  ): Promise<Response | undefined> => {
    if (authorizer === undefined) return undefined;
    const tenantId = c.get('tenantId') as TenantId;
    const run = await binding.get({ tenantId, testRunId: c.req.param('testRunId') as RunId });
    if (run === null) return undefined;
    const own = await ownProject(
      c,
      itemRights,
      'test_set',
      run.testSetId,
      run.projectId as unknown as string | undefined,
    );
    return own === undefined
      ? deniedBy(authorizer, c, action, ref('test_set', run.testSetId))
      : deniedBy(authorizer, c, onProject, ref('project', own));
  };

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const statusRaw = c.req.query('status');
    if (statusRaw !== undefined && statusRaw.length > 0 && !isTestRunStatus(statusRaw)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Unknown status "${statusRaw}". Expected one of: ${TEST_RUN_STATUSES.join(', ')}.`,
          },
          requestId,
        ),
      );
    }
    const filter: TestRunFilter = {};
    const testSetIdRaw = c.req.query('testSetId');
    if (testSetIdRaw !== undefined && testSetIdRaw.length > 0) {
      (filter as { testSetId?: string }).testSetId = testSetIdRaw;
    }
    if (statusRaw !== undefined && statusRaw.length > 0) {
      (filter as { status?: TestRunStatus }).status = statusRaw as TestRunStatus;
    }
    const agentIdRaw = c.req.query('agentId');
    if (agentIdRaw !== undefined && agentIdRaw.length > 0) {
      (filter as { agentId?: AgentId }).agentId = agentIdRaw as AgentId;
    }
    const flowIdRaw = c.req.query('flowId');
    if (flowIdRaw !== undefined && flowIdRaw.length > 0) {
      (filter as { flowId?: FlowId }).flowId = flowIdRaw as FlowId;
    }
    for (const bound of ['from', 'to'] as const) {
      const raw = c.req.query(bound);
      if (raw === undefined || raw.length === 0) continue;
      const at = parseTimeInput(raw);
      if (at === null) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: `\`${bound}\` must be an ISO 8601 time` },
            requestId,
          ),
        );
      }
      (filter as { from?: Timestamp; to?: Timestamp })[bound] = at.toISOString() as Timestamp;
    }

    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(Object.keys(filter).length > 0 && { filter }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : await filterOwned(c, authorizer, itemRights, 'test_set', page.data, {
            idOf: (run) => run.testSetId,
            projectOf: (run) => run.projectId as unknown as string | undefined,
            todayRef: (run) => ref('test_set', run.testSetId),
          });
    return c.json({
      data: visible.map(serializeTestRun),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:testRunId ----------
  r.get('/:testRunId', async (c) => {
    const refused = await onRunTestSet(c, 'read');
    if (refused !== undefined) return refused;
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testRunId = c.req.param('testRunId') as RunId;

    const run = await binding.get({ tenantId, testRunId });
    if (run === null) {
      c.status(statusFor('test-run-not-found') as never);
      return c.json(
        toWireError(
          { code: 'test-run-not-found', message: `No test run with id ${testRunId}`, testRunId },
          requestId,
        ),
      );
    }
    return c.json(serializeTestRun(run));
  });

  // ---------- POST /:testRunId/rescore ----------
  // A new comparison test run of the same test set version, candidate and
  // settings that replays nothing: it scores the run's replays again, with
  // what people corrected on them since. The run rescored stays as it was.
  r.post('/:testRunId/rescore', async (c) => {
    const refused = await onRunTestSet(c, 'admin', 'execute');
    if (refused !== undefined) return refused;
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testRunId = c.req.param('testRunId') as RunId;
    const run = await binding.get({ tenantId, testRunId });
    if (run === null) {
      c.status(statusFor('test-run-not-found') as never);
      return c.json(
        toWireError(
          { code: 'test-run-not-found', message: `No test run with id ${testRunId}`, testRunId },
          requestId,
        ),
      );
    }
    const notRescorable = rescoreRefusal(run);
    if (notRescorable !== undefined) {
      c.status(statusFor('test-run-not-rescorable') as never);
      return c.json(
        toWireError(
          { code: 'test-run-not-rescorable', message: notRescorable, testRunId },
          requestId,
        ),
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: unknown } | null;
    const projectId =
      run.projectId ??
      (typeof body?.projectId === 'string' && body.projectId.length > 0
        ? (body.projectId as ProjectId)
        : undefined);
    if (projectId === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message:
              "`projectId` is required: this runtime doesn't record the project the run belongs to.",
          },
          requestId,
        ),
      );
    }
    const denied = await deniedBy(authorizer, c, 'write', ref('project', projectId as string));
    if (denied !== undefined) return denied;
    return startAnswer(c, requestId, await binding.start(rescoreStart(run, projectId)));
  });

  // ---------- POST /:testRunId/cancel ----------
  r.post('/:testRunId/cancel', async (c) => {
    const refused = await onRunTestSet(c, 'write', 'execute');
    if (refused !== undefined) return refused;
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testRunId = c.req.param('testRunId') as RunId;

    const outcome = await binding.cancel({ tenantId, testRunId });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('test-run-not-found') as never);
      return c.json(
        toWireError(
          { code: 'test-run-not-found', message: `No test run with id ${testRunId}`, testRunId },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'already-terminal') {
      c.status(statusFor('test-run-already-terminal') as never);
      return c.json(
        toWireError(
          {
            code: 'test-run-already-terminal',
            message: `Cannot cancel test run ${testRunId}: already ${outcome.status}`,
            testRunId,
            status: outcome.status,
          },
          requestId,
        ),
      );
    }

    // Re-read to return the freshest wire shape.
    const reloaded = await binding.get({ tenantId, testRunId });
    if (reloaded === null) {
      // Very unlikely: cancel succeeded but the row vanished. Return
      // a minimal wire shape rather than 500 — the caller has the
      // testRunId and status intent already.
      return c.json({ testRunId: testRunId as unknown as string, cancelled: true });
    }
    return c.json(serializeTestRun(reloaded));
  });

  // ---------- GET /:testRunId/events (SSE) ----------
  r.get('/:testRunId/events', async (c) => {
    const refused = await onRunTestSet(c, 'read');
    if (refused !== undefined) return refused;
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const testRunId = c.req.param('testRunId') as RunId;

    const initial = await binding.get({ tenantId, testRunId });
    if (initial === null) {
      c.status(statusFor('test-run-not-found') as never);
      return c.json(
        toWireError(
          { code: 'test-run-not-found', message: `No test run with id ${testRunId}`, testRunId },
          requestId,
        ),
      );
    }

    const headers = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Request-Id': requestId,
    };
    // Nobody will read this stream when the request is a HEAD (Hono answers a
    // HEAD with this GET route and drops the body unread, and nothing cancels
    // it) or when the client left during the read above (its request aborts,
    // but the server cancels only a body it's writing). Then the route
    // answers the stream's status and headers, before the stream exists, and
    // starts none of its work.
    if (c.req.method === 'HEAD' || c.req.raw.signal.aborted) {
      return new Response(null, { status: 200, headers });
    }

    const encoder = new TextEncoder();
    const POLL_MS = 100;
    const MAX_WAIT_MS = 5 * 60_000;
    // Aborted when the client goes away: the reader cancels the stream, or
    // the request aborts. The poll below ends on it at once.
    const reading = readingOf(c.req.raw);

    // Track which per-case events we've already emitted (index within
    // result.perCase). Kept intentionally small — only the accuracy
    // kind's per-case shape is streamed; other kinds would need their
    // own projection.
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        reading.abort();
      },
      async start(controller) {
        const startedAt = Date.now();
        let lastEmittedCaseIndex = -1;
        let terminalEmitted = false;
        const emit = async (): Promise<{ terminal: boolean }> => {
          const snapshot = await binding.get({ tenantId, testRunId });
          if (snapshot === null) {
            controller.enqueue(
              encoder.encode(
                formatSseFrame({
                  id: `${testRunId}:error`,
                  event: 'error',
                  data: {
                    code: 'test-run-not-found',
                    message: `test run ${testRunId} disappeared`,
                    requestId,
                  },
                }),
              ),
            );
            return { terminal: true };
          }
          const perCase = readPerCase(snapshot.result);
          for (let i = lastEmittedCaseIndex + 1; i < perCase.length; i++) {
            const entry = perCase[i];
            if (entry === undefined) continue;
            controller.enqueue(
              encoder.encode(
                formatSseFrame({
                  id: `${testRunId}:case:${i}`,
                  event: entry.pass === false ? 'test-run.case-failed' : 'test-run.case-completed',
                  data: { testRunId, caseIndex: i, ...entry },
                }),
              ),
            );
            lastEmittedCaseIndex = i;
          }
          if (isTerminalTestRun(snapshot.status) && !terminalEmitted) {
            terminalEmitted = true;
            const wireKind =
              snapshot.status === 'completed'
                ? 'test-run.completed'
                : snapshot.status === 'failed'
                  ? 'test-run.failed'
                  : 'test-run.cancelled';
            controller.enqueue(
              encoder.encode(
                formatSseFrame({
                  id: `${testRunId}:terminal`,
                  event: wireKind,
                  data: {
                    testRunId,
                    status: snapshot.status,
                    ...(snapshot.result !== undefined && { result: snapshot.result }),
                    ...(snapshot.error !== undefined && { error: snapshot.error }),
                  },
                }),
              ),
            );
            return { terminal: true };
          }
          return { terminal: false };
        };

        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        try {
          const first = await emit();
          if (first.terminal) {
            close();
            return;
          }
          while (Date.now() - startedAt < MAX_WAIT_MS) {
            await pause(POLL_MS, reading.signal);
            if (reading.signal.aborted) break;
            const step = await emit();
            if (step.terminal) break;
          }
        } finally {
          close();
        }
      },
    });

    return new Response(body, { status: 200, headers });
  });

  return r;
}

// ---------- helpers ----------

function serializeTestRun(run: TestRun): Record<string, unknown> {
  return {
    testRunId: run.testRunId as unknown as string,
    tenantId: run.tenantId as unknown as string,
    ...(run.projectId !== undefined && { projectId: run.projectId as unknown as string }),
    testSetId: run.testSetId,
    testSetVersion: run.testSetVersion,
    kind: run.kind,
    ...(run.agentRef !== undefined && {
      agentRef: {
        agentId: run.agentRef.agentId as unknown as string,
        ...(run.agentRef.version !== undefined && { version: run.agentRef.version }),
      },
    }),
    ...(run.flowRef !== undefined && {
      flowRef: {
        flowId: run.flowRef.flowId as unknown as string,
        ...(run.flowRef.version !== undefined && { version: run.flowRef.version }),
      },
    }),
    status: run.status,
    dryRun: run.dryRun,
    startedAt: run.startedAt,
    ...(run.completedAt !== undefined && { completedAt: run.completedAt }),
    ...(run.result !== undefined && { result: run.result }),
    ...(run.error !== undefined && { error: run.error }),
    ...(run.status === 'cancelled' &&
      run.cancelReason !== undefined && { cancelReason: run.cancelReason }),
    ...(run.correlationId !== undefined && { correlationId: run.correlationId }),
    ...(run.comparison !== undefined && { comparison: run.comparison }),
  };
}

function isTestRunStatus(value: string): value is TestRunStatus {
  return (TEST_RUN_STATUSES as readonly string[]).includes(value);
}

function isTerminalTestRun(status: TestRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

interface PerCaseEntry {
  readonly pass?: boolean;
  readonly score?: number;
  readonly judgeMetadata?: unknown;
}

function readPerCase(
  result: Readonly<Record<string, unknown>> | undefined,
): readonly PerCaseEntry[] {
  if (result === undefined) return [];
  const perCase = result.perCase;
  if (!Array.isArray(perCase)) return [];
  return perCase as readonly PerCaseEntry[];
}

interface ParsedStartBody {
  readonly projectId: ProjectId;
  readonly agentRef?: AgentRef;
  readonly flowRef?: FlowRef;
  readonly dryRun?: boolean;
  readonly correlationId?: string;
  readonly comparison?: TestRunComparison;
}

/**
 * Why a start's `correlationId` is refused, when it is: not a non-empty
 * string, or one of the prefixes of the runs Kindgi starts itself.
 */
function correlationIdRefusal(correlationId: unknown): string | undefined {
  if (correlationId === undefined) return undefined;
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    return '`correlationId` must be a non-empty string when supplied';
  }
  if (isReservedCorrelation(correlationId)) {
    const prefixes = RESERVED_CORRELATION_PREFIXES.map((p) => `\`${p}\``).join(' or ');
    return `\`correlationId\` may not start with ${prefixes}: those are the test runs Kindgi starts itself, for a pin change or Latest moving`;
  }
  return undefined;
}

function parseStartBody(
  body: unknown,
):
  | { kind: 'ok'; value: ParsedStartBody }
  | { kind: 'err'; error: { code: string; message: string } } {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const b = body as Record<string, unknown>;

  // `projectId` is REQUIRED on the POST body.
  // Missing / empty / non-string → 400 bad-input. Content-scoped
  // rows anchor to a project; the caller resolves it before dispatch.
  const projectIdRaw = b.projectId;
  if (typeof projectIdRaw !== 'string' || projectIdRaw.length === 0) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`projectId` is required' },
    };
  }
  const projectId = projectIdRaw as ProjectId;

  const hasAgent = b.agentRef !== undefined && b.agentRef !== null;
  const hasGraph = b.flowRef !== undefined && b.flowRef !== null;
  if (hasAgent && hasGraph) {
    return {
      kind: 'err',
      error: {
        code: 'bad-input',
        message: 'Provide exactly one of `agentRef` or `flowRef`, not both',
      },
    };
  }
  if (!hasAgent && !hasGraph) {
    return {
      kind: 'err',
      error: {
        code: 'bad-input',
        message: 'Request body must include exactly one of `agentRef` or `flowRef`',
      },
    };
  }

  let agentRef: AgentRef | undefined;
  if (hasAgent) {
    const ar = b.agentRef as Record<string, unknown>;
    if (typeof ar !== 'object' || ar === null) {
      return {
        kind: 'err',
        error: { code: 'bad-input', message: '`agentRef` must be an object' },
      };
    }
    if (typeof ar.agentId !== 'string' || ar.agentId.length === 0) {
      return {
        kind: 'err',
        error: {
          code: 'bad-input',
          message: '`agentRef.agentId` must be a non-empty string',
        },
      };
    }
    if (ar.version !== undefined && typeof ar.version !== 'string') {
      return {
        kind: 'err',
        error: {
          code: 'bad-input',
          message: '`agentRef.version` must be a string when supplied',
        },
      };
    }
    agentRef = {
      agentId: ar.agentId as AgentId,
      ...(typeof ar.version === 'string' && { version: ar.version as Semver }),
    };
  }

  let flowRef: FlowRef | undefined;
  if (hasGraph) {
    const gr = b.flowRef as Record<string, unknown>;
    if (typeof gr !== 'object' || gr === null) {
      return {
        kind: 'err',
        error: { code: 'bad-input', message: '`flowRef` must be an object' },
      };
    }
    if (typeof gr.flowId !== 'string' || gr.flowId.length === 0) {
      return {
        kind: 'err',
        error: {
          code: 'bad-input',
          message: '`flowRef.flowId` must be a non-empty string',
        },
      };
    }
    if (gr.version !== undefined && typeof gr.version !== 'string') {
      return {
        kind: 'err',
        error: {
          code: 'bad-input',
          message: '`flowRef.version` must be a string when supplied',
        },
      };
    }
    flowRef = {
      flowId: gr.flowId as FlowId,
      ...(typeof gr.version === 'string' && { version: gr.version as Semver }),
    };
  }

  const dryRun = b.dryRun;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`dryRun` must be a boolean when supplied' },
    };
  }
  const correlationId = b.correlationId;
  const correlationRefused = correlationIdRefusal(correlationId);
  if (correlationRefused !== undefined) {
    return { kind: 'err', error: { code: 'bad-input', message: correlationRefused } };
  }

  const comparison = parseComparison(b);
  if (comparison.kind === 'err') {
    return { kind: 'err', error: { code: 'bad-input', message: comparison.message } };
  }
  if (comparison.value?.versions !== undefined && agentRef !== undefined) {
    return { kind: 'err', error: { code: 'bad-input', message: VERSIONS_NEED_A_FLOW } };
  }

  return {
    kind: 'ok',
    value: {
      projectId,
      ...(agentRef !== undefined && { agentRef }),
      ...(flowRef !== undefined && { flowRef }),
      ...(dryRun !== undefined && { dryRun }),
      ...(correlationId !== undefined && { correlationId: correlationId as string }),
      ...(comparison.value !== undefined && { comparison: comparison.value }),
    },
  };
}
