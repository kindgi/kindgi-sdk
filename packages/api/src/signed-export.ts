// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Signed exports: one envelope and one signing path for the three
 * exports a deployment signs (an approval's audit bundle, a run's
 * provenance, compliance evidence).
 *
 * The envelope carries the exact bytes that were signed (`bundle`,
 * base64 of the sorted-key JSON body), so a verifier checks those bytes
 * and never re-serializes anything. `exportedAt` is inside the signed
 * body, and the envelope's copy is the same value.
 *
 * Each export is recorded as an `export-signed` audit event (who, what,
 * which key, the bundle's SHA-256) when the app has an audit-event
 * binding. Recording comes before the bundle is returned: a bundle the
 * record couldn't be written for isn't handed out.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { ExportSigningBinding, ExportSigningError } from '@kindgi/crypto';
import { canonicalize } from '@kindgi/schema';
import type { ProjectId, TenantId, Timestamp } from '@kindgi/types';
import type { Context } from 'hono';

import { statusFor, toWireError } from './errors.js';
import type { AppEnv } from './types.js';

export type SignedExportKind = 'audit-bundle' | 'provenance' | 'compliance';

/** The audit-event kind each signed export is recorded under. */
export const EXPORT_SIGNED_EVENT_KIND = 'export-signed';

/** What every signed export answers, before its subject field (`approvalId`, `runId`, `tenantId`). */
export interface SignedExportEnvelope {
  readonly kind: SignedExportKind;
  /** Base64 of the signed bytes: the body, as sorted-key JSON. */
  readonly bundle: string;
  readonly bundleSchemaVersion: string;
  readonly algorithm: 'ed25519';
  readonly signingKeyId: string;
  /** Base64 of the 64-byte Ed25519 signature over the `bundle` bytes. */
  readonly signature: string;
  /** The signing key's public half, PEM SPKI. Check it against `GET /v1/export-signing-keys`. */
  readonly publicKey: string;
  readonly canonicalization: 'sorted-key-json';
  /** The same instant as the signed body's `exportedAt`. */
  readonly exportedAt: string;
}

export interface SignExportInput {
  readonly signer: ExportSigningBinding;
  readonly kind: SignedExportKind;
  readonly bundleSchemaVersion: string;
  /** The body without `bundleSchemaVersion` and `exportedAt`: both are added, and signed. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly signingKeyId?: string;
  readonly now?: () => Date;
  /** Record the export (an `export-signed` audit event) before answering. */
  readonly record?: {
    readonly auditEvents: AuditEventBinding;
    readonly tenantId: TenantId;
    readonly projectId?: ProjectId;
    readonly runId?: string;
    readonly actor: string;
    /** The exported thing: `{ approvalId }`, `{ runId }`, or the compliance filter. */
    readonly subject: Readonly<Record<string, unknown>>;
  };
}

export type SignExportError =
  | ExportSigningError
  | { readonly code: 'persistence-error'; readonly message: string };

/** Sign an export's body and, when asked, record it. */
export async function signExport(
  input: SignExportInput,
): Promise<
  | { readonly kind: 'ok'; readonly value: SignedExportEnvelope }
  | { readonly kind: 'err'; readonly error: SignExportError }
> {
  const exportedAt = (input.now?.() ?? new Date()).toISOString();
  const body = { ...input.body, bundleSchemaVersion: input.bundleSchemaVersion, exportedAt };
  const bytes = new TextEncoder().encode(canonicalize(body));
  const signed = await input.signer.sign(
    bytes,
    input.signingKeyId !== undefined ? { keyId: input.signingKeyId } : undefined,
  );
  if (signed.kind === 'err') return signed;
  const envelope: SignedExportEnvelope = {
    kind: input.kind,
    bundle: Buffer.from(bytes).toString('base64'),
    bundleSchemaVersion: input.bundleSchemaVersion,
    algorithm: 'ed25519',
    signingKeyId: signed.value.key.keyId,
    signature: Buffer.from(signed.value.signature).toString('base64'),
    publicKey: signed.value.key.publicKeyPem,
    canonicalization: 'sorted-key-json',
    exportedAt,
  };
  if (input.record !== undefined) {
    const recorded = await recordExport(input.record, envelope, bytes);
    if (recorded !== undefined) return { kind: 'err', error: recorded };
  }
  return { kind: 'ok', value: envelope };
}

async function recordExport(
  record: NonNullable<SignExportInput['record']>,
  envelope: SignedExportEnvelope,
  bytes: Uint8Array,
): Promise<SignExportError | undefined> {
  const event: AuditEvent = {
    id: randomUUID(),
    tenantId: record.tenantId,
    ...(record.projectId !== undefined && { projectId: record.projectId }),
    kind: EXPORT_SIGNED_EVENT_KIND,
    timestamp: envelope.exportedAt as unknown as Timestamp,
    actor: record.actor,
    ...(record.runId !== undefined && { runId: record.runId }),
    outcome: 'succeeded',
    payload: {
      v: 1,
      doc: {
        exportKind: envelope.kind,
        subject: record.subject,
        signingKeyId: envelope.signingKeyId,
        bundleSha256: createHash('sha256').update(bytes).digest('hex'),
        bundleSchemaVersion: envelope.bundleSchemaVersion,
        exportedAt: envelope.exportedAt,
      },
    },
  };
  const appended = await record.auditEvents.append([event]);
  if (appended.kind === 'ok') return undefined;
  return {
    code: 'persistence-error',
    message: `The export was signed, but recording it failed, so it isn't returned: ${appended.error.message}. Try again.`,
  };
}

/**
 * An export request's body: JSON, an object, or nothing at all (read as
 * `{}`, so `curl -X POST` and a bodiless POST work).
 */
export async function readExportBody(
  c: Context<AppEnv>,
): Promise<
  | { readonly kind: 'ok'; readonly value: Record<string, unknown> }
  | { readonly kind: 'err'; readonly message: string }
> {
  const text = await c.req.text();
  if (text.trim() === '') return { kind: 'ok', value: {} };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'err', message: 'Request body must be valid JSON' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', message: 'Request body must be an object' };
  }
  return { kind: 'ok', value: body as Record<string, unknown> };
}

