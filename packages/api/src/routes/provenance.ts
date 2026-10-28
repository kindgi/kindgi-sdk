// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context, Next } from 'hono';

import type { ConversationBinding } from '@kindgi/agents';
import type { AuditEventBinding } from '@kindgi/audit-events';
import { ref } from '@kindgi/authz';
import type { ExportSigningBinding } from '@kindgi/crypto';
import { stepNodePlacer } from '@kindgi/provenance';
import type { Provenance } from '@kindgi/provenance';
import type { RunBinding } from '@kindgi/runtime';
import type { ConversationId, FlowId, RunId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';

import type { Authorizer } from '../middleware/authorize.js';
import { databaseBusyAnswer } from '../middleware/error-mapper.js';
import type {
  CallUsageByCallId,
  ProvenanceBinding,
  ProvenanceBindingError,
  ProvenanceListCursor,
  ProvenanceRecordSummary,
  StepRunsUsage,
  StepUsage,
  StepUsageByNodeId,
} from '../provenance-binding.js';
import {
  exportActor,
  parseSigningKeyId,
  readExportBody,
  signExport,
  signExportFailure,
  signingNotConfigured,
} from '../signed-export.js';
import type { AppEnv } from '../types.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';
import { parseListScope } from './scope-params.js';
import { parseTimeInput } from './time-input.js';
import { UUID_RE } from './uuid-param.js';

/**
 * Provenance resource routes.
 *
 * Reads flow through `ProvenanceBinding`: the API package owns the wire
 * shape + pagination envelope while the binding owns the storage
 * projection (query + serialization to `ProvenanceRecordSummary`). Export signing
 * is caller-plugged via `SigningKeyBinding` from the crypto module:
 * deployments that need signed exports plug in a KMS-backed key store;
 * deployments that omit the binding get `404 signing-not-configured` on
 * the export route.
 *
 * The export bundle is canonicalized as sorted-key JSON (via
 * `canonicalize` — same algorithm the runtime uses for signing
 * individual `Provenance` records) so the signature verifies byte-
 * identically on any client that re-canonicalizes the same shape.
 * Verification is a pure client-side operation via `verifyEd25519` — no
 * server round trip.
 */
export interface ProvenanceRouterOptions {
  /** Signs provenance exports. Absent: `POST /:runId/export` answers `404 signing-not-configured`. */
  readonly exportSigning?: ExportSigningBinding;
  /** Records each signed export (`export-signed`). */
  readonly auditEvents?: AuditEventBinding;
  /**
   * Conversation binding used by the signed-export path to read
   * conversation transcripts (`readMessages`) alongside provenance
   * DAGs. Absent = the export omits messages (empty array).
   */
  readonly conversationBinding?: ConversationBinding;
  /** Where a run's project is read, for the per-run checks (T243 A). */
  readonly runBinding?: RunBinding;
}

/** Bundle schema version — bump when the wire shape of `bundle.body` changes. */
/** 1.1.0 adds `callUsage`: the model calls' usage from the cost ledger, when the run has any. */
/** 1.2.0: `exportedAt` is in the signed body (was the envelope's only). */
/** 1.3.0 adds `stepUsage`: a flow record's model usage per step. */
const BUNDLE_SCHEMA_VERSION = '1.3.0';

export function provenanceRouter(
  binding: ProvenanceBinding,
  options: ProvenanceRouterOptions = {},
  /**
   * With one (T243 A): a run's provenance (and its export) needs `read`
   * on the run's project; the list holds only records whose project the
   * caller may read (the tenant, for one with no project).
   */
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  if (authorizer !== undefined) {
    // A run that isn't there is the handler's 404 (`read` on the tenant).
    // An id that isn't a run id is never looked up (its uuid cast would
    // fail the query as a 500).
    const onRunProject = async (c: Context<AppEnv>, next: Next) => {
      const tenantId = c.get('tenantId') as TenantId;
      const runId = c.req.param('runId') ?? '';
      const run = UUID_RE.test(runId)
        ? await options.runBinding?.getRun(tenantId, runId as RunId)
        : undefined;
      const at =
        run === undefined || run === null
          ? ref('tenant', tenantId as unknown as string)
          : ref('project', run.projectId as unknown as string);
      return authorizer.authorize('read', () => at)(c, next);
    };
    r.use('/:runId', async (c, next) => (c.req.method === 'GET' ? onRunProject(c, next) : next()));
    r.use('/:runId/export', onRunProject);
  }
  const exportSigning = options.exportSigning;

  // ---------- GET / (list metadata, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const rawCursor = c.req.query('cursor');
    let cursorFilter: ProvenanceListCursor | undefined;
    if (rawCursor !== undefined && rawCursor.length > 0) {
      const decoded = decodeCursor(rawCursor);
      if (decoded === null) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
        );
      }
      cursorFilter = { createdAt: decoded.createdAt, id: decoded.id };
    }

    const scopeParsed = parseListScope(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const runIdFilter = c.req.query('runId');
    const agentIdFilter = c.req.query('agentId');
    const flowIdFilter = c.req.query('flowId');
    const flowId =
      flowIdFilter !== undefined && flowIdFilter.length > 0 ? (flowIdFilter as FlowId) : undefined;
    const createdAfterRaw = c.req.query('createdAfter');

    let createdAfter: Date | undefined;
    if (createdAfterRaw !== undefined && createdAfterRaw.length > 0) {
      const parsed = parseTimeInput(createdAfterRaw);
      if (parsed === null) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`createdAfter` must be an ISO 8601 timestamp' },
            requestId,
          ),
        );
      }
      createdAfter = parsed;
    }

    const result = await binding.listRecords({
      tenantId,
      limit,
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(runIdFilter !== undefined && runIdFilter.length > 0 && { runId: runIdFilter as RunId }),
      ...(agentIdFilter !== undefined && agentIdFilter.length > 0 && { agentId: agentIdFilter }),
      ...(flowId !== undefined && { flowId }),
      ...(createdAfter !== undefined && { createdAfter }),
      ...(cursorFilter !== undefined && { cursor: cursorFilter }),
    });

    if (result.kind === 'err') {
      return readFailed(c, result.error, requestId);
    }
    const { records, nextCursor } = result.value;
    const hasMore = nextCursor !== undefined;
    const visible =
      authorizer === undefined
        ? records
        : await authorizer.filterByCan(c, 'read', records, (rec) =>
            rec.projectId !== undefined
              ? ref('project', rec.projectId as unknown as string)
              : ref('tenant', tenantId as unknown as string),
          );
    return c.json({
      data: visible.map(serializeRecordMetadata),
      hasMore,
      ...(nextCursor !== undefined && {
        nextCursor: encodeCursor({ createdAt: nextCursor.createdAt, id: nextCursor.id }),
      }),
      // Said on every page, an empty one too: the list holds only this flow's records.
      ...(flowId !== undefined && { flowId: flowId as unknown as string }),
    });
  });

  // ---------- GET /:runId (full DAG) ----------
  r.get('/:runId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;

    const result = await binding.getByRunId(tenantId, runId);
    if (result.kind === 'err') {
      if (result.error.code === 'provenance-not-found') {
        return provenanceNotFound(c, result.error, runId, requestId);
      }
      return readFailed(c, result.error, requestId);
    }
    const provenance = result.value;
    const callUsage = await readCallUsage(binding, tenantId, runId);
    if (callUsage.kind === 'err') {
      return readFailed(c, callUsage.error, requestId);
    }
    const stepUsage = await readStepUsage(binding, tenantId, provenance);
    if (stepUsage.kind === 'err') {
      return readFailed(c, stepUsage.error, requestId);
    }
    return c.json({
      id: provenance.id as unknown as string,
      runId: provenance.runId as unknown as string,
      tenantId: provenance.tenantId as unknown as string,
      version: provenance.version,
      createdAt: provenance.createdAt as unknown as string,
      ...(provenance.flowRef !== undefined && {
        flowRef: {
          id: provenance.flowRef.id as unknown as string,
          version: provenance.flowRef.version,
        },
      }),
      dag: {
        nodes: provenance.nodes,
        edges: provenance.edges,
      },
      ...(provenance.signature !== undefined && { signature: provenance.signature }),
      ...(callUsage.value !== undefined && { callUsage: callUsage.value }),
      ...(stepUsage.value !== undefined && { stepUsage: stepUsage.value }),
    });
  });

  // ---------- POST /:runId/export (signed bundle) ----------
  r.post('/:runId/export', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;

    if (exportSigning === undefined) return signingNotConfigured(c, 'signed provenance exports');

    const read = await readExportBody(c);
    const parsed = read.kind === 'ok' ? parseExportBody(read.value) : read;
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed.message }, requestId));
    }
    const { signingKeyId, includeMessages } = parsed.value;

    // 1. Load the DAG.
    const loaded = await binding.getByRunId(tenantId, runId);
    if (loaded.kind === 'err') {
      if (loaded.error.code === 'provenance-not-found') {
        return provenanceNotFound(c, loaded.error, runId, requestId);
      }
      c.status(statusFor(loaded.error.code) as never);
      return c.json(
        toWireError({ code: loaded.error.code, message: loaded.error.message }, requestId),
      );
    }
    const provenance = loaded.value;
    // The calls' usage as it stands now: the signature covers it.
    const callUsage = await readCallUsage(binding, tenantId, runId);
    if (callUsage.kind === 'err') {
      c.status(statusFor(callUsage.error.code) as never);
      return c.json(
        toWireError({ code: callUsage.error.code, message: callUsage.error.message }, requestId),
      );
    }
    const stepUsage = await readStepUsage(binding, tenantId, provenance);
    if (stepUsage.kind === 'err') {
      c.status(statusFor(stepUsage.error.code) as never);
      return c.json(
        toWireError({ code: stepUsage.error.code, message: stepUsage.error.message }, requestId),
      );
    }

    // 2. Optionally hydrate conversation messages. Agent turns use the
    //    conversation id as the run id; for flow-only runs no
    //    conversation exists and we return an empty `messages: []`
    //    field so the shape stays stable.
    let messages: readonly unknown[] | undefined;
    if (includeMessages) {
      if (options.conversationBinding === undefined) {
        // Reads require a ConversationBinding. When the route is wired
        // without one, fall back to the same stable-empty-shape used
        // for flow-only runs so response shape doesn't change.
        messages = [];
      } else {
        const msgResult = await options.conversationBinding.readMessages({
          tenantId,
          conversationId: runId as unknown as ConversationId,
        });
        messages = msgResult.kind === 'ok' ? msgResult.value : [];
      }
    }

    // 3. Sign the bundle body (and record the export).
    const signed = await signExport({
      signer: exportSigning,
      kind: 'provenance',
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      ...(signingKeyId !== undefined && { signingKeyId }),
      body: {
        provenanceId: provenance.id as unknown as string,
        runId: provenance.runId as unknown as string,
        tenantId: provenance.tenantId as unknown as string,
        version: provenance.version,
        createdAt: provenance.createdAt as unknown as string,
        ...(provenance.flowRef !== undefined && {
          flowRef: {
            id: provenance.flowRef.id as unknown as string,
            version: provenance.flowRef.version,
          },
        }),
        dag: {
          nodes: provenance.nodes,
          edges: provenance.edges,
        },
        ...(messages !== undefined && { messages }),
        ...(callUsage.value !== undefined && { callUsage: callUsage.value }),
        ...(stepUsage.value !== undefined && { stepUsage: stepUsage.value }),
      },
      ...(options.auditEvents !== undefined && {
        record: {
          auditEvents: options.auditEvents,
          tenantId,
          runId: runId as unknown as string,
          actor: exportActor(c),
          subject: { runId: runId as unknown as string },
        },
      }),
    });
    if (signed.kind === 'err') return signExportFailure(c, signed.error, 'export-key-error');
    return c.json({ runId: runId as unknown as string, ...signed.value });
  });

  return r;
}

