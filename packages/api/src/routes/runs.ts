// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import type {
  FlowId,
  ListScope,
  ProjectId,
  RunId,
  ScopeSegment,
  Semver,
  TenantId,
  TriggerId,
} from '@kindgi/types';

import { type Principal, denyPayload, ref } from '@kindgi/authz';

import { type WireErrorBody, statusFor, toWireError } from '../errors.js';
import type { EventBusBinding, EventPayload, Subscription } from '../event-bus-binding.js';
import type {
  RunHandlerBinding,
  RunHandlerFailure,
  RunHandlerOutcome,
  RunTrace,
} from '../handler-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { MintPublicRunTokenResult } from '../public-run-token.js';
import { type RunFailure, runFailure } from '../run-failure.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';
import { liveScopeToWire } from './live-scope-wire.js';
import type { DecodedCursor } from './pagination.js';
import { clampLimit, decodeCursor, isCursorTime } from './pagination.js';
import { runFailuresHandler } from './run-failures.js';
import { parseListScope } from './scope-params.js';
import { parseSegmentsBody } from './segments.js';
import {
  formatSseFrame,
  isTerminalWireKind,
  parseLastEventId,
  projectJournalEntry,
  toRunProgressEvent,
} from './sse.js';
import { UUID_RE, refuseMalformedUuidParam } from './uuid-param.js';

const KERNEL_RUN_CHANNEL_PREFIX = 'kernel:run:';

/** Options for `runsRouter`. */
export interface RunsRouterOptions {
  /**
   * Optional push-based event bus. When present, `GET /:runId/stream`
   * subscribes on `kernel:run:<runId>` and delivers events
   * push-mode. When absent, the route polls the run's journal every
   * 200 ms — wire shape identical either way.
   */
  readonly eventBus?: EventBusBinding;
  /**
   * Issue public run tokens: `POST /` adds a `publicAccessToken` for the
   * new run, for its progress routes.
   */
  readonly publicRunTokens?: {
    readonly mint: (tenantId: TenantId, runIds: readonly RunId[]) => MintPublicRunTokenResult;
  };
  /**
   * Whether the tenant has the agent or flow a run names. With an
   * authorizer, starting a run needs `execute` on an existing target; one
   * that doesn't exist is left to the run handler's 404. Absent: the
   * check always runs.
   */
  readonly targetExists?: (
    tenantId: TenantId,
    target: { readonly kind: 'agent' | 'flow'; readonly id: string },
  ) => Promise<boolean>;
}

/** How far up the parent chain a public token's grant reaches. */
const MAX_RUN_ANCESTRY = 16;

/**
 * Runs resource routes (per `docs/API-ROUTE-CONVENTIONS.md` §7).
 *
 * Routes: `POST /` (start), `GET /:runId`, `GET /` (list),
 * `POST /:runId/cancel`, `POST /:runId/resume`, `GET /:runId/stream`
 * (SSE), `GET /:runId/journal`.
 */
/** A `:runId` that isn't a run id is a 400 (`uuid-param.ts`). */
const refuseMalformedRunId = refuseMalformedUuidParam('runId', 'a run id');

