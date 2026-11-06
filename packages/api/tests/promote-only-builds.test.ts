// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A promote-only build at `POST /v1/deployments`:
 *
 *   - the envelope signs `productionEntry` only when it's there, so an
 *     envelope without it signs the bytes it always has;
 *   - a deploy of one into a project in production, or one whose production
 *     the runtime can't read, is `409 promote-only-build`, nothing written:
 *     marked by its envelope, by its key id's prefix, or by the public key
 *     of a prefixed key the workspace has trusted (any page of the list,
 *     revoked entries included);
 *   - into a project not in production it registers, and keeps the mark;
 *   - a `productionEntry` the runtime doesn't know is `400`, and the field
 *     is signed: sent without being signed, or signed without being sent,
 *     the signature doesn't verify.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { generateEd25519KeyPair, serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import type { Project, ProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, SigningKeyId, TenantId, Timestamp } from '@kindgi/types';

import {
  PROMOTE_ONLY_KEY_PREFIX,
  type ProductionEntry,
  canonicalizeEnvelope,
} from '../src/deployment-envelope.js';
import { createApp } from '../src/index.js';
import type {
  Deployment,
  DeploymentBinding,
  ImageRegistryBinding,
  RunHandlerBinding,
  SigningKeyBinding,
  TokenResolver,
  TrustedKey,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'promote-only-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const notUsed = async (): Promise<never> => {
  throw new Error('not used in these tests');
};
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};

/** Not in production. */
const DEV = randomUUID() as ProjectId;
/** In production, and the workspace's default. */
const PROD = randomUUID() as ProjectId;

function projects(): ProjectBinding {
  const row = (id: ProjectId): Project =>
    ({
      id,
      tenantId,
      name: id === PROD ? 'Production' : 'Dev',
      slug: id === PROD ? 'production' : 'dev',
      isDefault: id === PROD,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      ...(id === PROD && { productionSince: '2026-11-02T00:00:00.000Z' as Timestamp }),
    }) as Project;
  return {
    getDefault: async () => row(PROD),
    get: async (t: TenantId, id: ProjectId) =>
      t === tenantId && (id === DEV || id === PROD) ? row(id) : undefined,
    create: notUsed,
    list: notUsed,
    update: notUsed,
    delete: notUsed,
  } as unknown as ProjectBinding;
}

interface Trust {
  readonly keyId: string;
  readonly publicKey: string;
  readonly revoked?: boolean;
}

/** The trust list, one entry a page, so a match on a later page needs every page read. */
function trustList(entries: readonly Trust[]): SigningKeyBinding {
  const keys: TrustedKey[] = entries.map((e) => ({
    keyId: e.keyId as SigningKeyId,
    tenantId,
    algorithm: 'ed25519',
    publicKey: e.publicKey,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...(e.revoked === true && { revokedAt: '2026-11-03T00:00:00.000Z' }),
  }));
  return {
    isTrusted: async ({ keyId, publicKey }) => ({
      kind: 'ok',
      value: keys.some(
        (k) => k.keyId === keyId && k.publicKey === publicKey && k.revokedAt === undefined,
      ),
    }),
    verify: notUsed,
    async listTrusted({ cursor, includeRevoked }) {
      const listed = keys.filter((k) => includeRevoked === true || k.revokedAt === undefined);
      const from = cursor === undefined ? 0 : Number(cursor);
      return {
        data: listed.slice(from, from + 1),
        ...(from + 1 < listed.length && { nextCursor: String(from + 1) as Cursor }),
      };
    },
    getTrusted: notUsed,
    addTrusted: notUsed,
    revokeTrusted: notUsed,
  };
}

