// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a build was made from (`builtFrom`) at `POST /v1/deployments`:
 *
 *   - the envelope signs `builtFrom` only when it's there, its keys sorted
 *     too, so an envelope without it signs the bytes it always has;
 *   - it is signed: sent without being signed, signed without being sent,
 *     or any of its fields changed, the signature doesn't verify, and
 *     nothing is written;
 *   - a field of it the runtime doesn't know, another kind, or a value out
 *     of shape is `400`, never read past;
 *   - the deployment keeps it, and answers it;
 *   - a new deployment is recorded as `deployment-registered`, naming who
 *     registered it as the actor and the person in `builtFrom` beside
 *     them; a repeat records nothing.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { generateEd25519KeyPair, serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import type { TenantId } from '@kindgi/types';

import { type BuiltFrom, canonicalizeEnvelope } from '../src/deployment-envelope.js';
import { createApp } from '../src/index.js';
import type {
  Deployment,
  DeploymentBinding,
  ImageRegistryBinding,
  RunHandlerBinding,
  SigningKeyBinding,
  TokenResolver,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'built-from-token';
/** The builder's own identity, which registers the build for the person. */
const BUILDER = 'sa-builder';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, serviceAccountId: BUILDER } : null;

const notUsed = async (): Promise<never> => {
  throw new Error('not used in these tests');
};

const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};

const keyPair = generateEd25519KeyPair();
const PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('base64');
const RELEASE_KEY = 'acme-builder';

const trustList: SigningKeyBinding = {
  isTrusted: async ({ keyId, publicKey }) => ({
    kind: 'ok',
    value: keyId === RELEASE_KEY && publicKey === PUBLIC_KEY,
  }),
  verify: notUsed,
  listTrusted: async () => ({ data: [] }),
  getTrusted: notUsed,
  addTrusted: notUsed,
  revokeTrusted: notUsed,
};

/** A binding that keeps `builtFrom`, as one that knows the field does. */
function ledger(): DeploymentBinding & { readonly rows: Deployment[] } {
  const rows: Deployment[] = [];
  return {
    rows,
    async register(input) {
      const there = rows.find((d) => d.imageDigest === input.imageDigest);
      if (there !== undefined) return { kind: 'already-registered', deployment: there };
      const deployment: Deployment = {
        deploymentId: input.deploymentId ?? `dep-${rows.length + 1}`,
        tenantId: input.tenantId,
        imageRef: input.imageRef,
        imageDigest: input.imageDigest,
        artifactVersion: input.artifactVersion,
        indexHash: input.indexHash,
        signerKeyId: input.signerKeyId,
        signerPublicKey: input.signerPublicKey,
        signature: input.signature,
        publishedAt: input.publishedAt,
        ...(input.builtFrom !== undefined && { builtFrom: input.builtFrom }),
        activatedAt: new Date().toISOString(),
        primitives: input.primitives,
        contents: input.contents,
      };
      rows.push(deployment);
      return { kind: 'ok', deployment };
    },
    get: async ({ deploymentId }) => rows.find((d) => d.deploymentId === deploymentId) ?? null,
    getByImageDigest: async ({ imageDigest }) =>
      rows.find((d) => d.imageDigest === imageDigest) ?? null,
    list: async () => ({ data: rows }),
  };
}

const index = {
  v: 1,
  packId: 'acme.pack',
  packVersion: '1.0.0',
  artifactVersion: '20261110.1',
  publishedAt: '2026-11-10T09:00:00.000Z',
  tools: [],
  guardrails: [],
  agents: [],
  flows: [],
};
const indexBytes = new TextEncoder().encode(JSON.stringify(index));
const indexSha = createHash('sha256').update(indexBytes).digest('hex');
const DIGEST = `sha256:${indexSha}`;
const IMAGE_REF = `registry.acme.example/acme/pack@${DIGEST}`;

const images: ImageRegistryBinding = {
  head: async () => ({
    kind: 'ok',
    value: {
      digest: DIGEST,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      size: indexBytes.length,
      layers: [{ digest: DIGEST, mediaType: 'x', size: indexBytes.length }],
      config: { digest: 'sha256:cfg', mediaType: 'x', size: 0 },
    },
  }),
  extractFile: async ({ path }) => ({
    kind: 'ok',
    value: { path, bytes: indexBytes, sha256: indexSha, layerDigest: DIGEST },
  }),
  push: notUsed,
};