export function runsRouter(
  binding: RunHandlerBinding,
  runBinding: RunBinding,
  options: RunsRouterOptions = {},
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const eventBus = options.eventBus;

  // Authorization — a run inherits its permissions from its project.
  // Each check resolves the run's project (by run id) and asks the
  // authorizer about that project:
  //
  // POST /              — execute on the agent or flow it names (an
  //                       existing one; a missing one is the handler's 404)
  // GET /:runId         — read on the run's project
  // POST /:runId/cancel — write on the run's project
  // POST /:runId/resume — write on the run's project
  // GET /:runId/journal — read on the run's project
  // GET /:runId/stream  — read on the run's project
  // GET /               — list; rows filtered to `read` on their project
  if (authorizer !== undefined) {
    // A run that isn't there is the handler's 404: `read` on the tenant
    // (which every reader has) lets it through without masking it. An id
    // that isn't a run id is never looked up (its uuid cast would fail
    // the query as a 500): the route's own 400 answers it.
    const projectFromRun = async (c: import('hono').Context<AppEnv>) => {
      const tenantId = c.get('tenantId') as TenantId;
      const runId = c.req.param('runId') ?? '';
      const row = UUID_RE.test(runId) ? await runBinding.getRun(tenantId, runId as RunId) : null;
      return row === null
        ? ref('tenant', tenantId as unknown as string)
        : ref('project', row.projectId as unknown as string);
    };
    const onRunProject =
      (action: 'read' | 'write') =>
      async (c: import('hono').Context<AppEnv>, next: import('hono').Next) => {
        const resource = await projectFromRun(c);
        const mw = authorizer.authorize(
          resource.type === 'tenant' ? 'read' : action,
          () => resource,
        );
        return mw(c, next);
      };
    r.use('/:runId', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      return onRunProject('read')(c, next);
    });
    r.use('/:runId/journal', onRunProject('read'));
    r.use('/:runId/stream', onRunProject('read'));
    // Progress: `read` for API tokens. A public run token has no
    // principal; the handlers check that its grant covers the run.
    const progressAuth = async (c: import('hono').Context<AppEnv>, next: import('hono').Next) => {
      if (c.get('tokenKind') === 'public-run') return next();
      return onRunProject('read')(c, next);
    };
    r.use('/:runId/progress', progressAuth);
    r.use('/:runId/progress/stream', progressAuth);
    r.use('/:runId/cancel', onRunProject('write'));
    // As cancel: changing a run is `write` on its project (a project has
    // no `execute`; asking for it refused everyone, T243 A).
    r.use('/:runId/resume', onRunProject('write'));
  }

  // ---------- POST / (start a run — agent | flow) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    const parsed = parseStartRunBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor(parsed.error.code) as never);
      return c.json(toWireError(parsed.error, requestId));
    }

    const target =
      parsed.value.kind === 'agent'
        ? { kind: 'agent' as const, id: parsed.value.agentId as unknown as string }
        : { kind: 'flow' as const, id: parsed.value.flowId as unknown as string };
    if ((await options.targetExists?.(tenantId, target)) !== false) {
      const refused = await deniedBy(authorizer, c, 'execute', ref(target.kind, target.id));
      if (refused !== undefined) return refused;
    }
    // A run filed under a project the caller names needs `write` on it:
    // the run lands there, readable by that project's viewers (T307).
    // Unnamed, the runtime files it under the conversation's, the agent's
    // or the flow's own project, so a caller who may only run it needs no
    // more, and the refusal says so.
    if (authorizer !== undefined && parsed.value.projectId !== undefined) {
      const named = ref('project', parsed.value.projectId as unknown as string);
      const decision = await authorizer.check(c, 'write', named);
      if (!decision.allowed) {
        const deny = denyPayload('write', named.type, named.id, decision.reason);
        c.status(403);
        return c.json(
          toWireError(
            {
              code: deny.code,
              message: `Permission denied: naming project ${named.id} needs write on it; omit \`projectId\` to run in the ${target.kind}'s own project`,
              action: deny.action,
              resource: deny.resource,
              reason: deny.reason,
            },
            requestId,
          ),
        );
      }
    }

    const trace = c.get('trace');
    const invocation = await invokeFromBody(
      binding,
      tenantId,
      parsed.value,
      c.get('principal') as Principal | undefined,
      trace !== undefined ? { traceId: trace.traceId, spanId: trace.spanId } : undefined,
    );

    if (invocation.kind === 'err') {
      c.status(statusFor(invocation.error.code) as never);
      return c.json(runFailureToWire(invocation.error, requestId));
    }

    const runId = invocation.runId;
    const loaded = await runBinding.getRun(tenantId, runId);
    if (loaded === null) {
      c.status(statusFor('journal-error') as never);
      return c.json(
        toWireError(
          { code: 'journal-error', message: `Run ${runId} started but row not readable` },
          requestId,
        ),
      );
    }
    // `wait: false` → the binding handed the run id back before the
    // run finished: 202, and the caller polls `GET /v1/runs/:runId`.
    c.status(parsed.value.wait === false ? 202 : 201);
    const minted = options.publicRunTokens?.mint(tenantId, [runId]);
    return c.json({
      ...serializeRun(loaded, { output: true }),
      ...(minted?.kind === 'ok' && {
        publicAccessToken: minted.token,
        publicAccessTokenExpiresAt: minted.expiresAt.toISOString(),
      }),
    });
  });

  // ---------- GET /failures ----------
  // Before `/:runId`, which would read `failures` as a run id.
  r.get('/failures', runFailuresHandler(runBinding, authorizer));

  // ---------- GET /:runId ----------
  r.get('/:runId', refuseMalformedRunId, async (c) => {
    const requestId = c.get('requestId');
    const runId = c.req.param('runId') as RunId;

    const loaded = await runBinding.getRun(c.get('tenantId') as TenantId, runId);
    if (loaded === null) {
      c.status(statusFor('run-not-found') as never);
      return c.json(
        toWireError({ code: 'run-not-found', message: `No run with id ${runId}` }, requestId),
      );
    }
    return c.json(serializeRun(loaded, { output: true }));
  });

  // ---------- GET /:runId/progress ----------
  r.get('/:runId/progress', refuseMalformedRunId, async (c) => {
    const requestId = c.get('requestId');
    const runId = c.req.param('runId') as RunId;
    const loaded = await readableRun(runBinding, c, runId);
    if (loaded === null) {
      c.status(statusFor('run-not-found') as never);
      return c.json(
        toWireError({ code: 'run-not-found', message: `No run with id ${runId}` }, requestId),
      );
    }
    return c.json(serializeRunProgress(loaded));
  });

  // ---------- GET / (list, cursor-paginated) ----------
  //
  // Content-scoped list; scope filter threaded via `parseListScope` (a
  // `scopeId` that isn't a UUID is a 400 here, not a failed query).
  // Every run belongs to exactly one project; `scope.kind === 'project'`
  // narrows to that project, `scope.kind === 'org'` to the org's
  // projects, and tenant / undefined behave as documented in
  // scope-params.ts.
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    let cursorFilter: DecodedCursor | null = null;
    const rawCursor = c.req.query('cursor');
    if (rawCursor !== undefined && rawCursor.length > 0) {
      const decoded = decodeCursor(rawCursor);
      if (decoded === null || !isCursorTime(decoded.createdAt)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
        );
      }
      cursorFilter = decoded;
    }

    const scopeParsed = parseListScope(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }
    const listFilter = parseRunListFilter(c.req.query());
    if (listFilter.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: listFilter.message }, requestId));
    }
    const includeOutput = listFilter.value.includeOutput;

    const page = await runBinding.listRuns(
      listRunsInput({
        tenantId,
        scope: scopeParsed.scope,
        limit,
        cursor: cursorFilter,
        filter: listFilter.value,
      }),
    );
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (row) =>
            ref('project', row.projectId as unknown as string),
          );
    return c.json({
      data: visible.map((row) => serializeRun(row, { output: includeOutput })),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST /:runId/cancel ----------
  r.post('/:runId/cancel', refuseMalformedRunId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;

    const cancelled = await runBinding.cancelRun(tenantId, runId, eventBus);
    if (cancelled.kind === 'err') {
      const err = cancelled.error;
      c.status(statusFor(err.code) as never);
      return c.json(toWireError(err as never, requestId));
    }

    // Re-read to return the updated row.
    const reloaded = await runBinding.getRun(tenantId, runId);
    if (reloaded === null) {
      c.status(statusFor('journal-error') as never);
      return c.json(
        toWireError(
          {
            code: 'journal-error',
            message: 'Cancelled OK but failed to reload run row',
          },
          requestId,
        ),
      );
    }
    return c.json(serializeRun(reloaded, { output: true }));
  });

  // ---------- POST /:runId/resume ----------
  // Not available in this release. Every waitpoint a run can wait at
  // belongs to an approval or to the runtime itself (a flow's agent step
  // waiting on its child turn). Completing one here would skip what owns
  // it: an approval's reviewer check and recorded decision, or the
  // runtime's own wake-up. A run waiting for an approval continues
  // through `POST /v1/approvals/:id/complete`. So nothing is read or
  // completed; the route stays mounted for a clear answer.
  r.post('/:runId/resume', (c) => {
    c.status(statusFor('run-resume-not-supported') as never);
    return c.json(
      toWireError(
        {
          code: 'run-resume-not-supported',
          message:
            'Resuming a run at a waitpoint is not available in this release: every waitpoint belongs to an approval or to the runtime. A run waiting for an approval continues when a reviewer decides it (POST /v1/approvals/{approvalId}/complete, or `kindgi approvals complete`).',
        },
        c.get('requestId'),
      ),
    );
  });

  // ---------- GET /:runId/stream and /:runId/progress/stream (SSE) ----------
  // One stream, two views: every event in full, or progress only (no
  // payloads), which a public run token may follow.
  const streamRun = async (c: import('hono').Context<AppEnv>, view: 'full' | 'progress') => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;
    const since = parseLastEventId(c.req.header('last-event-id'));

    // Verify the run belongs to this tenant before opening the stream —
    // otherwise a cross-tenant probe learns run existence via the stream
    // hanging vs 404-ing.
    const run = await readableRun(runBinding, c, runId);
    if (run === null) {
      c.status(statusFor('run-not-found') as never);
      return c.json(
        toWireError({ code: 'run-not-found', message: `No run with id ${runId}` }, requestId),
      );
    }

    const encoder = new TextEncoder();
    let lastEmittedSeq = since ?? -1;
    const POLL_MS = 200;
    const MAX_WAIT_MS = 5 * 60_000;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const startedAt = Date.now();
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

        // Shared projection helper: emit one journal-entry-shaped
        // record to the stream. Returns true iff the entry was a
        // terminal wire kind so the caller can close.
        const emitEntry = (entry: {
          sequence: number;
          kind: string;
          nodeId?: string;
          payload?: unknown;
          timestamp: string;
        }): boolean => {
          if (entry.sequence <= lastEmittedSeq) return false;
          const projected = projectJournalEntry(
            {
              sequence: entry.sequence,
              kind: entry.kind as never,
              ...(entry.nodeId !== undefined && { nodeId: entry.nodeId as never }),
              ...(entry.payload !== undefined && { payload: entry.payload }),
              timestamp: entry.timestamp as never,
            },
            runId,
            tenantId,
          );
          lastEmittedSeq = entry.sequence;
          if (projected === null) return false;
          controller.enqueue(
            encoder.encode(
              formatSseFrame({
                id: projected.event.eventId,
                event: projected.wireKind,
                data: view === 'progress' ? toRunProgressEvent(projected.event) : projected.event,
              }),
            ),
          );
          return isTerminalWireKind(projected.wireKind);
        };

        // Push-mode: prefer the event bus when wired. The bus delivers
        // journal entries as `doc` payloads; we backfill via journal
        // reads from `since` first so `Last-Event-Id` resumes work
        // whether we're on the push or poll path.
        if (eventBus !== undefined) {
          const abortCtrl = new AbortController();
          let subscription: Subscription | null = null;
          let fallBackToPoll = false;
          try {
            // Backfill: read persisted journal up to now first, so a
            // reconnect with `Last-Event-Id` doesn't miss events that
            // landed while the client was disconnected. Then subscribe
            // for the tail push-side.
            const backfill = await runBinding.readJournal(tenantId, runId);
            if (backfill.kind === 'err') {
              controller.enqueue(
                encoder.encode(
                  formatSseFrame({
                    id: `${runId}:error`,
                    event: 'error',
                    data: {
                      code: 'journal-error',
                      message: backfill.error.message,
                      requestId,
                    },
                  }),
                ),
              );
              close();
              return;
            }
            let sawTerminal = false;
            for (const entry of backfill.value) {
              if (
                emitEntry({
                  sequence: entry.sequence,
                  kind: entry.kind,
                  ...(entry.nodeId !== undefined && { nodeId: entry.nodeId as string }),
                  ...(entry.payload !== undefined && { payload: entry.payload }),
                  timestamp: entry.timestamp as string,
                })
              ) {
                sawTerminal = true;
              }
            }
            if (sawTerminal) {
              close();
              return;
            }
            const subOutcome = await eventBus.subscribe(
              tenantId,
              `${KERNEL_RUN_CHANNEL_PREFIX}${runId}`,
              (payload: EventPayload) => {
                const doc = payload.doc as
                  | {
                      sequence?: unknown;
                      kind?: unknown;
                      nodeId?: unknown;
                      payload?: unknown;
                      timestamp?: unknown;
                    }
                  | null
                  | undefined;
                if (doc === null || doc === undefined) return;
                if (typeof doc.sequence !== 'number' || typeof doc.kind !== 'string') return;
                if (typeof doc.timestamp !== 'string') return;
                const wasTerminal = emitEntry({
                  sequence: doc.sequence,
                  kind: doc.kind,
                  ...(typeof doc.nodeId === 'string' && { nodeId: doc.nodeId }),
                  ...('payload' in doc && doc.payload !== undefined && { payload: doc.payload }),
                  timestamp: doc.timestamp,
                });
                if (wasTerminal) {
                  abortCtrl.abort();
                  close();
                }
              },
              abortCtrl.signal,
              { sinceSeq: lastEmittedSeq < 0 ? 0 : lastEmittedSeq },
            );
            if (subOutcome.kind === 'err') {
              // Subscription setup failed. Not fatal: leave the stream
              // open and continue with the poll path below.
              fallBackToPoll = true;
            } else {
              subscription = subOutcome.value;
              // Wait until close or max-wait window elapses. We rely
              // on the subscription callback to write frames.
              await new Promise<void>((resolve) => {
                const timer = setTimeout(() => resolve(), MAX_WAIT_MS);
                const onDone = (): void => {
                  clearTimeout(timer);
                  resolve();
                };
                abortCtrl.signal.addEventListener('abort', onDone, { once: true });
              });
              return;
            }
          } finally {
            abortCtrl.abort();
            if (subscription !== null) {
              try {
                await subscription.unsubscribe();
              } catch {
                /* cleanup best-effort */
              }
            }
            if (!fallBackToPoll) close();
          }
        }

        // Poll mode: no event bus wired, or subscribing failed. Poll the
        // journal every 200 ms until a terminal entry or the max-wait
        // window elapses.
        const pollEmit = async (): Promise<{ terminal: boolean }> => {
          const journal = await runBinding.readJournal(tenantId, runId);
          if (journal.kind === 'err') {
            const frame = formatSseFrame({
              id: `${runId}:error`,
              event: 'error',
              data: {
                code: 'journal-error',
                message: journal.error.message,
                requestId,
              },
            });
            controller.enqueue(encoder.encode(frame));
            return { terminal: true };
          }
          let sawTerminal = false;
          for (const entry of journal.value) {
            if (
              emitEntry({
                sequence: entry.sequence,
                kind: entry.kind,
                ...(entry.nodeId !== undefined && { nodeId: entry.nodeId as string }),
                ...(entry.payload !== undefined && { payload: entry.payload }),
                timestamp: entry.timestamp as string,
              })
            ) {
              sawTerminal = true;
            }
          }
          return { terminal: sawTerminal };
        };
        try {
          const first = await pollEmit();
          if (first.terminal) {
            close();
            return;
          }
          while (Date.now() - startedAt < MAX_WAIT_MS) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            const step = await pollEmit();
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
  };
  r.get('/:runId/stream', refuseMalformedRunId, (c) => streamRun(c, 'full'));
  r.get('/:runId/progress/stream', refuseMalformedRunId, (c) => streamRun(c, 'progress'));

  // ---------- GET /:runId/journal ----------
  r.get('/:runId/journal', refuseMalformedRunId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;
    const sinceRaw = c.req.query('since');
    const since = sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : undefined;

    const journal = await runBinding.readJournal(tenantId, runId);
    if (journal.kind === 'err') {
      const err = journal.error;
      c.status(statusFor(err.code) as never);
      return c.json(toWireError(err as never, requestId));
    }

    const filtered =
      since !== undefined && Number.isFinite(since)
        ? journal.value.filter((e) => e.sequence > since)
        : journal.value;
    return c.json({
      data: filtered,
      hasMore: false,
    });
  });

  return r;
}