function ledger(): DeploymentBinding & { readonly rows: Deployment[] } {
  const rows: Deployment[] = [];
  return {
    rows,
    async register(input) {
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
        ...(input.productionEntry !== undefined && { productionEntry: input.productionEntry }),
        activatedAt: new Date().toISOString(),
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        primitives: input.primitives,
        contents: input.contents,
      };
      rows.push(deployment);
      return { kind: 'ok', deployment };
    },
    get: async ({ deploymentId }) => rows.find((d) => d.deploymentId === deploymentId) ?? null,
    getByImageDigest: async ({ imageDigest, projectId }) =>
      rows.find((d) => d.imageDigest === imageDigest && d.projectId === projectId) ?? null,
    list: async () => ({ data: rows }),
  };
}

const keyPair = generateEd25519KeyPair();
const PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('base64');
const RELEASE_KEY = 'acme-release';

const index = {
  v: 1,
  packId: 'acme.pack',
  packVersion: '1.0.0',
  artifactVersion: '20261106.1',
  publishedAt: '2026-11-06T09:00:00.000Z',
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

/** The deploy's body, signed over `signed` (absent: what the body sends). */
function deploy(opts: {
  readonly keyId?: string;
  readonly productionEntry?: unknown;
  readonly projectId?: ProjectId;
  readonly signed?: { readonly productionEntry?: ProductionEntry };
}): Record<string, unknown> {
  const sends = opts.productionEntry;
  const signs = opts.signed !== undefined ? opts.signed.productionEntry : sends;
  const envelope = canonicalizeEnvelope({
    imageDigest: DIGEST,
    artifactVersion: index.artifactVersion,
    indexHash: DIGEST,
    tenantId: tenantId as unknown as string,
    publishedAt: index.publishedAt,
    ...(signs === 'promote-only' && { productionEntry: signs }),
  });
  const signature = signEd25519(keyPair.privateKey, envelope);
  if (signature.kind === 'err') throw new Error(signature.error.message);
  return {
    imageRef: IMAGE_REF,
    artifactVersion: index.artifactVersion,
    indexHash: DIGEST,
    signerKeyId: opts.keyId ?? RELEASE_KEY,
    signerPublicKey: serializePublicKeyPem(keyPair.publicKey),
    signature: Buffer.from(signature.value).toString('base64'),
    publishedAt: index.publishedAt,
    ...(sends !== undefined && { productionEntry: sends }),
    ...(opts.projectId !== undefined && { projectId: opts.projectId }),
  };
}

function harness(opts: { readonly trust?: readonly Trust[]; readonly noProjects?: boolean } = {}) {
  const deployments = ledger();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    deploymentRegistry: deployments,
    signingKeyRegistry: trustList(opts.trust ?? [{ keyId: RELEASE_KEY, publicKey: PUBLIC_KEY }]),
    imageRegistry: images,
    ...(opts.noProjects !== true && { projectBinding: projects() }),
  });
  const post = async (body: Record<string, unknown>) => {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { deployments, post };
}

describe('the envelope signs productionEntry only when it is there', () => {
  const fields = {
    imageDigest: DIGEST,
    artifactVersion: '20261106.1',
    indexHash: DIGEST,
    tenantId: 'acme-tenant',
    publishedAt: '2026-11-06T09:00:00.000Z',
  };
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  test('without it, the bytes every envelope signed before have', () => {
    expect(text(canonicalizeEnvelope(fields))).toBe(
      `{"artifactVersion":"20261106.1","imageDigest":"${DIGEST}","indexHash":"${DIGEST}","publishedAt":"2026-11-06T09:00:00.000Z","tenantId":"acme-tenant"}`,
    );
  });

  test('with it, in its sorted place', () => {
    expect(text(canonicalizeEnvelope({ ...fields, productionEntry: 'promote-only' }))).toBe(
      `{"artifactVersion":"20261106.1","imageDigest":"${DIGEST}","indexHash":"${DIGEST}","productionEntry":"promote-only","publishedAt":"2026-11-06T09:00:00.000Z","tenantId":"acme-tenant"}`,
    );
  });
});