const BUILT: BuiltFrom = {
  kind: 'kept-repo',
  projectId: '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e',
  commit: 'a'.repeat(40),
  requestedBy: 'user:user-1',
};

/** The deploy's body, signed over `signs` (absent: what the body sends). */
function deploy(opts: { readonly sends?: unknown; readonly signs?: BuiltFrom | null }) {
  const signs = opts.signs === undefined ? (opts.sends as BuiltFrom | undefined) : opts.signs;
  const envelope = canonicalizeEnvelope({
    imageDigest: DIGEST,
    artifactVersion: index.artifactVersion,
    indexHash: DIGEST,
    tenantId: tenantId as unknown as string,
    publishedAt: index.publishedAt,
    ...(signs !== null && signs !== undefined && { builtFrom: signs }),
  });
  const signature = signEd25519(keyPair.privateKey, envelope);
  if (signature.kind === 'err') throw new Error(signature.error.message);
  return {
    imageRef: IMAGE_REF,
    artifactVersion: index.artifactVersion,
    indexHash: DIGEST,
    signerKeyId: RELEASE_KEY,
    signerPublicKey: serializePublicKeyPem(keyPair.publicKey),
    signature: Buffer.from(signature.value).toString('base64'),
    publishedAt: index.publishedAt,
    ...(opts.sends !== undefined && { builtFrom: opts.sends }),
  };
}

