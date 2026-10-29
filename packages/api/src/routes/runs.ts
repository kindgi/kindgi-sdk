// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import type {
  JournalPage,
  KernelRunRecord,
  ListRunsInput,
  RunBinding,
  RunStartedBy,
  RunStatus,
} from '@kindgi/runtime';
import type {
  FlowId,
  ListScope,
  ProjectId,
  RunId,
  ScopeSegment,
  Semver,
  TenantId,
  Timestamp,
  TriggerId,
} from '@kindgi/types';

import { type Principal, denyPayload, ref } from '@kindgi/authz';
import { PAUSE_TOKEN_PREFIX } from '@kindgi/tools';

import type { ConnectionBinding } from '../connection-binding.js';
import { type WireErrorBody, retryAfterSeconds, statusFor, toWireError } from '../errors.js';
import type { EventBusBinding, EventPayload, Subscription } from '../event-bus-binding.js';
import type {
  RunHandlerBinding,
  RunHandlerFailure,
  RunHandlerOutcome,
  RunTrace,
} from '../handler-binding.js';
import type { HitlBinding } from '../hitl-binding.js';
import { type ItemRights, runIn } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { databaseBusyAnswer } from '../middleware/error-mapper.js';
import type { MintPublicRunTokenResult } from '../public-run-token.js';
import {
  type ReferenceScopeBinding,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import { logResumeAfterAnswer, resumeInline } from '../resume-inline.js';
import { type RunFailure, runFailure } from '../run-failure.js';
import { runWaitingFor } from '../run-waiting-for.js';
import type { AppEnv } from '../types.js';
import type { CompleteWaitTokenInput, WaitTokenBinding } from '../wait-token-binding.js';
import { deniedBy } from './denied.js';
import { liveScopeToWire } from './live-scope-wire.js';
import type { DecodedCursor } from './pagination.js';
import { clampLimit, decodeCursor, isCursorTime } from './pagination.js';
import { participantRefusal } from './participant-access.js';
import { runFailuresHandler } from './run-failures.js';
import { parseListScope } from './scope-params.js';
import { parseSegmentsBody } from './segments.js';
import {
  formatSseFrame,
  isTerminalWireKind,
  parseLastEventId,
  pause,
  projectJournalEntry,
  readingOf,
  toRunProgressEvent,
} from './sse.js';
import { type TurnConversation, closedRefusal, hiddenOr, turnRefusal } from './turn-access.js';
import { UUID_RE, refuseMalformedUuidParam } from './uuid-param.js';
import { refusal as waitTokenRefusal } from './wait-tokens.js';

const KERNEL_RUN_CHANNEL_PREFIX = 'kernel:run:';

/** Options for `runsRouter`. */
export interface RunsRouterOptions {
  /**
   * The approvals, for a suspended run's `waitingFor` (the approvals linked
   * to its open waits). Absent: those waits are `unattributed`.
   */
  readonly hitl?: HitlBinding;
  /**
   * The connect requests, for a suspended run's `waitingFor.connections`
   * (a tool waiting for a person to connect an app). Absent: those waits
   * are `unattributed`.
   */
  readonly connections?: ConnectionBinding;
  /**
   * Runs paused until another system answers: `POST /:runId/resume` with a
   * `pause:` waitpoint id answers one, and a suspended run's `waitingFor`
   * lists them (`tokens`). Absent: the route answers `422
   * run-resume-not-supported`, and `tokens` is left out.
   */
  readonly waitTokens?: WaitTokenBinding;
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
  /**
   * What a run filed under a named project may run (`reference-scope.ts`):
   * an agent or flow that project doesn't reach is refused with
   * `reference-out-of-scope`. Absent: as named.
   */
  readonly referenceScope?: ReferenceScopeBinding;
  /**
   * What a turn posted into a conversation is checked against
   * (`turnRefusal`, `participantRefusal`, `closedRefusal`). `null`: no such
   * conversation.
   * Any other failure throws, so the turn never runs unchecked. Required,
   * as `targetProject` is: a router without it would check no conversation.
   */
  readonly conversationOf: (
    tenantId: TenantId,
    conversationId: string,
  ) => Promise<TurnConversation | null>;
  /**
   * Rights on an agent or flow more than one project serves
   * (`item-rights.ts`): running it in one of its projects is that
   * project's `call` (agents) or `execute` (flows), and a project-scoped
   * key's unnamed run lands in the key's project. Absent: every target has
   * one project.
   */
  readonly itemRights?: ItemRights;
  /** The project a target is registered in: the agent's or flow's own. */
  readonly targetProject: (
    tenantId: TenantId,
    target: { readonly kind: 'agent' | 'flow'; readonly id: string },
  ) => Promise<string | undefined>;
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
  options: RunsRouterOptions,
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
  // POST /:runId/resume — write on the run's project; answering a pause,
  //                       also execute on what the run runs (the route's)
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
    const turnInput =
      typeof parsed.value.input === 'object' && parsed.value.input !== null
        ? (parsed.value.input as Record<string, unknown>)
        : {};
    const conversationId =
      typeof turnInput.conversationId === 'string' ? turnInput.conversationId : undefined;
    // The conversation the turn continues, asked at most once. Conversation
    // ids are uuids: another id names no conversation (the run handler
    // answers it).
    let continued: Promise<Awaited<ReturnType<RunsRouterOptions['conversationOf']>>> | undefined;
    const conversation = () => {
      continued ??=
        conversationId === undefined || !UUID_RE.test(conversationId)
          ? Promise.resolve(null)
          : options.conversationOf(tenantId, conversationId);
      return continued;
    };

    // An agent or flow more than one project serves, run in one of its
    // projects: that project's right alone (`servedRun`).
    const ran = await servedRun(
      c,
      authorizer === undefined ? undefined : options.itemRights,
      target,
      parsed.value,
      conversation,
    );
    const refused =
      ran === undefined
        ? await refusedAsBefore(c, authorizer, options.targetExists, target, parsed.value)
        : ran.refused;
    if (refused !== undefined) return refused;
    const start = ran?.start ?? parsed.value;
    // A run filed under a named project runs only what that project
    // reaches (`reference-scope.ts`).
    if (start.projectId !== undefined) {
      const outOfScope = await referencesOutOfScope(
        options.referenceScope,
        tenantId,
        start.projectId,
        [{ path: `/${target.kind}`, kind: target.kind, id: target.id }],
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }

    // Who may add a turn to the conversation it continues, and under which
    // project (`turnRefusal`). Another id than a uuid names no conversation
    // (the run handler answers it), so only the body's participant is checked.
    const opened = await conversation();
    if (conversationId !== undefined && UUID_RE.test(conversationId)) {
      const refusal = await turnRefusal(c, authorizer, {
        conversationId,
        conversation: opened,
        namedProjectId: parsed.value.projectId as unknown as string | undefined,
      });
      if (refusal !== undefined) return refusal;
    }
    // Whose memory the turn runs with: a conversation's stored participant
    // (it wins, as the turn reads it), else the one the body names. Running
    // as someone takes what reading their memory takes.
    const named = typeof turnInput.participantId === 'string' ? turnInput.participantId : undefined;
    if (authorizer !== undefined && (named !== undefined || opened !== null)) {
      const participantId = opened?.participantId ?? named;
      if (participantId !== undefined) {
        const projectId =
          opened?.projectId ??
          (start.projectId as unknown as string | undefined) ??
          (await options.targetProject(tenantId, target));
        const refusal = await participantRefusal(c, authorizer, {
          participantId,
          projectId,
          ...(opened !== null && { conversationId }),
        });
        // Refused on the conversation's own participant: as if it didn't
        // exist, unless the caller can read it (`hiddenOr`). A participant
        // the body names keeps its 403: the conversation rule above has
        // already let the caller into the conversation.
        if (refusal !== undefined) {
          return opened?.participantId !== undefined && conversationId !== undefined
            ? hiddenOr(c, authorizer, conversationId, opened, refusal)
            : refusal;
        }
      }
    }
    // A closed conversation takes no new turns: refused before a run is
    // made, once the rules above let the caller add the turn.
    const closed = closedRefusal(c, conversationId, opened);
    if (closed !== undefined) return closed;

    const trace = c.get('trace');
    const invocation = await invokeFromBody(
      binding,
      tenantId,
      start,
      c.get('principal') as Principal | undefined,
      c.get('serviceAccountId') !== undefined,
      trace !== undefined ? { traceId: trace.traceId, spanId: trace.spanId } : undefined,
    );

    if (invocation.kind === 'err') {
      c.status(statusFor(invocation.error.code) as never);
      answerBudgetWait(c, invocation.error);
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

    const tenantId = c.get('tenantId') as TenantId;
    const loaded = await runBinding.getRun(tenantId, runId);
    if (loaded === null) {
      c.status(statusFor('run-not-found') as never);
      return c.json(
        toWireError({ code: 'run-not-found', message: `No run with id ${runId}` }, requestId),
      );
    }
    return c.json(await runWithWaits(runBinding, options, tenantId, loaded));
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
    const listFilter = parseRunListFilter(c.req.query(), c.req.queries('status'));
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
  // Answers a run paused until another system answers (a `pause:`
  // waitpoint), as that system would through the token's link: the value
  // is the tool's output, checked against its schema. The run resumes in
  // the same request, and the route answers the run. Every other waitpoint
  // belongs to an approval or to the runtime itself; completing one here
  // would skip what owns it (an approval's reviewer check and recorded
  // decision, or the runtime's own wake-up), so it's `422
  // run-resume-not-supported`. A run waiting for an approval continues
  // through `POST /v1/approvals/:id/complete`.
  r.post('/:runId/resume', refuseMalformedRunId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;
    const parsed = await readResumeRunBody(c);
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed.message }, requestId));
    }
    const waitTokens = options.waitTokens;
    if (!parsed.value.waitpointId.startsWith(PAUSE_TOKEN_PREFIX) || waitTokens === undefined) {
      c.status(statusFor('run-resume-not-supported') as never);
      return c.json(
        toWireError(
          {
            code: 'run-resume-not-supported',
            message: resumeNotSupportedMessage(waitTokens !== undefined),
          },
          requestId,
        ),
      );
    }
    const loaded = await runBinding.getRun(tenantId, runId);
    if (loaded === null) {
      c.status(statusFor('run-not-found') as never);
      return c.json(
        toWireError({ code: 'run-not-found', message: `No run with id ${runId}` }, requestId),
      );
    }
    const refused = await answerRefusal(c, authorizer, options, loaded);
    if (refused !== undefined) return refused;

    const taken = await waitTokens.complete(apiAnswer(c, tenantId, runId, parsed.value));
    if (taken.kind === 'err') return waitTokenRefusal(c, taken.error);
    if (taken.value.resolved) await resumeAfterAnswer(c, binding, tenantId, runId);
    const answered = (await runBinding.getRun(tenantId, runId)) ?? loaded;
    return c.json(await runWithWaits(runBinding, options, tenantId, answered));
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
    let lastEmittedSeq = since ?? -1;
    // Each read asks only for what this stream hasn't sent: a poll every
    // 200 ms no longer reads the whole journal. `emitEntry` still skips
    // what was sent, for a binding that gives every entry.
    const sinceEmitted = (): JournalPage => (lastEmittedSeq < 0 ? {} : { after: lastEmittedSeq });
    const POLL_MS = 200;
    const MAX_WAIT_MS = 5 * 60_000;
    // Aborted when the client goes away: the reader cancels the stream, or
    // the request aborts. The poll, the wait and the subscription below end
    // on it at once.
    const reading = readingOf(c.req.raw);

    const body = new ReadableStream<Uint8Array>({
      cancel() {
        reading.abort();
      },
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
          const stop = (): void => abortCtrl.abort();
          // `reading` can't have aborted yet: the route answers an aborted
          // request without a stream, and `start()` runs inside the stream's
          // constructor up to its first await, so no cancel or abort comes
          // before this listener.
          reading.signal.addEventListener('abort', stop, { once: true });
          let subscription: Subscription | null = null;
          let fallBackToPoll = false;
          try {
            // Backfill: read persisted journal up to now first, so a
            // reconnect with `Last-Event-Id` doesn't miss events that
            // landed while the client was disconnected. Then subscribe
            // for the tail push-side.
            const backfill = await runBinding.readJournal(tenantId, runId, sinceEmitted());
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
            if (abortCtrl.signal.aborted) return;
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
              // Wait until a terminal entry, the reader's cancel or the
              // max-wait window, whichever is first. We rely on the
              // subscription callback to write frames.
              await pause(MAX_WAIT_MS, abortCtrl.signal);
              return;
            }
          } finally {
            reading.signal.removeEventListener('abort', stop);
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
          const journal = await runBinding.readJournal(tenantId, runId, sinceEmitted());
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
          if (reading.signal.aborted) return;
          const first = await pollEmit();
          if (first.terminal) {
            close();
            return;
          }
          while (Date.now() - startedAt < MAX_WAIT_MS) {
            await pause(POLL_MS, reading.signal);
            if (reading.signal.aborted) break;
            const step = await pollEmit();
            if (step.terminal) break;
          }
        } finally {
          close();
        }
      },
    });

    return new Response(body, { status: 200, headers });
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
    // Paging is opt-in: with `limit`, at most that many entries after
    // `cursor`; without it, the whole journal, as before paging.
    const paging = parseJournalPaging(c.req.query('limit'), c.req.query('cursor'));
    if (paging.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: paging.message }, requestId));
    }
    const { limit, after } = paging;

    // Only the page is read (`journalPageToRead`). A binding that gives the
    // whole journal anyway gets the same page: the filter and the slice below
    // make it.
    const journal = await runBinding.readJournal(
      tenantId,
      runId,
      journalPageToRead(since, after, limit),
    );
    if (journal.kind === 'err') {
      const err = journal.error;
      const busy = databaseBusyAnswer(err, c);
      if (busy !== undefined) return busy;
      c.status(statusFor(err.code) as never);
      return c.json(toWireError(err as never, requestId));
    }

    // `readJournal` gives the entries in sequence order.
    const filtered = journal.value.filter(
      (e) =>
        (since === undefined || !Number.isFinite(since) || e.sequence > since) &&
        (after === undefined || e.sequence > after),
    );
    const page = limit !== undefined ? filtered.slice(0, limit) : filtered;
    // The page's last entry, when more remain after it.
    const endsBefore = page.length < filtered.length ? page.at(-1) : undefined;
    return c.json({
      data: page,
      hasMore: endsBefore !== undefined,
      ...(endsBefore !== undefined && { nextCursor: encodeJournalCursor(endsBefore.sequence) }),
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
  // A budget's wait is answered in `Retry-After` (`budgetWaitOf`), not in the body.
  const { retryAfterMs: _answered, ...withoutWait } = details ?? {};
  const shown = budgetWaitOf(failure) === undefined ? details : withoutWait;
  return toWireError({ ...shown, ...rest }, requestId);
}

/**
 * `Retry-After` for a turn refused by a budget kept per tenant
 * (`budgetWaitOf`), as the API's own refusal by that budget answers it.
 */
function answerBudgetWait(c: Context<AppEnv>, failure: RunHandlerFailure): void {
  const wait = budgetWaitOf(failure);
  if (wait !== undefined) c.header('Retry-After', String(retryAfterSeconds(wait)));
}

/**
 * The wait of a turn refused by a budget kept per tenant
 * (`rate-limit-exceeded`, `details.retryAfterMs`): answered in
 * `Retry-After`, as the API's own refusal by that budget is, with
 * `details.limit` and `details.budgetMs` in the body.
 */
function budgetWaitOf(failure: RunHandlerFailure): number | undefined {
  const wait = failure.details?.retryAfterMs;
  return failure.code === 'rate-limit-exceeded' && typeof wait === 'number' ? wait : undefined;
}

/**
 * How a run the API starts began (`RunStartedBy`), from its caller:
 * `person` when it's a person, signed in or with their own key; `key` when
 * it's a service account, or the request came with a service account's
 * key whoever it names. Any other caller (an agent, on its own or for
 * someone; the system) records none, so its run counts as unattended.
 */
export function startedByCaller(
  principal: Principal | undefined,
  serviceAccountKey: boolean,
): RunStartedBy | undefined {
  if (principal === undefined) return undefined;
  if (serviceAccountKey || principal.actor.kind === 'service_account') return 'key';
  if (principal.actor.kind === 'user' && principal.onBehalfOf === undefined) return 'person';
  return undefined;
}

/**
 * An answer to a run's wait stands in for the system that would send it,
 * and the run acts on it: as starting the run, `execute` on the agent or
 * flow it runs (in the run's project, for one more than one project
 * serves: that project's right), beside the `write` on the run's project
 * the route's middleware asks. A target that's gone is left to the resume.
 */
async function answerRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  options: RunsRouterOptions,
  run: KernelRunRecord,
): Promise<Response | undefined> {
  if (authorizer === undefined) return undefined;
  const target =
    run.agent !== undefined
      ? { kind: 'agent' as const, id: run.agent.id as unknown as string }
      : { kind: 'flow' as const, id: run.flowId as unknown as string };
  const projectId = run.projectId as unknown as string;
  if (
    options.itemRights !== undefined &&
    (await servedThere(c, options.itemRights, target, projectId))
  ) {
    return runIn(c, options.itemRights, target, projectId);
  }
  if ((await options.targetExists?.(run.tenantId, target)) === false) return undefined;
  return deniedBy(authorizer, c, 'execute', ref(target.kind, target.id));
}