/**
 * Wire body for a binding failure. `RunHandlerFailure.details` become
 * the wire error's `details` (not nested under `details.details`);
 * any other field a binding attaches rides along, and `code` /
 * `message` always come from the failure itself.
 */
function runFailureToWire(failure: RunHandlerFailure, requestId: string): WireErrorBody {
  const { details, ...rest } = failure as RunHandlerFailure & Readonly<Record<string, unknown>>;
  return toWireError({ ...details, ...rest }, requestId);
}

/** Hand a parsed start body to the binding: an agent turn or a flow run. */
function invokeFromBody(
  binding: RunHandlerBinding,
  tenantId: TenantId,
  body: ParsedStartRunBody,
  principal: Principal | undefined,
  trace?: RunTrace,
): Promise<RunHandlerOutcome> {
  const common = {
    tenantId,
    // Whom the run acts for: the authenticated caller, never the body.
    ...(principal !== undefined && { principal }),
    ...(trace !== undefined && { trace }),
    ...(body.projectId !== undefined && { projectId: body.projectId }),
    input: body.input,
    ...(body.segments !== undefined && { segments: body.segments }),
    ...(body.dryRun !== undefined && { dryRun: body.dryRun }),
    ...(body.wait !== undefined && { wait: body.wait }),
  };
  return body.kind === 'agent'
    ? binding.invokeAgent({
        ...common,
        agentId: body.agentId,
        ...(body.agentVersion !== undefined && { agentVersion: body.agentVersion }),
      })
    : binding.invokeFlow({
        ...common,
        flowId: body.flowId,
        ...(body.flowVersion !== undefined && { flowVersion: body.flowVersion }),
      });
}