describe('a promote-only build reaches a project in production only by promotion', () => {
  test('its envelope says so: a deploy into production is 409 promote-only-build, nothing written', async () => {
    const h = harness();
    const res = await h.post(deploy({ productionEntry: 'promote-only', projectId: PROD }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'promote-only-build',
      details: { signerKeyId: RELEASE_KEY, projectId: PROD },
    });
    expect(h.deployments.rows).toHaveLength(0);
  });

  test('naming no project, it lands in the default, which is in production: 409', async () => {
    const h = harness();
    const res = await h.post(deploy({ productionEntry: 'promote-only' }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'promote-only-build',
      details: { projectId: PROD },
    });
  });

  test('into a project not in production it registers, and the deployment keeps the mark', async () => {
    const h = harness();
    const res = await h.post(deploy({ productionEntry: 'promote-only', projectId: DEV }));
    expect(res.status).toBe(201);
    expect(res.body.productionEntry).toBe('promote-only');
    expect(h.deployments.rows[0]?.productionEntry).toBe('promote-only');
  });

  test('its key id has the prefix: promote-only, whatever the envelope says', async () => {
    const keyId = `${PROMOTE_ONLY_KEY_PREFIX}acme`;
    const h = harness({ trust: [{ keyId, publicKey: PUBLIC_KEY }] });
    const intoProd = await h.post(deploy({ keyId, projectId: PROD }));
    expect(intoProd.status).toBe(409);
    expect(intoProd.body.error).toMatchObject({
      code: 'promote-only-build',
      details: { signerKeyId: keyId },
    });
    const intoDev = await h.post(deploy({ keyId, projectId: DEV }));
    expect(intoDev.status).toBe(201);
  });

  test("its public key is a prefixed key's, trusted again under another id: refused, the prefixed entry revoked and on a later page", async () => {
    const other = generateEd25519KeyPair();
    const h = harness({
      trust: [
        { keyId: 'acme-other', publicKey: Buffer.from(other.publicKey).toString('base64') },
        { keyId: RELEASE_KEY, publicKey: PUBLIC_KEY },
        { keyId: `${PROMOTE_ONLY_KEY_PREFIX}acme`, publicKey: PUBLIC_KEY, revoked: true },
      ],
    });
    const res = await h.post(deploy({ projectId: PROD }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('promote-only-build');
    expect(h.deployments.rows).toHaveLength(0);
  });

  test('a build that is none of these deploys into production as before', async () => {
    const h = harness();
    const res = await h.post(deploy({ projectId: PROD }));
    expect(res.status).toBe(201);
    expect(res.body.productionEntry).toBeUndefined();
  });

  test("a runtime that can't read production refuses a promote-only build, and takes any other", async () => {
    const marked = harness({ noProjects: true });
    const refused = await marked.post(deploy({ productionEntry: 'promote-only' }));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('promote-only-build');
    expect(refused.body.error.details).toEqual({ signerKeyId: RELEASE_KEY });

    const plain = harness({ noProjects: true });
    expect((await plain.post(deploy({}))).status).toBe(201);
  });
});

describe('productionEntry on the wire', () => {
  test("a value the runtime doesn't know is 400, never read as absent", async () => {
    const h = harness();
    const res = await h.post(deploy({ productionEntry: 'anywhere', projectId: DEV }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.details.issues).toContainEqual({
      path: 'productionEntry',
      message: "productionEntry must be 'promote-only'",
    });
  });

  test('it is signed: sent but not signed, or signed but not sent, the signature fails', async () => {
    const h = harness();
    const sentOnly = await h.post(
      deploy({ productionEntry: 'promote-only', projectId: DEV, signed: {} }),
    );
    expect(sentOnly.status).toBe(400);
    expect(sentOnly.body.error.code).toBe('signature-invalid');

    const signedOnly = await h.post(
      deploy({ projectId: PROD, signed: { productionEntry: 'promote-only' } }),
    );
    expect(signedOnly.status).toBe(400);
    expect(signedOnly.body.error.code).toBe('signature-invalid');
    expect(h.deployments.rows).toHaveLength(0);
  });
});