/**
 * A run in full, as `GET /:runId` answers it. A suspended run says what
 * it waits for (left out when that can't be read).
 */
async function runWithWaits(
  runBinding: RunBinding,
  options: RunsRouterOptions,
  tenantId: TenantId,
  run: KernelRunRecord,
): Promise<Record<string, unknown>> {
  const waitingFor = await runWaitingFor(
    {
      runBinding,
      ...(options.hitl !== undefined && { hitl: options.hitl }),
      ...(options.connections !== undefined && { connections: options.connections }),
      ...(options.waitTokens !== undefined && { waitTokens: options.waitTokens }),
    },
    tenantId,
    { id: run.runId, status: run.status },
  );
  return {
    ...serializeRun(run, { output: true }),
    ...(waitingFor !== undefined && { waitingFor }),
  };
}

/** The resume body as an answer to the wait, from the caller. */
function apiAnswer(
  c: Context<AppEnv>,
  tenantId: TenantId,
  runId: RunId,
  body: { readonly waitpointId: string; readonly value?: unknown },
): CompleteWaitTokenInput {
  const principal = c.get('principal');
  return {
    via: 'api',
    tenantId,
    runId,
    tokenId: body.waitpointId,
    // No value is `{}`, as the link takes an empty body; a `null` is the answer, as on the link.
    output: body.value === undefined ? {} : body.value,
    ...(principal !== undefined && { principal }),
  };
}

