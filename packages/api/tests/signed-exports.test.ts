// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Signed exports (`exportSigning`): an approval's audit bundle, a run's
 * provenance and compliance evidence answer one envelope, signed with
 * the deployment's export key over the exact bytes shipped, with
 * `exportedAt` signed once. A bodiless POST signs with the active key;
 * `signingKeyId` is optional. Each export is recorded as an
 * `export-signed` audit event, and a bundle whose record can't be
 * written isn't handed out. `GET /v1/export-signing-keys` lists the keys
 * to pin. The deprecated `signingKey` binding still works.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { LoadedClassifier } from '@kindgi/compliance';
import {
  createEd25519ExportSigner,
  createInMemorySigningKeyBinding,
  generateEd25519KeyPair,
  parsePublicKeyPem,
  verifyEd25519,
} from '@kindgi/crypto';
import type { ExportSigningBinding } from '@kindgi/crypto';
import { createStubAppBindings } from '@kindgi/testing';
import type { SigningKeyId, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  Approval,
  HitlBinding,
  ProvenanceBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const runId = randomUUID();
const approvalId = randomUUID();
const TOKEN = 'signed-exports-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'u-1' as UserId, reviewerRole: 'admin' } : null;

const decided = {
  id: approvalId,
  tenantId,
  subjectKind: 'tool-call:pending',
  subjectRef: {},
  requiredRole: 'standard',
  status: 'rejected',
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:01:00.000Z',
  decidedAt: '2026-10-08T00:01:00.000Z',
  provenanceRef: { runId },
} as unknown as Approval;

const hitlBinding = {
  getApproval: async () => ({ kind: 'ok', value: decided }),
  loadReviewDecision: async () => ({
    kind: 'ok',
    value: {
      decision: 'reject',
      reviewerId: 'rev-1',
      reviewerRoleAtDecision: 'admin',
      decidedAt: '2026-10-08T00:01:00.000Z',
    },
  }),
} as unknown as HitlBinding;

const provenanceBinding = {
  getByRunId: async () => ({
    kind: 'ok',
    value: {
      id: randomUUID(),
      runId,
      tenantId,
      version: '1.0.0',
      createdAt: '2026-10-08T00:00:00.000Z',
      nodes: [],
      edges: [],
    },
  }),
} as unknown as ProvenanceBinding;

const classifierFile = {
  version: 1,
  default: { retention: { days: 90 }, signed: false, exportable: false },
  byKind: { 'run-outcome': { retention: { days: 90 }, signed: true, exportable: true } },
};
const complianceClassifier = {
  file: classifierFile,
  resolve: (kind: string) =>
    (classifierFile.byKind as Record<string, unknown>)[kind] ?? classifierFile.default,
} as unknown as LoadedClassifier;

function signer(): ExportSigningBinding {
  const made = createEd25519ExportSigner({ privateKey: generateEd25519KeyPair().privateKey });
  if (made.kind !== 'ok') throw new Error(made.error.message);
  return made.value;
}

function harness(
  options: { exportSigning?: ExportSigningBinding | false; auditEvents?: AuditEventBinding } = {},
) {
  const auditEvents = options.auditEvents ?? createInMemoryAuditEventBinding();
  const exportSigning = options.exportSigning === undefined ? signer() : options.exportSigning;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    hitlBinding,
    provenanceBinding,
    auditEvents,
    complianceClassifier,
    complianceGenerator: { describe: () => ({ name: 'none', version: '0' }) } as never,
    ...(exportSigning !== false && { exportSigning }),
  });
  const post = async (path: string, body?: unknown) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const exported = async (): Promise<readonly AuditEvent[]> => {
    const page = await auditEvents.query({
      tenantId,
      filter: { kind: 'export-signed' },
      limit: 50,
    });
    return page.kind === 'ok' ? page.value.data : [];
  };
  /** The deployment's active key (the harness signs unless told not to). */
  const activeKey = () => {
    if (exportSigning === false) throw new Error('this harness has no export key');
    return exportSigning.activeKey();
  };
  return { post, get, exported, activeKey };
}

const EXPORTS = [
  ['audit-bundle', `/v1/approvals/${approvalId}/audit-bundle`, 'approvalId', approvalId, '2.0.0'],
  ['provenance', `/v1/provenance/${runId}/export`, 'runId', runId, '1.2.0'],
  ['compliance', '/v1/compliance/evidence/export', 'tenantId', tenantId, '1.0.0'],
] as const;