/**
 * Wire row for a run. `output` is the run's output once it completed;
 * single-run responses carry it, lists only with `?include=output`
 * (outputs can be large). Child runs carry their parent's run + node;
 * an agent's turns, the agent, its version and the conversation; a
 * replay run, the run it replays and its eval run.
 */
function serializeRun(
  row: KernelRunRecord,
  opts: { readonly output: boolean },
): Record<string, unknown> {
  return {
    id: row.runId as unknown as string,
    tenantId: row.tenantId as unknown as string,
    projectId: row.projectId as unknown as string,
    flowId: row.flowId,
    flowVersion: row.flowVersion,
    status: row.status,
    dryRun: row.dryRun,
    createdAt: row.createdAt as unknown as string,
    updatedAt: row.updatedAt as unknown as string,
    completedAt: row.completedAt ?? undefined,
    failureMessage: row.failureMessage ?? undefined,
    ...withFailure(row),
    ...(opts.output && row.output !== undefined && { output: row.output }),
    ...(row.parentRunId != null && { parentRunId: row.parentRunId as unknown as string }),
    ...(row.parentNodeId != null && { parentNodeId: row.parentNodeId as unknown as string }),
    ...(row.agent !== undefined && {
      agent: {
        id: row.agent.id,
        version: row.agent.version,
        conversationId: row.agent.conversationId as unknown as string,
        ...(row.agent.via !== undefined && { via: row.agent.via }),
        ...(row.agent.liveScope !== undefined && {
          liveScope: liveScopeToWire(row.agent.liveScope),
        }),
      },
    }),
    ...(row.replayOf != null && { replayOf: row.replayOf as unknown as string }),
    ...(row.evalRunId != null && { evalRunId: row.evalRunId }),
    ...(row.trigger !== undefined && {
      trigger: {
        triggerId: row.trigger.triggerId as unknown as string,
        kind: row.trigger.kind,
        fireId: row.trigger.fireId,
        ...(row.trigger.scheduledFor !== undefined && {
          scheduledFor: row.trigger.scheduledFor as unknown as string,
        }),
      },
    }),
    ...(row.versions != null && { versions: row.versions }),
    ...(row.contentErasedAt !== undefined && {
      contentErasedAt: row.contentErasedAt as unknown as string,
    }),
    ...(row.segments !== undefined &&
      row.segments.length > 0 && {
        segments: row.segments.map(({ key, value }) => ({ key, value })),
      }),
    ...(row.traceId != null && { traceId: row.traceId }),
  };
}