/** The resume body, read and parsed. */
async function readResumeRunBody(
  c: Context<AppEnv>,
): Promise<ReturnType<typeof parseResumeRunBody>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { kind: 'err', message: 'Request body must be valid JSON' };
  }
  return parseResumeRunBody(body);
}

/** Why this runtime can't resume at the named waitpoint. */
function resumeNotSupportedMessage(pausesRuns: boolean): string {
  return pausesRuns
    ? 'Only a run paused until another system answers (a `pause:` waitpoint) resumes here: every other waitpoint belongs to an approval or to the runtime. A run waiting for an approval continues when a reviewer decides it (POST /v1/approvals/{approvalId}/complete, or `kindgi approvals complete`).'
    : 'This runtime resumes no run at a waitpoint: it pauses no run until another system answers. A run waiting for an approval continues when a reviewer decides it (POST /v1/approvals/{approvalId}/complete, or `kindgi approvals complete`).';
}

/**
 * Resume a run whose wait was just answered, in this request. The answer
 * is the runtime's either way: a failed resume is logged, and the
 * runtime ends a run that can't go on, or its sweep resumes the run later.
 */
async function resumeAfterAnswer(
  c: Context<AppEnv>,
  binding: RunHandlerBinding,
  tenantId: TenantId,
  runId: RunId,
): Promise<void> {
  const trace = c.get('trace');
  const resumed = await resumeInline(binding, tenantId, runId, {
    traceId: trace.traceId,
    spanId: trace.spanId,
  });
  logResumeAfterAnswer(c.get('log'), runId, resumed);
}