/** `signingKeyId`, when the body names one: a non-empty string. */
export function parseSigningKeyId(
  body: Readonly<Record<string, unknown>>,
):
  | { readonly kind: 'ok'; readonly value: string | undefined }
  | { readonly kind: 'err'; readonly message: string } {
  if (!('signingKeyId' in body) || body.signingKeyId === undefined) {
    return { kind: 'ok', value: undefined };
  }
  const raw = body.signingKeyId;
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      kind: 'err',
      message:
        'Field `signingKeyId` must be a non-empty string when present; leave it out to sign with the active key.',
    };
  }
  return { kind: 'ok', value: raw };
}

/** `404 signing-not-configured`: this deployment has no export signing key. */
export function signingNotConfigured(c: Context<AppEnv>, what: string): Response {
  c.status(statusFor('signing-not-configured') as never);
  return c.json(
    toWireError(
      {
        code: 'signing-not-configured',
        message: `This deployment doesn't sign exports, so ${what} are unavailable: it has no export signing key. On the Kindgi runtime, set KINDGI_EXPORT_SIGNING_KEY_PATH, KINDGI_EXPORT_SIGNING_KEY or KINDGI_EXPORT_SIGNING_KMS_KEY.`,
      },
      c.get('requestId'),
    ),
  );
}

/**
 * A `signExport` failure as the route answers it: `404
 * signing-key-not-found`, `500 persistence-error`, or `500` with
 * `failureCode` (each route keeps the code it answered before).
 */
export function signExportFailure(
  c: Context<AppEnv>,
  error: SignExportError,
  failureCode: 'export-key-error' | 'compliance-export-failed',
): Response {
  const requestId = c.get('requestId');
  if (error.code === 'signing-key-not-found') {
    c.status(statusFor('signing-key-not-found') as never);
    return c.json(
      toWireError(
        { code: 'signing-key-not-found', message: error.message, signingKeyId: error.keyId },
        requestId,
      ),
    );
  }
  if (error.code === 'persistence-error') {
    c.status(statusFor('persistence-error') as never);
    return c.json(toWireError({ code: 'persistence-error', message: error.message }, requestId));
  }
  c.status(statusFor(failureCode) as never);
  return c.json(
    toWireError(
      { code: failureCode, message: `Signing the export failed: ${error.message}` },
      requestId,
    ),
  );
}

/** The caller as an audit actor: `user:<id>`, `service_account:<tokenId>`, or `service_account:unknown`. */
export function exportActor(c: Context<AppEnv>): string {
  const userId = c.get('userId');
  if (userId !== undefined) return `user:${userId as unknown as string}`;
  const tokenId = c.get('tokenId');
  if (tokenId !== undefined) return `service_account:${tokenId as unknown as string}`;
  return 'service_account:unknown';
}