/** `failure` on a failed run's wire row: its error, decoded once, here. */
function withFailure(row: KernelRunRecord): { readonly failure?: RunFailure } {
  const failure = runFailure(row);
  return failure !== undefined ? { failure } : {};
}

/** A run's progress: status and timing, no data. */
function serializeRunProgress(row: KernelRunRecord): Record<string, unknown> {
  return {
    id: row.runId as unknown as string,
    flowId: row.flowId,
    flowVersion: row.flowVersion,
    status: row.status,
    createdAt: row.createdAt as unknown as string,
    updatedAt: row.updatedAt as unknown as string,
    ...(row.completedAt != null && { completedAt: row.completedAt as unknown as string }),
    ...(row.parentRunId != null && { parentRunId: row.parentRunId as unknown as string }),
  };
}

/**
 * The run when the caller may read it: any run of the tenant for an API
 * token; for a public run token, a run the token names or a descendant
 * of one. `null` otherwise, which the routes answer as 404 so a token
 * learns nothing about other runs.
 */
async function readableRun(
  runBinding: RunBinding,
  c: import('hono').Context<AppEnv>,
  runId: RunId,
): Promise<KernelRunRecord | null> {
  const tenantId = c.get('tenantId') as TenantId;
  const row = await runBinding.getRun(tenantId, runId);
  if (row === null || c.get('tokenKind') !== 'public-run') return row;
  const granted = c.get('publicRunIds') ?? [];
  let current: KernelRunRecord | null = row;
  for (let depth = 0; current !== null && depth < MAX_RUN_ANCESTRY; depth += 1) {
    if (granted.includes(current.runId)) return row;
    if (current.parentRunId == null) return null;
    current = await runBinding.getRun(tenantId, current.parentRunId);
  }
  return null;
}