/** `{ waitpointId, value? }`, and nothing else. */
function parseResumeRunBody(body: unknown):
  | {
      readonly kind: 'ok';
      readonly value: { readonly waitpointId: string; readonly value?: unknown };
    }
  | { readonly kind: 'err'; readonly message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'err', message: 'The body is an object: `{ waitpointId, value }`' };
  }
  const { waitpointId, value, ...rest } = body as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    return {
      kind: 'err',
      message: `Unknown field \`${unknown[0]}\`: the body is \`{ waitpointId, value }\``,
    };
  }
  if (typeof waitpointId !== 'string' || waitpointId.length === 0) {
    return {
      kind: 'err',
      message: 'Field `waitpointId` is required: the id of the wait to answer',
    };
  }
  return { kind: 'ok', value: { waitpointId, ...(value !== undefined && { value }) } };
}

/**
 * A run checked as before (no item more than one project serves, or one
 * landing outside its projects): `execute` on the agent or flow, and a run
 * filed under a project the caller names needs `write` on it: the run
 * lands there, readable by that project's viewers (T307). Unnamed, the
 * runtime files it under the conversation's, the agent's or the flow's
 * own project, so a caller who may only run it needs no more, and the
 * refusal says so.
 */
async function refusedAsBefore(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  targetExists: RunsRouterOptions['targetExists'],
  target: { readonly kind: 'agent' | 'flow'; readonly id: string },
  start: ParsedStartRunBody,
): Promise<Response | undefined> {
  const tenantId = c.get('tenantId') as TenantId;
  if ((await targetExists?.(tenantId, target)) !== false) {
    const refused = await deniedBy(authorizer, c, 'execute', ref(target.kind, target.id));
    if (refused !== undefined) return refused;
  }
  if (authorizer === undefined || start.projectId === undefined) return undefined;
  const named = ref('project', start.projectId as unknown as string);
  const decision = await authorizer.check(c, 'write', named);
  if (decision.allowed) return undefined;
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
      c.get('requestId'),
    ),
  );
}

