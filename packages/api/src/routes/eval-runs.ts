// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AgentId } from '@kindgi/agents';
import { type Action, ref } from '@kindgi/authz';
import type { Cursor, FlowId, ProjectId, RunId, Semver, TenantId, Timestamp } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import {
  type AgentRef,
  EVAL_RUN_STATUSES,
  type EvalComparison,
  type EvalRun,
  type EvalRunBinding,
  type EvalRunFilter,
  type EvalRunStatus,
  type FlowRef,
} from '../eval-run-binding.js';
import { VERSIONS_NEED_A_FLOW } from '../judged-dispatcher.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';
import { parseComparison } from './eval-comparison.js';
import { type SettingsOverridesCheck, checkSettingsOverrides } from './eval-overrides.js';
import { type FlowVersionsCheck, checkFlowVersions } from './eval-versions.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';
import { formatSseFrame } from './sse.js';

/**
 * Eval-run resource routes — data-plane surface for the evaluation
 * harness. Follows `/v1/runs/*` structurally: `start` +
 * `get` + `list` + `cancel` + `events` (SSE). The registry surface
 * (`/v1/eval-suites/*`) resolves suite definitions; this
 * router dispatches runs against them.
 *
 * The `start` route is anchored at `/v1/eval-suites/:suiteId/runs`
 * because the suite is the durable definition and the caller supplies
 * an agent/flow to *evaluate against* — not a run body. Read routes
 * live under a sibling `/v1/eval-runs/*` for uniform pagination /
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
 * flow), on top of the eval-suites router's own check on the suite. An
 * eval run is read through its suite: `read` on the suite to list, get or
 * follow it, `write` to cancel it. A run that isn't there is still the
 * handler's 404.
 */
export interface EvalRunsRouters {
  readonly start: Hono<AppEnv>;
  readonly readback: Hono<AppEnv>;
}

/**
 * `versionsCheck`: where a flow candidate's `versions` are checked
 * against the flow version at start (without it, they're applied as
 * given).
 */
export function evalRunsRouters(
  binding: EvalRunBinding,
  versionsCheck?: FlowVersionsCheck,
  overridesCheck?: SettingsOverridesCheck,
  authorizer?: Authorizer,
): EvalRunsRouters {
  return {
    start: startRouter(binding, versionsCheck, overridesCheck, authorizer),
    readback: readbackRouter(binding, authorizer),
  };
}

// ---------- POST /v1/eval-suites/:suiteId/runs ----------

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

function startRouter(
  binding: EvalRunBinding,
  versionsCheck?: FlowVersionsCheck,
  overridesCheck?: SettingsOverridesCheck,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/:suiteId/runs', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');

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
    const target =
      agentRef !== undefined
        ? ref('agent', agentRef.agentId as unknown as string)
        : ref('flow', flowRef?.flowId as unknown as string);
    // Running the suite takes `execute` on it (an editor of its project, or
    // an executor), whichever project the run lands in.
    const refused =
      (await deniedBy(authorizer, c, 'execute', ref('eval_suite', suiteId))) ??
      (await deniedBy(authorizer, c, 'write', ref('project', projectId as unknown as string))) ??
      (await deniedBy(authorizer, c, 'execute', target));
    if (refused !== undefined) return refused;
    const refusal =
      (await versionsRefusal(versionsCheck, tenantId, parsed.value)) ??
      (await overridesRefusal(overridesCheck, tenantId, parsed.value));
    if (refusal !== undefined) {
      c.status(statusFor(refusal.code) as never);
      return c.json(toWireError(refusal, requestId));
    }

    const outcome = await binding.start({
      tenantId,
      projectId: parsed.value.projectId,
      suiteId,
      ...(parsed.value.agentRef !== undefined && { agentRef: parsed.value.agentRef }),
      ...(parsed.value.flowRef !== undefined && { flowRef: parsed.value.flowRef }),
      ...(parsed.value.dryRun !== undefined && { dryRun: parsed.value.dryRun }),
      ...(parsed.value.correlationId !== undefined && {
        correlationId: parsed.value.correlationId,
      }),
      ...(parsed.value.comparison !== undefined && { comparison: parsed.value.comparison }),
    });
    if (outcome.kind === 'suite-not-found') {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite registered with id "${outcome.suiteId}"`,
            suiteId: outcome.suiteId,
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
            message: `No eval-run dispatcher registered for kind "${outcome.evalKind}". This kind is registry-only today.`,
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
      // like the eval-suites route; the caller learns from the message
      // which field was invalid.
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`projectId\` "${outcome.projectId as unknown as string}" does not resolve to a project in this tenant`,
          },
          requestId,
        ),
      );
    }

    c.status(201);
    return c.json({
      runId: outcome.runId as unknown as string,
      ...(outcome.dryRunPreview !== undefined && { dryRunPreview: outcome.dryRunPreview }),
    });
  });

  return r;
}