/** The binding query for `GET /v1/runs`: scope, page, and the parent filters. */
function listRunsInput(input: {
  readonly tenantId: TenantId;
  readonly scope: ListScope | undefined;
  readonly limit: number;
  readonly cursor: DecodedCursor | null;
  readonly filter: RunListFilter;
}): ListRunsInput {
  const { tenantId, scope, limit, cursor, filter } = input;
  return {
    tenantId,
    ...(scope !== undefined && { scope }),
    limit,
    ...(cursor !== null && {
      cursor: { createdAt: cursor.createdAt as never, id: cursor.id as RunId },
    }),
    ...(filter.parentRunId !== undefined && { parent: { runId: filter.parentRunId } }),
    ...(filter.topLevelOnly && { topLevelOnly: true }),
    ...(filter.agentId !== undefined && { agentId: filter.agentId }),
    replays: filter.replays,
    ...(filter.evalRunId !== undefined && { evalRunId: filter.evalRunId }),
    ...(filter.triggerId !== undefined && { triggerId: filter.triggerId }),
  };
}

interface RunListFilter {
  readonly parentRunId?: RunId;
  readonly topLevelOnly: boolean;
  readonly agentId?: string;
  readonly replays: 'exclude' | 'include' | 'only';
  readonly evalRunId?: string;
  readonly triggerId?: TriggerId;
  readonly includeOutput: boolean;
}