/**
 * Running an agent or a flow more than one project serves in one of its
 * projects is that project's right alone (`item-rights.ts`), asked of the
 * project the run lands in, by the runtime's order: the one named; else,
 * for an agent, the conversation's; else a project-scoped key's own, when
 * it serves the target (and the run is filed there: `start` names it);
 * else the first. `undefined`: no such item, one project serving it, or a
 * run landing outside its projects, checked as before.
 *
 * It asks only about the project the run lands in, never for every
 * project the item is in. A project that serves the item and isn't its
 * first means more than one does (`servesIn`); for its first, one other
 * project is enough to know (`servedElsewhere`).
 */
async function servedRun(
  c: Context<AppEnv>,
  itemRights: ItemRights | undefined,
  target: { readonly kind: 'agent' | 'flow'; readonly id: string },
  start: ParsedStartRunBody,
  conversation: () => Promise<{ readonly projectId?: string } | null>,
): Promise<{ start: ParsedStartRunBody; refused: Response | undefined } | undefined> {
  if (itemRights === undefined) return undefined;
  const named = start.projectId as unknown as string | undefined;
  if (named !== undefined) {
    return (await servedThere(c, itemRights, target, named))
      ? { start, refused: await runIn(c, itemRights, target, named) }
      : undefined;
  }
  const served = await itemRights.servedElsewhere(c, target.kind, target.id);
  if (served === undefined || !served.elsewhere) return undefined;
  const continued = target.kind === 'agent' ? (await conversation())?.projectId : undefined;
  if (continued !== undefined) {
    return (await oneOfItsProjects(c, itemRights, target, served.own, continued))
      ? { start, refused: await runIn(c, itemRights, target, continued) }
      : undefined;
  }
  const keyProject = c.get('tokenProjectId');
  const keyed =
    keyProject !== undefined &&
    (await oneOfItsProjects(c, itemRights, target, served.own, keyProject))
      ? keyProject
      : undefined;
  return {
    start: keyed === undefined ? start : { ...start, projectId: keyed as ProjectId },
    refused: await runIn(c, itemRights, target, keyed ?? served.own),
  };
}

