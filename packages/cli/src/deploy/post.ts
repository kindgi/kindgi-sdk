// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/deployments` wire adapter. Two exports:
 *
 *   - `buildPostBody(envelope)` — strips `tenantId` + `$schema` +
 *     `buildLogsUrl` from the envelope; the server derives `tenantId`
 *     from the bearer token and returns 400 signature-invalid if the
 *     signed envelope's tenantId doesn't match. `buildLogsUrl` is CLI-
 *     local metadata, not part of the wire contract.
 *
 *   - `deriveIdempotencyKey(body)` — `sha256:<hex>` over the
 *     canonicalised POST body; matches every other hash shape in the
 *     codebase. Callers can override via
 *     `--idempotency-key <str>` for CI re-runs that manage keys
 *     externally.
 *
 *   - `postDeploymentReal(opts)` — the production runner: does the
 *     actual HTTP POST via the caller-supplied `fetchImpl`, parses the
 *     server's response, discriminates 201 / 200 / 4xx / 5xx.
 */

import { createHash } from 'node:crypto';

import { stableStringify } from '../build/envelope.js';
import type { DeployEnvelope } from '../build/envelope.js';
import type {
  DeploymentRecord,
  PostDeploymentBody,
  PostDeploymentOptions,
  PostDeploymentResult,
  SyncSecretsBody,
  SyncSecretsOptions,
  SyncSecretsResult,
  SyncSecretsSuccess,
} from './runners.js';

/**
 * Build the exact wire body per
 * `packages/api/src/openapi/schemas.ts:3141` — the
 * `DeploymentRegistrationBodySchema`. `tenantId` is deliberately
 * absent (server-derived from the token); the envelope's signature
 * covers it via re-canonicalisation on the server.
 *
 * `$schema` (envelope-side namespace pin) and `buildLogsUrl` (build-
 * server URL, only useful for humans debugging failed builds) are
 * client-side metadata — not part of the deployment wire contract.
 */
export function buildPostBody(envelope: DeployEnvelope): PostDeploymentBody {
  if (
    envelope.signerKeyId === undefined ||
    envelope.signerPublicKey === undefined ||
    envelope.signature === undefined
  ) {
    // Should not happen — the caller pre-validates via `isEnvelopeSigned`.
    // We throw here (as opposed to returning Result) because it's a
    // programmer error, not user error.
    throw new Error(
      'buildPostBody() called on an unsigned envelope. Check with `isEnvelopeSigned` first.',
    );
  }
  return {
    imageRef: envelope.imageRef,
    artifactVersion: envelope.artifactVersion,
    index: envelope.index,
    indexHash: envelope.indexHash,
    signerKeyId: envelope.signerKeyId,
    signerPublicKey: envelope.signerPublicKey,
    signature: envelope.signature,
    publishedAt: envelope.publishedAt,
  };
}

/**
 * `sha256:<hex>` over the canonical (sorted-key, no-whitespace) JSON
 * representation of the wire body. Matches the sha256 shape every other hash in the framework uses.
 *
 * The idempotency middleware on `packages/api` caches the full HTTP
 * response by `(tenantId, Idempotency-Key)`. Same body → same key →
 * same cached response (201 or 200-replay). Different body + same
 * key → server returns `idempotency-key-conflict`.
 */
export function deriveIdempotencyKey(body: PostDeploymentBody): string {
  const canonical = stableStringify(body);
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Production `postDeployment` runner. Executes the HTTP POST, parses
 * the response, discriminates the outcome. Tests substitute this whole
 * function via `DeployRunners.postDeployment` to keep the wire
 * synthetic.
 */
export async function postDeploymentReal(
  opts: PostDeploymentOptions,
): Promise<PostDeploymentResult> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/deployments`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': opts.idempotencyKey,
      },
      body: JSON.stringify(opts.body),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    return {
      kind: 'transport-error',
      message: `POST ${url} failed: ${(err as Error).message}`,
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — treat as transport-level failure.
    return {
      kind: 'transport-error',
      message: `POST ${url} returned HTTP ${res.status} with non-JSON body`,
    };
  }

  const replay = res.headers.get('x-idempotent-replay') === 'true' && { idempotentReplay: true };
  if (res.status === 201) {
    return {
      kind: 'created',
      status: 201,
      record: body as DeploymentRecord,
      ...replay,
    };
  }
  if (res.status === 200) {
    return {
      kind: 'replayed',
      status: 200,
      record: body as DeploymentRecord,
      ...replay,
    };
  }

  // 4xx / 5xx — the api-server wraps errors in `{ error: { code,
  // message, ...details } }` via `toWireError` in
  // `packages/api/src/errors.ts`.
  const wire = body as { error?: { code?: string; message?: string } } | null;
  const code = wire?.error?.code ?? `http-${res.status}`;
  const message = wire?.error?.message ?? `HTTP ${res.status}`;
  const details = extractDetails(wire?.error);
  return {
    kind: 'wire-error',
    status: res.status,
    ...replay,
    error: { code, message, ...(details !== undefined && { details }) },
  };
}

function extractDetails(
  err: { [k: string]: unknown } | undefined,
): readonly Record<string, unknown>[] | undefined {
  if (err === undefined) return undefined;
  const issues = (err as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    return issues as readonly Record<string, unknown>[];
  }
  return undefined;
}

/**
 * Derive the Idempotency-Key for a sync-secrets POST. Same shape as
 * `deriveIdempotencyKey` for deployments (sha256 of canonical body) —
 * so a re-run of the same deploy with the same `.env.<envName>` sends
 * the same key and the server middleware caches the response.
 */
export function deriveSyncSecretsIdempotencyKey(
  deploymentId: string,
  body: SyncSecretsBody,
): string {
  const canonical = stableStringify({ deploymentId, ...body });
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Production `syncSecrets` runner. Executes
 * `POST /v1/deployments/:deploymentId/secrets` — the wire body carries
 * plaintext `value` entries at the developer boundary; the server
 * responds with references only. Errors surface as `wire-error` (with
 * the server's error code preserved for the CLI banner) or
 * `transport-error`.
 */
export async function syncSecretsReal(opts: SyncSecretsOptions): Promise<SyncSecretsResult> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/deployments/${encodeURIComponent(opts.deploymentId)}/secrets`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': opts.idempotencyKey,
      },
      body: JSON.stringify(opts.body),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    return {
      kind: 'transport-error',
      message: `POST ${url} failed: ${(err as Error).message}`,
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return {
      kind: 'transport-error',
      message: `POST ${url} returned HTTP ${res.status} with non-JSON body`,
    };
  }

  if (res.status === 200) {
    return {
      kind: 'ok',
      status: 200,
      response: body as SyncSecretsSuccess,
    };
  }

  const wire = body as { error?: { code?: string; message?: string } } | null;
  return {
    kind: 'wire-error',
    status: res.status,
    error: {
      code: wire?.error?.code ?? `http-${res.status}`,
      message: wire?.error?.message ?? `HTTP ${res.status}`,
    },
  };
}
