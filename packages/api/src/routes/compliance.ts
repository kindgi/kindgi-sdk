// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { AuditEvent, AuditEventBinding, AuditEventFilter } from '@kindgi/audit-events';
import type {
  ComplianceEvidence,
  ComplianceEvidenceGenerator,
  EvidenceFilter,
  LoadedClassifier,
} from '@kindgi/compliance';
import { auditEventToEvidence } from '@kindgi/compliance';
import type { SigningKeyBinding } from '@kindgi/crypto';
import type {
  AgentId,
  ComplianceEvidenceId,
  FlowId,
  RunId,
  SigningKeyId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { tenantAdminAccess } from './tenant-access.js';

/**
 * Compliance-evidence readback + signed-export routes over the unified
 * audit substrate.
 *
 * List + get read audit events via `AuditEventBinding`, filtered to
 * classifier-marked exportable kinds. Signed export
 * delegates to the generator bound to the same substrate + the
 * caller-plugged `SigningKeyBinding` — verifiers reuse the identical
 * Ed25519 envelope the provenance + audit-bundle surfaces produce.
 *
 * Every route is tenant-scoped via the bearer middleware upstream; the
 * binding is threaded `tenantId` explicitly so its own storage layer
 * enforces cross-tenant isolation redundantly. Idempotency-Key applies
 * to the export mutation (same shape every other export route follows).
 */
export interface ComplianceRouterOptions {
  readonly auditEvents: AuditEventBinding;
  readonly classifier: LoadedClassifier;
  readonly signingKey?: SigningKeyBinding;
  /**
   * Caller-plugged evidence generator. Supplied at app-composition
   * time by the host (the Kindgi runtime provides one). Kept
   * required — signed export routes cannot run without it, and the
   * route mount guards (auditEvents + classifier) already imply
   * signed-export capability.
   */
  readonly complianceGenerator: ComplianceEvidenceGenerator;
}

export function complianceRouter(
  options: ComplianceRouterOptions,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Evidence across the tenant, as the audit routes: an admin's.
  r.use('*', tenantAdminAccess(authorizer));
  const { auditEvents, classifier, signingKey, complianceGenerator } = options;

  const isExportable = (kind: string): boolean => classifier.resolve(kind).exportable;
  const exportableKinds = (): readonly string[] =>
    Object.keys(classifier.file.byKind).filter(isExportable);

  // ---------- GET /evidence (list, cursor-paginated) ----------
  r.get('/evidence', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const rawCursor = c.req.query('cursor');
    const cursor = rawCursor !== undefined && rawCursor.length > 0 ? rawCursor : undefined;

    const parsedFilter = parseFilterFromQuery(c.req.query());
    if (parsedFilter.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsedFilter.message }, requestId));
    }
    const auditFilter = buildAuditFilter(parsedFilter.value, exportableKinds());
    if (auditFilter === null) {
      // Kind filter narrowed to a non-exportable kind — surface empty.
      return c.json({ data: [], hasMore: false });
    }

    const page = await auditEvents.query({
      tenantId,
      filter: auditFilter,
      ...(cursor !== undefined && { cursor }),
      limit,
    });
    if (page.kind === 'err') {
      if (page.error.code === 'invalid-cursor') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: `Malformed cursor: ${page.error.message}` },
            requestId,
          ),
        );
      }
      c.status(statusFor('persistence-error') as never);
      return c.json(
        toWireError(
          {
            code: 'persistence-error',
            message: `Failed to list compliance evidence: ${page.error.message}`,
          },
          requestId,
        ),
      );
    }

    // Post-filter to exportable kinds (defensive — in case a binding
    // does not apply the `kinds` filter).
    const filtered = page.value.data.filter((e) => isExportable(e.kind));
    return c.json({
      data: filtered.map(serializeEvent),
      hasMore: page.value.nextCursor !== undefined,
      ...(page.value.nextCursor !== undefined && { nextCursor: page.value.nextCursor }),
    });
  });

  // ---------- GET /evidence/:evidenceId ----------
  r.get('/evidence/:evidenceId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const evidenceId = c.req.param('evidenceId');

    const fetched = await auditEvents.query({
      tenantId,
      filter: { id: evidenceId },
      limit: 2,
    });
    if (fetched.kind === 'err') {
      c.status(statusFor('persistence-error') as never);
      return c.json(
        toWireError(
          {
            code: 'persistence-error',
            message: `Failed to fetch compliance evidence: ${fetched.error.message}`,
          },
          requestId,
        ),
      );
    }
    const hit = fetched.value.data.find((e) => e.id === evidenceId && isExportable(e.kind));
    if (hit === undefined) {
      c.status(statusFor('compliance-evidence-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'compliance-evidence-not-found',
            message: `No evidence record with id "${evidenceId}" under this tenant.`,
            evidenceId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeEvent(hit));
  });

  // ---------- POST /evidence/export (signed bundle) ----------
  r.post('/evidence/export', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    if (signingKey === undefined) {
      c.status(statusFor('signing-not-configured') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-not-configured',
            message:
              'This deployment does not have a `signingKey` binding mounted; signed compliance exports are unavailable.',
          },
          requestId,
        ),
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const parsed = parseExportBody(body as Record<string, unknown>);
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed.message }, requestId));
    }
    const { signingKeyId } = parsed.value;
    // The bundle carries exportable kinds only: a named non-exportable
    // kind is rejected below; without one, the classifier's exportable
    // kinds are passed down (and recorded in the signed bundle's filter).
    const filter =
      parsed.value.filter.evidenceKind !== undefined
        ? parsed.value.filter
        : { ...parsed.value.filter, evidenceKinds: exportableKinds() };
    if (
      filter.evidenceKind !== undefined &&
      !isExportable(filter.evidenceKind as unknown as string)
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Kind "${filter.evidenceKind as unknown as string}" is not marked exportable by the classifier`,
          },
          requestId,
        ),
      );
    }

    const generator = complianceGenerator;
    const bundle = await generator.exportSigned(tenantId, filter, signingKeyId);
    if (bundle.kind === 'err') {
      const err = bundle.error;
      if (err.code === 'signing-key-missing') {
        c.status(statusFor('signing-key-not-found') as never);
        return c.json(
          toWireError(
            {
              code: 'signing-key-not-found',
              message: err.message,
              signingKeyId: err.signingKeyId as unknown as string,
            },
            requestId,
          ),
        );
      }
      if (err.code === 'signing-failure') {
        c.status(statusFor('compliance-export-failed') as never);
        return c.json(
          toWireError(
            {
              code: 'compliance-export-failed',
              message: err.message,
              signingKeyId: err.signingKeyId as unknown as string,
            },
            requestId,
          ),
        );
      }
      if (err.code === 'persistence-error') {
        c.status(statusFor('persistence-error') as never);
        return c.json(toWireError({ code: 'persistence-error', message: err.message }, requestId));
      }
      c.status(statusFor('compliance-export-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'compliance-export-failed',
            message: `Signed export failed: ${(err as { readonly message: string }).message}`,
          },
          requestId,
        ),
      );
    }
    return c.json(bundle.value);
  });

  return r;
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

type ParseResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

function parseFilterFromQuery(
  query: Readonly<Record<string, string | undefined>>,
): ParseResult<EvidenceFilter | undefined> {
  const filter: {
    runId?: RunId;
    agentId?: AgentId;
    flowId?: FlowId;
    evidenceKind?: EvidenceFilter['evidenceKind'];
    from?: Timestamp;
    to?: Timestamp;
  } = {};
  const runId = query.runId;
  if (runId !== undefined && runId.length > 0) filter.runId = runId as unknown as RunId;
  const agentId = query.agentId;
  if (agentId !== undefined && agentId.length > 0) filter.agentId = agentId as unknown as AgentId;
  const flowId = query.flowId;
  if (flowId !== undefined && flowId.length > 0) filter.flowId = flowId as unknown as FlowId;
  const kind = query.kind;
  if (kind !== undefined && kind.length > 0) {
    filter.evidenceKind = kind as unknown as EvidenceFilter['evidenceKind'];
  }
  const from = query.from;
  if (from !== undefined && from.length > 0) {
    const parsed = new Date(from);
    if (Number.isNaN(parsed.getTime())) {
      return { kind: 'err', message: '`from` must be an ISO 8601 timestamp' };
    }
    filter.from = parsed.toISOString() as Timestamp;
  }
  const to = query.to;
  if (to !== undefined && to.length > 0) {
    const parsed = new Date(to);
    if (Number.isNaN(parsed.getTime())) {
      return { kind: 'err', message: '`to` must be an ISO 8601 timestamp' };
    }
    filter.to = parsed.toISOString() as Timestamp;
  }
  const empty = Object.keys(filter).length === 0;
  return { kind: 'ok', value: empty ? undefined : (filter as EvidenceFilter) };
}

/**
 * Build the `AuditEventFilter` used against the binding. Returns
 * `null` when the caller's `evidenceKind` is not exportable — the
 * route short-circuits to an empty page in that case (rather than
 * inventing a filter that would return non-exportable rows).
 */
function buildAuditFilter(
  filter: EvidenceFilter | undefined,
  exportable: readonly string[],
): AuditEventFilter | null {
  const out: {
    -readonly [K in keyof AuditEventFilter]: AuditEventFilter[K];
  } = {};
  if (filter?.evidenceKind !== undefined) {
    const k = filter.evidenceKind as unknown as string;
    if (!exportable.includes(k)) return null;
    out.kind = k;
  } else {
    out.kinds = exportable;
  }
  if (filter?.runId !== undefined) out.runId = filter.runId as unknown as string;
  if (filter?.agentId !== undefined) out.agentId = filter.agentId as unknown as string;
  if (filter?.flowId !== undefined) out.flowId = filter.flowId as unknown as string;
  if (filter?.from !== undefined) out.from = filter.from as unknown as string;
  if (filter?.to !== undefined) out.to = filter.to as unknown as string;
  return out as AuditEventFilter;
}

interface ValidatedExportBody {
  readonly signingKeyId: SigningKeyId;
  readonly filter: EvidenceFilter;
}

function parseExportBody(body: Record<string, unknown>): ParseResult<ValidatedExportBody> {
  const rawKey = body.signingKeyId;
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    return { kind: 'err', message: 'Field `signingKeyId` must be a non-empty string' };
  }
  const filterRaw = body.filter;
  if (
    filterRaw !== undefined &&
    (filterRaw === null || typeof filterRaw !== 'object' || Array.isArray(filterRaw))
  ) {
    return { kind: 'err', message: 'Field `filter` must be an object when present' };
  }
  const parsedFilter = parseFilterFromBody((filterRaw ?? {}) as Record<string, unknown>);
  if (parsedFilter.kind === 'err') return parsedFilter;
  return {
    kind: 'ok',
    value: {
      signingKeyId: rawKey as SigningKeyId,
      filter: parsedFilter.value ?? {},
    },
  };
}

function parseFilterFromBody(
  body: Record<string, unknown>,
): ParseResult<EvidenceFilter | undefined> {
  const filter: {
    runId?: RunId;
    agentId?: AgentId;
    flowId?: FlowId;
    evidenceKind?: EvidenceFilter['evidenceKind'];
    from?: Timestamp;
    to?: Timestamp;
  } = {};
  const runId = body.runId;
  if (runId !== undefined) {
    if (typeof runId !== 'string' || runId.length === 0) {
      return { kind: 'err', message: '`filter.runId` must be a non-empty string' };
    }
    filter.runId = runId as unknown as RunId;
  }
  const agentId = body.agentId;
  if (agentId !== undefined) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      return { kind: 'err', message: '`filter.agentId` must be a non-empty string' };
    }
    filter.agentId = agentId as unknown as AgentId;
  }
  const flowId = body.flowId;
  if (flowId !== undefined) {
    if (typeof flowId !== 'string' || flowId.length === 0) {
      return { kind: 'err', message: '`filter.flowId` must be a non-empty string' };
    }
    filter.flowId = flowId as unknown as FlowId;
  }
  const kind = body.kind;
  if (kind !== undefined) {
    if (typeof kind !== 'string' || kind.length === 0) {
      return { kind: 'err', message: '`filter.kind` must be a non-empty string' };
    }
    filter.evidenceKind = kind as unknown as EvidenceFilter['evidenceKind'];
  }
  const from = body.from;
  if (from !== undefined) {
    if (typeof from !== 'string' || Number.isNaN(new Date(from).getTime())) {
      return { kind: 'err', message: '`filter.from` must be an ISO 8601 timestamp' };
    }
    filter.from = new Date(from).toISOString() as Timestamp;
  }
  const to = body.to;
  if (to !== undefined) {
    if (typeof to !== 'string' || Number.isNaN(new Date(to).getTime())) {
      return { kind: 'err', message: '`filter.to` must be an ISO 8601 timestamp' };
    }
    filter.to = new Date(to).toISOString() as Timestamp;
  }
  const empty = Object.keys(filter).length === 0;
  return { kind: 'ok', value: empty ? undefined : (filter as EvidenceFilter) };
}

interface WireEvidence {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly kind: string;
  readonly timestamp: string;
  readonly actor?: unknown;
  readonly subject?: unknown;
  readonly outcome?: unknown;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provenanceRef?: unknown;
  readonly signature?: unknown;
}

/**
 * Serialize an `AuditEvent` into the wire shape the compliance
 * consumers expect. Wraps `auditEventToEvidence` so clients that read
 * `ComplianceEvidence` see exactly the `ComplianceEvidence` shape.
 */
function serializeEvent(event: AuditEvent): WireEvidence {
  return serializeEvidence(auditEventToEvidence(event));
}

function serializeEvidence(e: ComplianceEvidence): WireEvidence {
  const out: Record<string, unknown> = {
    id: e.id as unknown as string,
    tenantId: e.tenantId as unknown as string,
    kind: e.kind,
    timestamp: e.timestamp as unknown as string,
    payload: e.payload,
  };
  if (e.projectId !== undefined) out.projectId = e.projectId as unknown as string;
  if (e.actor !== undefined) out.actor = e.actor;
  if (e.subject !== undefined) out.subject = e.subject;
  if (e.outcome !== undefined) out.outcome = e.outcome;
  if (e.provenanceRef !== undefined) out.provenanceRef = e.provenanceRef;
  if (e.signature !== undefined) out.signature = e.signature;
  return out as unknown as WireEvidence;
}

// Kept for potential downstream use — the id path lookup returns
// `evidenceId` param verbatim; module consumers may rely on these
// re-exports.
export type { ComplianceEvidenceId };