/**
 * `?parentRunId=` (children of a run), `?topLevel=true`, `?agentId=` (an
 * agent's turns), `?replays=exclude|include|only` (default `exclude`),
 * `?evalRunId=` (one eval run's replays; implies they are included),
 * `?triggerId=` (the runs a trigger started), `?include=output`.
 */
function parseRunListFilter(
  query: Readonly<Record<string, string>>,
): { kind: 'ok'; value: RunListFilter } | { kind: 'err'; message: string } {
  const { parentRunId, topLevel, agentId, replays, evalRunId, triggerId, include } = query;
  if (triggerId !== undefined && !UUID_RE.test(triggerId)) {
    return { kind: 'err', message: '`triggerId` must be a trigger id (a UUID)' };
  }
  if (agentId !== undefined && agentId.trim() === '') {
    return { kind: 'err', message: '`agentId` must not be empty' };
  }
  if (topLevel !== undefined && topLevel !== 'true' && topLevel !== 'false') {
    return { kind: 'err', message: '`topLevel` must be `true` or `false`' };
  }
  const topLevelOnly = topLevel === 'true';
  if (parentRunId !== undefined && !UUID_RE.test(parentRunId)) {
    return { kind: 'err', message: '`parentRunId` must be a run id (a UUID)' };
  }
  if (parentRunId !== undefined && topLevelOnly) {
    return { kind: 'err', message: '`parentRunId` and `topLevel=true` cannot be combined' };
  }
  if (
    replays !== undefined &&
    replays !== 'exclude' &&
    replays !== 'include' &&
    replays !== 'only'
  ) {
    return { kind: 'err', message: '`replays` must be `exclude`, `include` or `only`' };
  }
  if (evalRunId !== undefined && evalRunId.trim() === '') {
    return { kind: 'err', message: '`evalRunId` must not be empty' };
  }
  if (evalRunId !== undefined && replays === 'exclude') {
    return { kind: 'err', message: '`evalRunId` and `replays=exclude` cannot be combined' };
  }
  const includes = include === undefined ? [] : include.split(',').map((i) => i.trim());
  const unknown = includes.filter((i) => i !== 'output');
  if (unknown.length > 0) {
    return { kind: 'err', message: `Unknown \`include\` value(s): ${unknown.join(', ')}` };
  }
  return {
    kind: 'ok',
    value: {
      ...(parentRunId !== undefined && { parentRunId: parentRunId as RunId }),
      topLevelOnly,
      ...(agentId !== undefined && { agentId }),
      replays: replays ?? (evalRunId !== undefined ? 'include' : 'exclude'),
      ...(evalRunId !== undefined && { evalRunId }),
      ...(triggerId !== undefined && { triggerId: triggerId as TriggerId }),
      includeOutput: includes.includes('output'),
    },
  };
}