function harness() {
  const deployments = ledger();
  const appended: AuditEvent[] = [];
  const auditEvents: AuditEventBinding = {
    async append(events) {
      appended.push(...events);
      return { kind: 'ok', value: undefined };
    },
    query: notUsed,
    purge: notUsed,
    describe: () => ({ name: 'spy', version: '0' }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    deploymentRegistry: deployments,
    signingKeyRegistry: trustList,
    imageRegistry: images,
    auditEvents,
  });
  const post = async (body: Record<string, unknown>) => {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const registered = () => appended.filter((e) => e.kind === 'deployment-registered');
  return { deployments, post, registered };
}

describe('the envelope signs builtFrom only when it is there', () => {
  const fields = {
    imageDigest: DIGEST,
    artifactVersion: '20261110.1',
    indexHash: DIGEST,
    tenantId: 'acme-tenant',
    publishedAt: '2026-11-10T09:00:00.000Z',
  };
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  test('without it, the bytes every envelope signed before have', () => {
    expect(text(canonicalizeEnvelope(fields))).toBe(
      `{"artifactVersion":"20261110.1","imageDigest":"${DIGEST}","indexHash":"${DIGEST}","publishedAt":"2026-11-10T09:00:00.000Z","tenantId":"acme-tenant"}`,
    );
  });

  test('with it, in its sorted place and its own keys sorted, however they came', () => {
    const shuffled = {
      requestedBy: BUILT.requestedBy,
      commit: BUILT.commit,
      projectId: BUILT.projectId,
      kind: BUILT.kind,
    } as BuiltFrom;
    const expected = `{"artifactVersion":"20261110.1","builtFrom":{"commit":"${BUILT.commit}","kind":"kept-repo","projectId":"${BUILT.projectId}","requestedBy":"user:user-1"},"imageDigest":"${DIGEST}","indexHash":"${DIGEST}","publishedAt":"2026-11-10T09:00:00.000Z","tenantId":"acme-tenant"}`;
    expect(text(canonicalizeEnvelope({ ...fields, builtFrom: BUILT }))).toBe(expected);
    expect(text(canonicalizeEnvelope({ ...fields, builtFrom: shuffled }))).toBe(expected);
  });

  test('with productionEntry too, each in its sorted place', () => {
    expect(
      text(canonicalizeEnvelope({ ...fields, builtFrom: BUILT, productionEntry: 'promote-only' })),
    ).toBe(
      `{"artifactVersion":"20261110.1","builtFrom":{"commit":"${BUILT.commit}","kind":"kept-repo","projectId":"${BUILT.projectId}","requestedBy":"user:user-1"},"imageDigest":"${DIGEST}","indexHash":"${DIGEST}","productionEntry":"promote-only","publishedAt":"2026-11-10T09:00:00.000Z","tenantId":"acme-tenant"}`,
    );
  });
});

describe('builtFrom is signed', () => {
  test('signed and sent: registered, kept and answered', async () => {
    const h = harness();
    const res = await h.post(deploy({ sends: BUILT }));
    expect(res.status).toBe(201);
    expect(res.body.builtFrom).toEqual(BUILT);
    expect(h.deployments.rows[0]?.builtFrom).toEqual(BUILT);
  });

  test('sent but not signed, or signed but not sent: signature-invalid, nothing written', async () => {
    const h = harness();
    const sentOnly = await h.post(deploy({ sends: BUILT, signs: null }));
    expect(sentOnly.status).toBe(400);
    expect(sentOnly.body.error.code).toBe('signature-invalid');

    const signedOnly = await h.post(deploy({ signs: BUILT }));
    expect(signedOnly.status).toBe(400);
    expect(signedOnly.body.error.code).toBe('signature-invalid');
    expect(h.deployments.rows).toHaveLength(0);
    expect(h.registered()).toHaveLength(0);
  });

  test.each<[string, Partial<BuiltFrom>]>([
    ['projectId', { projectId: '1c7e4d2f-9b3a-4e6c-8d1f-2e3b4c5d6e7f' }],
    ['commit', { commit: 'b'.repeat(40) }],
    ['requestedBy', { requestedBy: 'user:user-2' }],
  ])('its %s changed after signing: signature-invalid', async (_name, change) => {
    const h = harness();
    const res = await h.post(deploy({ sends: { ...BUILT, ...change }, signs: BUILT }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('signature-invalid');
    expect(h.deployments.rows).toHaveLength(0);
    expect(h.registered()).toHaveLength(0);
  });
});

describe('builtFrom on the wire', () => {
  const upperProject = BUILT.projectId.toUpperCase();
  const serviceAccount = 'service_account:sa-1';
  test.each<[string, unknown, string]>([
    ['not an object', 'kept-repo', 'builtFrom'],
    ['an array', [BUILT], 'builtFrom'],
    ['a field it does not know', { ...BUILT, branch: 'main' }, 'builtFrom.branch'],
    ['another kind', { ...BUILT, kind: 'github' }, 'builtFrom.kind'],
    ['no kind', { ...BUILT, kind: undefined }, 'builtFrom.kind'],
    ['an upper-case project id', { ...BUILT, projectId: upperProject }, 'builtFrom.projectId'],
    ['a project id no UUID', { ...BUILT, projectId: 'acme' }, 'builtFrom.projectId'],
    ['a short commit', { ...BUILT, commit: 'a'.repeat(12) }, 'builtFrom.commit'],
    ['an upper-case commit', { ...BUILT, commit: 'A'.repeat(40) }, 'builtFrom.commit'],
    ['no user: prefix', { ...BUILT, requestedBy: 'user-1' }, 'builtFrom.requestedBy'],
    ['a service account', { ...BUILT, requestedBy: serviceAccount }, 'builtFrom.requestedBy'],
    ['a space in the id', { ...BUILT, requestedBy: 'user:user 1' }, 'builtFrom.requestedBy'],
  ])('%s: 400, never read past', async (_name, sends, issuePath) => {
    const h = harness();
    const res = await h.post(deploy({ sends, signs: null }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.details.issues).toContainEqual(
      expect.objectContaining({ path: issuePath }),
    );
    expect(h.deployments.rows).toHaveLength(0);
  });
});

describe('the deployment-registered record', () => {
  test('a new deployment: the registering identity as the actor, the person in builtFrom', async () => {
    const h = harness();
    const res = await h.post(deploy({ sends: BUILT }));
    expect(res.status).toBe(201);
    expect(h.registered()).toHaveLength(1);
    expect(h.registered()[0]).toMatchObject({
      kind: 'deployment-registered',
      outcome: 'succeeded',
      actor: `service_account:${BUILDER}`,
      payload: {
        doc: {
          deploymentId: res.body.deploymentId,
          imageDigest: DIGEST,
          artifactVersion: index.artifactVersion,
          signerKeyId: RELEASE_KEY,
          builtFrom: BUILT,
        },
      },
    });
    expect(h.registered()[0]?.correlationId).toEqual(expect.any(String));
  });

  test('a build that says nothing of where it came from: recorded without builtFrom', async () => {
    const h = harness();
    expect((await h.post(deploy({}))).status).toBe(201);
    expect(h.registered()).toHaveLength(1);
    expect(h.registered()[0]?.payload).not.toHaveProperty('doc.builtFrom');
  });

  test('a repeat of a deployment the runtime has: 200, and no second record', async () => {
    const h = harness();
    expect((await h.post(deploy({ sends: BUILT }))).status).toBe(201);
    const again = await h.post(deploy({ sends: BUILT }));
    expect(again.status).toBe(200);
    expect(h.registered()).toHaveLength(1);
  });
});