/**
 * Whether `projectId` is one of the target's projects, and more than one
 * serves it: its first one alone isn't enough.
 */
async function servedThere(
  c: Context<AppEnv>,
  itemRights: ItemRights,
  target: { readonly kind: 'agent' | 'flow'; readonly id: string },
  projectId: string,
): Promise<boolean> {
  const there = await itemRights.servesIn(c, target.kind, target.id, projectId);
  if (there === undefined || !there.serves) return false;
  return (
    projectId !== there.own ||
    (await itemRights.servedElsewhere(c, target.kind, target.id))?.elsewhere === true
  );
}

/** Whether `projectId` is one of the target's projects, `own` (its first) among them. */
async function oneOfItsProjects(
  c: Context<AppEnv>,
  itemRights: ItemRights,
  target: { readonly kind: 'agent' | 'flow'; readonly id: string },
  own: string,
  projectId: string,
): Promise<boolean> {
  return (
    projectId === own ||
    (await itemRights.servesIn(c, target.kind, target.id, projectId))?.serves === true
  );
}

/** Hand a parsed start body to the binding: an agent turn or a flow run. */
function invokeFromBody(
  binding: RunHandlerBinding,
  tenantId: TenantId,
  body: ParsedStartRunBody,
  principal: Principal | undefined,
  serviceAccountKey: boolean,
  trace?: RunTrace,
): Promise<RunHandlerOutcome> {
  const startedBy = startedByCaller(principal, serviceAccountKey);
  const common = {
    tenantId,
    // Whom the run acts for: the authenticated caller, never the body.
    ...(principal !== undefined && { principal }),
    // How it started: from the caller too, never the body.
    ...(startedBy !== undefined && { startedBy }),
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
        ...(row.trigger.version !== undefined && { version: row.trigger.version }),
      },
    }),
    ...(row.startedBy !== undefined && { startedBy: row.startedBy }),
    ...(row.actsFor !== undefined && { actsFor: row.actsFor }),
    ...(row.toolsAllowedUnattended !== undefined &&
      row.toolsAllowedUnattended.length > 0 && {
        toolsAllowedUnattended: [...row.toolsAllowedUnattended],
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
    ...(filter.statuses !== undefined && { statuses: filter.statuses }),
    ...(filter.createdAfter !== undefined && { createdAfter: filter.createdAfter }),
    ...(filter.createdBefore !== undefined && { createdBefore: filter.createdBefore }),
    ...(filter.agentVersion !== undefined && { agentVersion: filter.agentVersion }),
    ...(filter.flowId !== undefined && { flowId: filter.flowId }),
    ...(filter.flowVersion !== undefined && { flowVersion: filter.flowVersion }),
  };
}