/** The envelope verifies, against the deployment's listed key, over the bytes shipped. */
function verifies(envelope: Record<string, unknown>, publicKeyPem: string): boolean {
  expect(envelope.publicKey).toBe(publicKeyPem);
  const pub = parsePublicKeyPem(publicKeyPem);
  if (pub.kind !== 'ok') throw new Error(pub.error.message);
  const ok = verifyEd25519(
    pub.value,
    Buffer.from(envelope.bundle as string, 'base64'),
    Buffer.from(envelope.signature as string, 'base64'),
  );
  return ok.kind === 'ok' && ok.value;
}

describe.each(EXPORTS)('the %s export', (kind, path, subjectKey, subject, version) => {
  test('a bodiless POST signs with the active key: one envelope, exportedAt signed once', async () => {
    const h = harness();
    const answer = await h.post(path);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    const key = h.activeKey();
    expect(answer.json).toMatchObject({
      [subjectKey]: subject,
      kind,
      bundleSchemaVersion: version,
      algorithm: 'ed25519',
      signingKeyId: key.keyId,
      canonicalization: 'sorted-key-json',
    });
    expect(verifies(answer.json, key.publicKeyPem)).toBe(true);
    const body = JSON.parse(Buffer.from(answer.json.bundle as string, 'base64').toString('utf8'));
    expect(body).toMatchObject({
      bundleSchemaVersion: version,
      exportedAt: answer.json.exportedAt,
    });
    expect(body).not.toHaveProperty('bundleVersion');
  });

  test('the export is recorded: who, what, which key, and the bundle bytes’ SHA-256', async () => {
    const h = harness();
    const answer = await h.post(path, {});
    expect(answer.status).toBe(200);
    const [event] = await h.exported();
    expect(event).toMatchObject({
      kind: 'export-signed',
      actor: 'user:u-1',
      outcome: 'succeeded',
      payload: {
        v: 1,
        doc: {
          exportKind: kind,
          signingKeyId: answer.json.signingKeyId,
          bundleSha256: createHash('sha256')
            .update(Buffer.from(answer.json.bundle as string, 'base64'))
            .digest('hex'),
          exportedAt: answer.json.exportedAt,
        },
      },
    });
  });

  test('signingKeyId names the active key, or an unknown one is 404 signing-key-not-found', async () => {
    const h = harness();
    const keyId = h.activeKey().keyId;
    expect((await h.post(path, { signingKeyId: keyId })).status).toBe(200);
    const unknown = await h.post(path, { signingKeyId: 'ex_notthisone00000' });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toMatchObject({
      code: 'signing-key-not-found',
      details: { signingKeyId: 'ex_notthisone00000' },
    });
    expect((await h.post(path, { signingKeyId: '' })).status).toBe(400);
  });

  test('no export key: 404 signing-not-configured, naming the runtime settings', async () => {
    const answer = await harness({ exportSigning: false }).post(path);
    expect(answer.status).toBe(404);
    expect(answer.json.error).toMatchObject({ code: 'signing-not-configured' });
    expect((answer.json.error as { message: string }).message).toContain(
      'KINDGI_EXPORT_SIGNING_KEY_PATH',
    );
  });

  test("a bundle whose record can't be written isn't handed out", async () => {
    const store = createInMemoryAuditEventBinding();
    const failing: AuditEventBinding = {
      ...store,
      append: async () => ({
        kind: 'err',
        error: { code: 'persistence-error', message: 'the audit store is down', cause: null },
      }),
    };
    const answer = await harness({ auditEvents: failing }).post(path);
    expect(answer.status).toBe(500);
    expect(answer.json).not.toHaveProperty('bundle');
    expect(answer.json.error).toMatchObject({ code: 'persistence-error' });
  });
});

describe('GET /v1/export-signing-keys', () => {
  test('the keys to pin, active first; empty when the deployment signs nothing', async () => {
    const h = harness();
    const key = h.activeKey();
    expect((await h.get('/v1/export-signing-keys')).json).toEqual({
      data: [{ ...key, active: true }],
    });
    expect((await harness({ exportSigning: false }).get('/v1/export-signing-keys')).json).toEqual({
      data: [],
    });
  });
});

describe('the deprecated signingKey binding', () => {
  test('still signs, under its own key ids', async () => {
    const pair = generateEd25519KeyPair();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      provenanceBinding,
      signingKey: createInMemorySigningKeyBinding([
        { keyId: 'legacy-key' as SigningKeyId, algorithm: 'ed25519', ...pair },
      ]),
    });
    const res = await app.request(`/v1/provenance/${runId}/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ signingKeyId: 'legacy-key' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ signingKeyId: 'legacy-key', kind: 'provenance' });
  });
});