// ============ helpers ============

interface RecordMetadata {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly version: string;
  readonly createdAt: string;
  readonly flowRef?: { readonly id: string; readonly version: string };
  readonly signed: boolean;
  readonly projectId?: string;
}

function serializeRecordMetadata(row: ProvenanceRecordSummary): RecordMetadata {
  return {
    id: row.id as unknown as string,
    runId: row.runId as unknown as string,
    tenantId: row.tenantId as unknown as string,
    version: row.version,
    createdAt: row.createdAt as unknown as string,
    ...(row.flowRef !== undefined && {
      flowRef: {
        id: row.flowRef.id as unknown as string,
        version: row.flowRef.version,
      },
    }),
    signed: row.signed,
    ...(row.projectId !== undefined && { projectId: row.projectId as unknown as string }),
  };
}

interface ValidatedExportBody {
  readonly signingKeyId: string | undefined;
  readonly includeMessages: boolean;
}

type ParseResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

function parseExportBody(body: Record<string, unknown>): ParseResult<ValidatedExportBody> {
  const signingKeyId = parseSigningKeyId(body);
  if (signingKeyId.kind === 'err') return signingKeyId;
  let includeMessages = false;
  if ('includeMessages' in body) {
    const im = body.includeMessages;
    if (typeof im !== 'boolean') {
      return { kind: 'err', message: 'Field `includeMessages` must be a boolean when present' };
    }
    includeMessages = im;
  }
  return { kind: 'ok', value: { signingKeyId: signingKeyId.value, includeMessages } };
}