interface RunListFilter {
  readonly parentRunId?: RunId;
  readonly topLevelOnly: boolean;
  readonly agentId?: string;
  readonly replays: 'exclude' | 'include' | 'only';
  readonly evalRunId?: string;
  readonly triggerId?: TriggerId;
  readonly statuses?: readonly RunStatus[];
  readonly createdAfter?: Timestamp;
  readonly createdBefore?: Timestamp;
  readonly agentVersion?: string;
  readonly flowId?: string;
  readonly flowVersion?: string;
  readonly includeOutput: boolean;
}

/** Every run status: a `Record` over the type, so a new status fails the build here. */
const RUN_STATUSES: Readonly<Record<RunStatus, true>> = {
  pending: true,
  running: true,
  suspended: true,
  completed: true,
  failed: true,
  cancelled: true,
};

type Parsed<T> = { kind: 'ok'; value: T } | { kind: 'err'; message: string };

/** `?status=`, repeated or comma-separated (`status=failed&status=cancelled`, `status=failed,cancelled`), de-duplicated. */
function parseStatuses(raw: readonly string[] | undefined): Parsed<RunStatus[] | undefined> {
  if (raw === undefined || raw.length === 0) return { kind: 'ok', value: undefined };
  const given = raw.flatMap((v) => v.split(',')).map((s) => s.trim());
  const unknown = given.filter((s) => !Object.hasOwn(RUN_STATUSES, s));
  if (unknown.length > 0) {
    const named = unknown.join(', ') || '(empty)';
    return {
      kind: 'err',
      message: `Unknown \`status\` value(s): ${named}. Expected one or more of: ${Object.keys(RUN_STATUSES).join(', ')}`,
    };
  }
  return { kind: 'ok', value: [...new Set(given as RunStatus[])] };
}

/** `?createdAfter=` / `?createdBefore=`: strict bounds, as ISO times, after before before. */
function parseCreatedBounds(
  createdAfter: string | undefined,
  createdBefore: string | undefined,
): Parsed<{ readonly createdAfter?: Timestamp; readonly createdBefore?: Timestamp }> {
  const iso = (raw: string | undefined) =>
    raw === undefined || Number.isNaN(Date.parse(raw))
      ? undefined
      : (new Date(Date.parse(raw)).toISOString() as Timestamp);
  const after = iso(createdAfter);
  const before = iso(createdBefore);
  if (createdAfter !== undefined && after === undefined) {
    return { kind: 'err', message: '`createdAfter` must be a date-time' };
  }
  if (createdBefore !== undefined && before === undefined) {
    return { kind: 'err', message: '`createdBefore` must be a date-time' };
  }
  if (after !== undefined && before !== undefined && after >= before) {
    return { kind: 'err', message: '`createdAfter` must be earlier than `createdBefore`' };
  }
  return {
    kind: 'ok',
    value: {
      ...(after !== undefined && { createdAfter: after }),
      ...(before !== undefined && { createdBefore: before }),
    },
  };
}