/** `options` of a start body: `dryRun?`, `wait?` (booleans). */
function parseStartOptions(
  raw: unknown,
):
  | { kind: 'ok'; value: { readonly dryRun?: boolean; readonly wait?: boolean } }
  | { kind: 'err'; error: { code: string; message: string } } {
  const options = (raw ?? {}) as Record<string, unknown>;
  if (typeof options !== 'object' || options === null) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`options` must be an object when supplied' },
    };
  }
  for (const key of ['dryRun', 'wait'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      return {
        kind: 'err',
        error: { code: 'bad-input', message: `\`options.${key}\` must be a boolean` },
      };
    }
  }
  const { dryRun, wait } = options as { dryRun?: boolean; wait?: boolean };
  return {
    kind: 'ok',
    value: { ...(dryRun !== undefined && { dryRun }), ...(wait !== undefined && { wait }) },
  };
}

type ParsedStartRunBody =
  | {
      readonly kind: 'agent';
      readonly agentId: AgentId;
      readonly agentVersion?: Semver;
      readonly projectId?: ProjectId;
      readonly segments?: readonly ScopeSegment[];
      readonly input: unknown;
      readonly dryRun?: boolean;
      readonly wait?: boolean;
    }
  | {
      readonly kind: 'flow';
      readonly flowId: FlowId;
      readonly flowVersion?: Semver;
      readonly projectId?: ProjectId;
      readonly segments?: readonly ScopeSegment[];
      readonly input: unknown;
      readonly dryRun?: boolean;
      readonly wait?: boolean;
    };

function parseStartRunBody(
  body: unknown,
):
  | { kind: 'ok'; value: ParsedStartRunBody }
  | { kind: 'err'; error: { code: string; message: string } } {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const b = body as Record<string, unknown>;
  const hasAgent = typeof b.agent === 'string' && b.agent.length > 0;
  const hasGraph = typeof b.flow === 'string' && b.flow.length > 0;
  if (hasAgent && hasGraph) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: 'Provide exactly one of `agent` or `flow`, not both' },
    };
  }
  if (!hasAgent && !hasGraph) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: 'Request body must include `agent` or `flow`' },
    };
  }
  if (!('input' in b)) {
    return { kind: 'err', error: { code: 'bad-input', message: '`input` is required' } };
  }

  const options = parseStartOptions(b.options);
  if (options.kind === 'err') return options;
  const { dryRun, wait } = options.value;
  const parsedSegments = parseSegmentsBody(b.segments);
  if (parsedSegments.kind === 'err') {
    return { kind: 'err', error: { code: 'bad-input', message: parsedSegments.message } };
  }
  const { segments } = parsedSegments;
  if (hasAgent) {
    const agentVersion = b.agentVersion;
    if (agentVersion !== undefined && typeof agentVersion !== 'string') {
      return {
        kind: 'err',
        error: { code: 'bad-input', message: '`agentVersion` must be a string when supplied' },
      };
    }
    const agentProjectIdRaw = b.projectId;
    if (agentProjectIdRaw !== undefined && typeof agentProjectIdRaw !== 'string') {
      return {
        kind: 'err',
        error: { code: 'bad-input', message: '`projectId` must be a string when supplied' },
      };
    }
    return {
      kind: 'ok',
      value: {
        kind: 'agent',
        agentId: b.agent as AgentId,
        ...(agentVersion !== undefined && { agentVersion: agentVersion as Semver }),
        ...(agentProjectIdRaw !== undefined && { projectId: agentProjectIdRaw as ProjectId }),
        ...(segments !== undefined && { segments }),
        input: b.input,
        ...(dryRun !== undefined && { dryRun }),
        ...(wait !== undefined && { wait }),
      },
    };
  }
  const flowVersion = b.flowVersion;
  if (flowVersion !== undefined && typeof flowVersion !== 'string') {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`flowVersion` must be a string when supplied' },
    };
  }
  const projectId = b.projectId;
  if (projectId !== undefined && typeof projectId !== 'string') {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`projectId` must be a string when supplied' },
    };
  }
  return {
    kind: 'ok',
    value: {
      kind: 'flow',
      flowId: b.flow as FlowId,
      ...(flowVersion !== undefined && { flowVersion: flowVersion as Semver }),
      ...(projectId !== undefined && { projectId: projectId as ProjectId }),
      ...(segments !== undefined && { segments }),
      input: b.input,
      ...(dryRun !== undefined && { dryRun }),
      ...(wait !== undefined && { wait }),
    },
  };
}
