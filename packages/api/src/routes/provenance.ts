// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { ConversationBinding } from '@kindgi/agents';
import { serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import type { SigningKeyBinding } from '@kindgi/crypto';
import { canonicalize } from '@kindgi/schema';
import type { ConversationId, RunId, SigningKeyId, TenantId, Timestamp } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';

import type {
  ProvenanceBinding,
  ProvenanceListCursor,
  ProvenanceRecordSummary,
} from '../provenance-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

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
  readonly signingKey?: SigningKeyBinding;
  /**
   * Conversation binding used by the signed-export path to read
   * conversation transcripts (`readMessages`) alongside provenance
   * DAGs. Absent = the export omits messages (empty array).
   */
  readonly conversationBinding?: ConversationBinding;
}

/** Bundle schema version — bump when the wire shape of `bundle.body` changes. */
const BUNDLE_SCHEMA_VERSION = '1.0.0';

export function provenanceRouter(
  binding: ProvenanceBinding,
  options: ProvenanceRouterOptions = {},
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const signingKey = options.signingKey;

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

    const runIdFilter = c.req.query('runId');
    const agentIdFilter = c.req.query('agentId');
    const createdAfterRaw = c.req.query('createdAfter');

    let createdAfter: Date | undefined;
    if (createdAfterRaw !== undefined && createdAfterRaw.length > 0) {
      const parsed = new Date(createdAfterRaw);
      if (Number.isNaN(parsed.getTime())) {
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
      ...(runIdFilter !== undefined && runIdFilter.length > 0 && { runId: runIdFilter as RunId }),
      ...(agentIdFilter !== undefined && agentIdFilter.length > 0 && { agentId: agentIdFilter }),
      ...(createdAfter !== undefined && { createdAfter }),
      ...(cursorFilter !== undefined && { cursor: cursorFilter }),
    });

    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message }, requestId),
      );
    }
    const { records, nextCursor } = result.value;
    const hasMore = nextCursor !== undefined;
    return c.json({
      data: records.map(serializeRecordMetadata),
      hasMore,
      ...(nextCursor !== undefined && {
        nextCursor: encodeCursor({ createdAt: nextCursor.createdAt, id: nextCursor.id }),
      }),
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
        c.status(statusFor('not-found') as never);
        return c.json(
          toWireError(
            {
              code: 'provenance-not-found',
              message: result.error.message,
              runId: runId as unknown as string,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message }, requestId),
      );
    }
    const provenance = result.value;
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
    });
  });

  // ---------- POST /:runId/export (signed bundle) ----------
  r.post('/:runId/export', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const runId = c.req.param('runId') as RunId;

    if (signingKey === undefined) {
      c.status(statusFor('signing-not-configured') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-not-configured',
            message:
              'This deployment does not have a `signingKey` binding mounted; signed provenance exports are unavailable.',
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
    const { signingKeyId, includeMessages } = parsed.value;

    // 1. Load the DAG.
    const loaded = await binding.getByRunId(tenantId, runId);
    if (loaded.kind === 'err') {
      if (loaded.error.code === 'provenance-not-found') {
        c.status(statusFor('not-found') as never);
        return c.json(
          toWireError(
            {
              code: 'provenance-not-found',
              message: loaded.error.message,
              runId: runId as unknown as string,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor(loaded.error.code) as never);
      return c.json(
        toWireError({ code: loaded.error.code, message: loaded.error.message }, requestId),
      );
    }
    const provenance = loaded.value;

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

    // 3. Look up the private key material.
    const privateKey = signingKey.getPrivateKey(signingKeyId);
    if (privateKey === null) {
      c.status(statusFor('signing-key-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-key-not-found',
            message: `No signing key registered with id "${signingKeyId as unknown as string}"`,
            signingKeyId: signingKeyId as unknown as string,
          },
          requestId,
        ),
      );
    }
    const publicKeyRaw = signingKey.getPublicKey(signingKeyId);
    if (publicKeyRaw === null) {
      // Contract: `getPublicKey` never returns null for a key that
      // `getPrivateKey` resolved. Treat mismatch as a binding bug.
      c.status(statusFor('signing-key-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-key-not-found',
            message: `Signing key "${signingKeyId as unknown as string}" resolved a private key but no public key`,
            signingKeyId: signingKeyId as unknown as string,
          },
          requestId,
        ),
      );
    }

    // 4. Build the canonical bundle body. Bundle shape is v1.0.0 —
    //    ordering here is irrelevant for signing (canonicalize sorts
    //    keys) but declared explicitly for reviewer scanability.
    const bundleBody = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
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
    };
    const canonicalBundleBytes = new TextEncoder().encode(canonicalize(bundleBody));

    // 5. Sign the canonical bytes.
    const signResult = signEd25519(privateKey, canonicalBundleBytes);
    if (signResult.kind === 'err') {
      c.status(statusFor('export-key-error') as never);
      return c.json(
        toWireError(
          {
            code: 'export-key-error',
            message: `Failed to sign provenance bundle: ${signResult.error.message}`,
          },
          requestId,
        ),
      );
    }

    // 6. Emit the signed envelope. `bundle` is a base64 of the exact
    //    bytes that were signed — verifiers decode + re-canonicalize
    //    is unnecessary, they can verify against `atob(bundle)`
    //    directly.
    const exportedAt = new Date().toISOString() as Timestamp;
    return c.json({
      runId: runId as unknown as string,
      bundle: Buffer.from(canonicalBundleBytes).toString('base64'),
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      algorithm: 'ed25519' as const,
      signingKeyId: signingKeyId as unknown as string,
      signature: Buffer.from(signResult.value).toString('base64'),
      publicKey: serializePublicKeyPem(publicKeyRaw),
      canonicalization: 'sorted-key-json' as const,
      exportedAt: exportedAt as unknown as string,
    });
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
  };
}

interface ValidatedExportBody {
  readonly signingKeyId: SigningKeyId;
  readonly includeMessages: boolean;
}

type ParseResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

function parseExportBody(body: Record<string, unknown>): ParseResult<ValidatedExportBody> {
  const raw = body.signingKeyId;
  if (typeof raw !== 'string' || raw.length === 0) {
    return { kind: 'err', message: 'Field `signingKeyId` must be a non-empty string' };
  }
  let includeMessages = false;
  if ('includeMessages' in body) {
    const im = body.includeMessages;
    if (typeof im !== 'boolean') {
      return { kind: 'err', message: 'Field `includeMessages` must be a boolean when present' };
    }
    includeMessages = im;
  }
  return {
    kind: 'ok',
    value: {
      signingKeyId: raw as SigningKeyId,
      includeMessages,
    },
  };
}