/**
 * A read's binding error on the wire: `503 database-busy` with
 * `Retry-After` when the database was too busy for it (`databaseBusyAnswer`),
 * else the code's status with the code and message.
 */
function readFailed(
  c: Context<AppEnv>,
  error: ProvenanceBindingError,
  requestId: string,
): Response {
  const busy = databaseBusyAnswer(error, c);
  if (busy !== undefined) return busy;
  c.status(statusFor(error.code) as never);
  return c.json(toWireError({ code: error.code, message: error.message }, requestId));
}

/**
 * `404 provenance-not-found` with the run id and, when the binding says
 * why the run has no record yet, its `recordState` and `reason`.
 */
function provenanceNotFound(
  c: Context<AppEnv>,
  error: ProvenanceBindingError,
  runId: RunId,
  requestId: string,
): Response {
  c.status(statusFor('not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'provenance-not-found',
        message: error.message,
        runId: runId as unknown as string,
        ...(typeof error.recordState === 'string' && { recordState: error.recordState }),
        ...(typeof error.reason === 'string' && { reason: error.reason }),
      },
      requestId,
    ),
  );
}

/**
 * A flow record's usage per step, when the binding has a cost ledger and
 * the record has `step` nodes with usage. A turn's record has none, so
 * it's never read for one. Each step's row goes to the node that counts
 * its runs; a row the record has no node for (its step was cut with the
 * record's middle) is left out, so the steps' sum can be less than the
 * run's.
 */