// ---------- /v1/eval-runs/* (readback + cancel + SSE) ----------

function readbackRouter(binding: EvalRunBinding, authorizer?: Authorizer): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  /** The refusal, if any, of `action` on the suite of the run named in the path. */
  const onRunSuite = async (c: Context<AppEnv>, action: Action): Promise<Response | undefined> => {
    if (authorizer === undefined) return undefined;
    const tenantId = c.get('tenantId') as TenantId;
    const run = await binding.get({ tenantId, runId: c.req.param('runId') as RunId });
    if (run === null) return undefined;
    return deniedBy(authorizer, c, action, ref('eval_suite', run.suiteId));
  };

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const statusRaw = c.req.query('status');
    if (statusRaw !== undefined && statusRaw.length > 0 && !isEvalRunStatus(statusRaw)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Unknown status "${statusRaw}". Expected one of: ${EVAL_RUN_STATUSES.join(', ')}.`,
          },
          requestId,
        ),
      );
    }
    const filter: EvalRunFilter = {};
    const suiteIdRaw = c.req.query('suiteId');
    if (suiteIdRaw !== undefined && suiteIdRaw.length > 0) {
      (filter as { suiteId?: string }).suiteId = suiteIdRaw;
    }
    if (statusRaw !== undefined && statusRaw.length > 0) {
      (filter as { status?: EvalRunStatus }).status = statusRaw as EvalRunStatus;
    }
    const agentIdRaw = c.req.query('agentId');
    if (agentIdRaw !== undefined && agentIdRaw.length > 0) {
      (filter as { agentId?: AgentId }).agentId = agentIdRaw as AgentId;
    }
    const flowIdRaw = c.req.query('flowId');
    if (flowIdRaw !== undefined && flowIdRaw.length > 0) {
      (filter as { flowId?: FlowId }).flowId = flowIdRaw as FlowId;
    }
    const fromRaw = c.req.query('from');
    if (fromRaw !== undefined && fromRaw.length > 0) {
      (filter as { from?: Timestamp }).from = fromRaw as Timestamp;
    }
    const toRaw = c.req.query('to');
    if (toRaw !== undefined && toRaw.length > 0) {
      (filter as { to?: Timestamp }).to = toRaw as Timestamp;
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
        : await authorizer.filterByCan(c, 'read', page.data, (run) =>
            ref('eval_suite', run.suiteId),
          );
    return c.json({
      data: visible.map(serializeEvalRun),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:runId ----------
  r.get('/:runId', async (c) => {
    const refused = await onRunSuite(c, 'read');
    if (refused !== undefined) return refused;
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;

    const run = await binding.get({ tenantId, runId });
    if (run === null) {
      c.status(statusFor('eval-run-not-found') as never);
      return c.json(
        toWireError(
          { code: 'eval-run-not-found', message: `No eval run with id ${runId}`, runId },
          requestId,
        ),
      );
    }
    return c.json(serializeEvalRun(run));
  });

  // ---------- POST /:runId/cancel ----------
  r.post('/:runId/cancel', async (c) => {
    const refused = await onRunSuite(c, 'write');
    if (refused !== undefined) return refused;
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;

    const outcome = await binding.cancel({ tenantId, runId });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('eval-run-not-found') as never);
      return c.json(
        toWireError(
          { code: 'eval-run-not-found', message: `No eval run with id ${runId}`, runId },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'already-terminal') {
      c.status(statusFor('eval-run-already-terminal') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-run-already-terminal',
            message: `Cannot cancel eval run ${runId}: already ${outcome.status}`,
            runId,
            status: outcome.status,
          },
          requestId,
        ),
      );
    }

    // Re-read to return the freshest wire shape.
    const reloaded = await binding.get({ tenantId, runId });
    if (reloaded === null) {
      // Very unlikely: cancel succeeded but the row vanished. Return
      // a minimal wire shape rather than 500 — the caller has the
      // runId and status intent already.
      return c.json({ runId: runId as unknown as string, cancelled: true });
    }
    return c.json(serializeEvalRun(reloaded));
  });

  // ---------- GET /:runId/events (SSE) ----------
  r.get('/:runId/events', async (c) => {
    const refused = await onRunSuite(c, 'read');
    if (refused !== undefined) return refused;
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;

    const initial = await binding.get({ tenantId, runId });
    if (initial === null) {
      c.status(statusFor('eval-run-not-found') as never);
      return c.json(
        toWireError(
          { code: 'eval-run-not-found', message: `No eval run with id ${runId}`, runId },
          requestId,
        ),
      );
    }

    const encoder = new TextEncoder();
    const POLL_MS = 100;
    const MAX_WAIT_MS = 5 * 60_000;

    // Track which per-case events we've already emitted (index within
    // result.perCase). Kept intentionally small — only the accuracy
    // kind's per-case shape is streamed; other kinds would need their
    // own projection.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const startedAt = Date.now();
        let lastEmittedCaseIndex = -1;
        let terminalEmitted = false;
        const emit = async (): Promise<{ terminal: boolean }> => {
          const snapshot = await binding.get({ tenantId, runId });
          if (snapshot === null) {
            controller.enqueue(
              encoder.encode(
                formatSseFrame({
                  id: `${runId}:error`,
                  event: 'error',
                  data: {
                    code: 'eval-run-not-found',
                    message: `eval run ${runId} disappeared`,
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
                  id: `${runId}:case:${i}`,
                  event: entry.pass === false ? 'eval-run.case-failed' : 'eval-run.case-completed',
                  data: { runId, caseIndex: i, ...entry },
                }),
              ),
            );
            lastEmittedCaseIndex = i;
          }
          if (isTerminalEvalRun(snapshot.status) && !terminalEmitted) {
            terminalEmitted = true;
            const wireKind =
              snapshot.status === 'completed'
                ? 'eval-run.completed'
                : snapshot.status === 'failed'
                  ? 'eval-run.failed'
                  : 'eval-run.cancelled';
            controller.enqueue(
              encoder.encode(
                formatSseFrame({
                  id: `${runId}:terminal`,
                  event: wireKind,
                  data: {
                    runId,
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
            await new Promise((r2) => setTimeout(r2, POLL_MS));
            const step = await emit();
            if (step.terminal) break;
          }
        } finally {
          close();
        }
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': requestId,
      },
    });
  });

  return r;
}

// ---------- helpers ----------

function serializeEvalRun(run: EvalRun): Record<string, unknown> {
  return {
    runId: run.runId as unknown as string,
    tenantId: run.tenantId as unknown as string,
    suiteId: run.suiteId,
    suiteVersion: run.suiteVersion,
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
    ...(run.correlationId !== undefined && { correlationId: run.correlationId }),
    ...(run.comparison !== undefined && { comparison: run.comparison }),
  };
}

function isEvalRunStatus(value: string): value is EvalRunStatus {
  return (EVAL_RUN_STATUSES as readonly string[]).includes(value);
}

function isTerminalEvalRun(status: EvalRunStatus): boolean {
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
  readonly comparison?: EvalComparison;
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
  if (
    correlationId !== undefined &&
    (typeof correlationId !== 'string' || correlationId.length === 0)
  ) {
    return {
      kind: 'err',
      error: {
        code: 'bad-input',
        message: '`correlationId` must be a non-empty string when supplied',
      },
    };
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