/** The narrowing filters: `status`, the creation bounds, the agent's version, and the flow with its version. */
function parseRunNarrowing(
  query: Readonly<Record<string, string>>,
  status: readonly string[] | undefined,
): Parsed<
  Pick<
    RunListFilter,
    'statuses' | 'createdAfter' | 'createdBefore' | 'agentVersion' | 'flowId' | 'flowVersion'
  >
> {
  const { agentId, agentVersion, flowId, flowVersion } = query;
  const statuses = parseStatuses(status);
  if (statuses.kind === 'err') return statuses;
  const bounds = parseCreatedBounds(query.createdAfter, query.createdBefore);
  if (bounds.kind === 'err') return bounds;
  const empty = (
    [
      ['agentVersion', agentVersion],
      ['flowId', flowId],
      ['flowVersion', flowVersion],
    ] as const
  ).find(([, value]) => value !== undefined && value.trim() === '');
  if (empty !== undefined) return { kind: 'err', message: `\`${empty[0]}\` must not be empty` };
  if (agentVersion !== undefined && agentId === undefined) {
    return { kind: 'err', message: '`agentVersion` needs `agentId`' };
  }
  if (flowVersion !== undefined && flowId === undefined) {
    return { kind: 'err', message: '`flowVersion` needs `flowId`' };
  }
  return {
    kind: 'ok',
    value: {
      ...(statuses.value !== undefined && { statuses: statuses.value }),
      ...bounds.value,
      ...(agentVersion !== undefined && { agentVersion }),
      ...(flowId !== undefined && { flowId }),
      ...(flowVersion !== undefined && { flowVersion }),
    },
  };
}

/**
 * `?parentRunId=` (children of a run), `?topLevel=true`, `?agentId=` (an
 * agent's turns), `?replays=exclude|include|only` (default `exclude`),
 * `?evalRunId=` (one eval run's replays; implies they are included),
 * `?triggerId=` (the runs a trigger started), `?include=output`, and the
 * narrowing in `parseRunNarrowing`.
 */
function parseRunListFilter(
  query: Readonly<Record<string, string>>,
  status?: readonly string[],
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
  const narrowing = parseRunNarrowing(query, status);
  if (narrowing.kind === 'err') return narrowing;
  return {
    kind: 'ok',
    value: {
      ...narrowing.value,
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

/**
 * A journal read's paging: at most `limit` entries (a whole number from 1;
 * more than 100 gives 100), after the sequence `cursor` names. An empty
 * one is none. One that isn't one is refused, never read as a default.
 */
function parseJournalPaging(
  limitRaw: string | undefined,
  cursorRaw: string | undefined,
):
  | { readonly kind: 'ok'; readonly limit: number | undefined; readonly after: number | undefined }
  | { readonly kind: 'err'; readonly message: string } {
  let limit: number | undefined;
  if (limitRaw !== undefined && limitRaw !== '') {
    if (!/^[1-9][0-9]*$/.test(limitRaw)) {
      return {
        kind: 'err',
        message: '`limit` must be a whole number, 1 or more (a page holds at most 100)',
      };
    }
    limit = clampLimit(limitRaw);
  }
  let after: number | undefined;
  if (cursorRaw !== undefined && cursorRaw !== '') {
    const decoded = decodeJournalCursor(cursorRaw);
    if (decoded === null) return { kind: 'err', message: '`cursor` is malformed' };
    after = decoded;
  }
  return { kind: 'ok', limit, after };
}

/**
 * What a journal answer reads: the entries after the later of `since` (when
 * it's a number) and the cursor's sequence, and one more than `limit`, to
 * tell whether more remain after the page.
 */
function journalPageToRead(
  since: number | undefined,
  after: number | undefined,
  limit: number | undefined,
): JournalPage {
  const sinceSeq = since !== undefined && Number.isFinite(since) ? since : undefined;
  const from =
    sinceSeq === undefined ? after : after === undefined ? sinceSeq : Math.max(sinceSeq, after);
  return {
    ...(from !== undefined && { after: from }),
    ...(limit !== undefined && { limit: limit + 1 }),
  };
}

/**
 * A journal page's cursor: url-safe base64 of `{ sequence }`, the last
 * entry the page gave. The next page starts after it.
 */
function encodeJournalCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), 'utf8').toString('base64url');
}

/** The sequence a journal cursor names, or `null` for one that isn't (answered `400 bad-input`). */
function decodeJournalCursor(raw: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    const sequence = (parsed as { sequence?: unknown } | null)?.sequence;
    return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0
      ? sequence
      : null;
  } catch {
    return null;
  }
}