async function readStepUsage(
  binding: ProvenanceBinding,
  tenantId: TenantId,
  provenance: Pick<Provenance, 'runId' | 'nodes'>,
): Promise<
  | { readonly kind: 'ok'; readonly value: StepUsageByNodeId | undefined }
  | { readonly kind: 'err'; readonly error: ProvenanceBindingError }
> {
  if (binding.getStepUsage === undefined) return { kind: 'ok', value: undefined };
  if (!provenance.nodes.some((n) => n.kind === 'step')) return { kind: 'ok', value: undefined };
  const read = await binding.getStepUsage(tenantId, provenance.runId);
  if (read.kind === 'err') return read;
  const place = stepNodePlacer(provenance.nodes);
  const byNode = new Map<string, StepUsage>();
  for (const row of read.value) {
    const node = place(row);
    if (node !== undefined) byNode.set(node, addUsage(byNode.get(node), row));
  }
  return { kind: 'ok', value: byNode.size > 0 ? Object.fromEntries(byNode) : undefined };
}

function addUsage(sum: StepUsage | undefined, row: StepRunsUsage): StepUsage {
  if (sum === undefined) return { calls: row.calls, costUsd: row.costUsd, tokens: row.tokens };
  return {
    calls: sum.calls + row.calls,
    costUsd: sum.costUsd + row.costUsd,
    tokens: {
      prompt: sum.tokens.prompt + row.tokens.prompt,
      completion: sum.tokens.completion + row.tokens.completion,
      cacheRead: sum.tokens.cacheRead + row.tokens.cacheRead,
      cacheWrite: sum.tokens.cacheWrite + row.tokens.cacheWrite,
      reasoning: sum.tokens.reasoning + row.tokens.reasoning,
    },
  };
}

/** The run's call usage, when the binding has a cost ledger and the run made calls. */
async function readCallUsage(
  binding: ProvenanceBinding,
  tenantId: TenantId,
  runId: RunId,
): Promise<
  | { readonly kind: 'ok'; readonly value: CallUsageByCallId | undefined }
  | { readonly kind: 'err'; readonly error: ProvenanceBindingError }
> {
  if (binding.getCallUsage === undefined) return { kind: 'ok', value: undefined };
  const read = await binding.getCallUsage(tenantId, runId);
  if (read.kind === 'err') return read;
  return { kind: 'ok', value: Object.keys(read.value).length > 0 ? read.value : undefined };
}
