// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A promote-only build and turning production on, landing at the same
 * moment. Each route checks the other side before its binding writes, and
 * the bindings check again in their own step:
 *
 *   - `POST /v1/deployments` asks whether the build is promote-only on every
 *     deploy, a project in production or not, and registers one with
 *     `promoteOnly`, so the registry can refuse it in its step
 *     (`project-in-production`): `409 promote-only-build`, as the route's own
 *     check answers, nothing recorded;
 *   - `PUT /v1/projects/:projectId/production` maps the project binding's
 *     `promote-only-build` to the `409` its own check answers, the same body;
 *   - so whichever lands second is refused, both ways round.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { generateEd25519KeyPair, serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import { type ProjectBinding, makeInMemoryProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, SigningKeyId, TenantId } from '@kindgi/types';

import { PROMOTE_ONLY_KEY_PREFIX, canonicalizeEnvelope } from '../src/deployment-envelope.js';
import { createApp } from '../src/index.js';
import type {
  Deployment,
  DeploymentBinding,
  DeploymentRegisterInput,
  ImageRegistryBinding,
  RunHandlerBinding,
  SigningKeyBinding,
  TokenResolver,
  TrustedKey,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'promote-only-in-step-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

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
const RELEASE_KEY = 'acme-release';
const PREFIXED_KEY = `${PROMOTE_ONLY_KEY_PREFIX}acme-release`;

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

interface Trust {
  readonly keyId: string;
  readonly revoked?: boolean;
}

/** The trust list: every entry holds this file's one public key. */
function trustList(entries: readonly Trust[]): SigningKeyBinding {
  const keys: TrustedKey[] = entries.map((e) => ({
    keyId: e.keyId as SigningKeyId,
    tenantId,
    algorithm: 'ed25519',
    publicKey: PUBLIC_KEY,
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
    async listTrusted({ includeRevoked }) {
      return { data: keys.filter((k) => includeRevoked === true || k.revokedAt === undefined) };
    },
    getTrusted: notUsed,
    addTrusted: notUsed,
    revokeTrusted: notUsed,
  };
}

/** Moments a test lands the other side in: the registry's step, or the switch's. */
interface Moments {
  beforeRegister?: (() => Promise<void>) | undefined;
  beforeSwitch?: (() => Promise<void>) | undefined;
}

/**
 * The ledger, keeping projects in the same store as a runtime does: a
 * registration with `promoteOnly` reads the project (the one named, else
 * the default) in its step, and keeps the flag, which the project binding
 * reads in its own step.
 */
function ledger(projects: ProjectBinding, moments: Moments) {
  const rows: Deployment[] = [];
  const promoteOnly = new Set<string>();
  const inputs: DeploymentRegisterInput[] = [];
  const binding: DeploymentBinding = {
    async register(input) {
      inputs.push(input);
      await moments.beforeRegister?.();
      if (input.promoteOnly === true) {
        const project =
          input.projectId === undefined
            ? await projects.getDefault(input.tenantId)
            : await projects.get(input.tenantId, input.projectId);
        if (project === undefined || project.productionSince !== undefined) {
          return { kind: 'project-in-production' };
        }
      }
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
      if (input.promoteOnly === true) promoteOnly.add(deployment.deploymentId);
      return { kind: 'ok', deployment };
    },
    get: async ({ deploymentId }) => rows.find((d) => d.deploymentId === deploymentId) ?? null,
    getByImageDigest: async ({ imageDigest, projectId }) =>
      rows.find((d) => d.imageDigest === imageDigest && d.projectId === projectId) ?? null,
    async list({ projectId, cursor }) {
      const listed = rows.filter((d) => projectId === undefined || d.projectId === projectId);
      const from = cursor === undefined ? 0 : Number(cursor);
      return {
        data: listed.slice(from, from + 1),
        ...(from + 1 < listed.length && { nextCursor: String(from + 1) as Cursor }),
      };
    },
  };
  /** The first promote-only build deployed into the project (not promoted), as the store keeps it. */
  const heldIn = (t: TenantId, projectId: ProjectId) => {
    const held = rows.find(
      (d) =>
        d.tenantId === t &&
        d.projectId === projectId &&
        d.promotedFromDeploymentId === undefined &&
        promoteOnly.has(d.deploymentId),
    );
    return held === undefined
      ? undefined
      : { deploymentId: held.deploymentId, signerKeyId: held.signerKeyId };
  };
  return { binding, rows, inputs, heldIn };
}

/** The deploy's body, signed by this file's key under `keyId`. */
function deploy(opts: {
  readonly keyId?: string;
  readonly promoteOnly?: boolean;
  readonly projectId: ProjectId;
}): Record<string, unknown> {
  const envelope = canonicalizeEnvelope({
    imageDigest: DIGEST,
    artifactVersion: index.artifactVersion,
    indexHash: DIGEST,
    tenantId: tenantId as unknown as string,
    publishedAt: index.publishedAt,
    ...(opts.promoteOnly === true && { productionEntry: 'promote-only' as const }),
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
    ...(opts.promoteOnly === true && { productionEntry: 'promote-only' }),
    projectId: opts.projectId,
  };
}

async function harness(opts: { readonly trust?: readonly Trust[] } = {}) {
  const moments: Moments = {};
  // The project binding reads the ledger's promote-only builds in its step;
  // the ledger reads the projects in its own.
  let heldIn: ReturnType<typeof ledger>['heldIn'] = () => undefined;
  const trio = makeInMemoryProjectBinding({
    promoteOnlyDeployment: (t, projectId) => heldIn(t, projectId),
  });
  const deployments = ledger(trio.projects, moments);
  heldIn = deployments.heldIn;
  const setProduction = trio.projects.setProduction;
  if (setProduction === undefined) throw new Error('the in-memory binding sets production');
  const projectBinding: ProjectBinding = {
    ...trio.projects,
    async setProduction(t, projectId, production) {
      await moments.beforeSwitch?.();
      return setProduction(t, projectId, production);
    },
  };
  const made = await trio.projects.create(tenantId, {
    name: 'Dev',
    slug: `dev-${randomUUID().slice(0, 8)}`,
    role: 'owner',
  } as never);
  if (made.kind !== 'ok') throw new Error(made.kind);
  const dev = made.projectId;

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    deploymentRegistry: deployments.binding,
    signingKeyRegistry: trustList(opts.trust ?? [{ keyId: RELEASE_KEY }]),
    imageRegistry: images,
    projectBinding,
    projectMembershipBinding: trio.memberships,
  });
  const post = async (body: Record<string, unknown>) => {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const putProduction = async (production: boolean) => {
    const res = await app.request(`/v1/projects/${dev}/production`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ production }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const inProduction = async () =>
    (await trio.projects.get(tenantId, dev))?.productionSince !== undefined;
  return { dev, deployments, moments, post, putProduction, inProduction };
}

/** A wire error without its request id, which differs from call to call. */
function refusal(body: Record<string, any>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = body.error as Record<string, unknown>;
  return rest;
}

/** A refusal with its project's id, and its deployment's, as placeholders: two compare by their words. */
function shape(body: Record<string, any>, projectId: ProjectId, deploymentId?: string): string {
  const text = JSON.stringify(refusal(body)).replaceAll(projectId, '<project>');
  return deploymentId === undefined ? text : text.replaceAll(deploymentId, '<deployment>');
}

describe('the deploy asks whether the build is promote-only, a project in production or not', () => {
  test('by its envelope, its key id, or its key bytes: each registers with promoteOnly', async () => {
    const marked = await harness();
    expect((await marked.post(deploy({ promoteOnly: true, projectId: marked.dev }))).status).toBe(
      201,
    );

    const prefixed = await harness({ trust: [{ keyId: PREFIXED_KEY }] });
    expect(
      (await prefixed.post(deploy({ keyId: PREFIXED_KEY, projectId: prefixed.dev }))).status,
    ).toBe(201);

    // A plain key id signing with the bytes of a prefixed key the workspace
    // trusted, revoked since: only the trust list says, and it's read.
    const bytes = await harness({
      trust: [{ keyId: RELEASE_KEY }, { keyId: PREFIXED_KEY, revoked: true }],
    });
    expect((await bytes.post(deploy({ projectId: bytes.dev }))).status).toBe(201);

    for (const h of [marked, prefixed, bytes]) {
      expect(h.deployments.inputs.map((input) => input.promoteOnly)).toEqual([true]);
    }
  });

  test('a build that is none of these registers without it', async () => {
    const h = await harness();
    expect((await h.post(deploy({ projectId: h.dev }))).status).toBe(201);
    expect(h.deployments.inputs).toHaveLength(1);
    expect('promoteOnly' in (h.deployments.inputs[0] as object)).toBe(false);
  });
});

describe('turning production on while a promote-only build deploys', () => {
  test('the switch lands first: the registry refuses in its step, 409 as the route answers, nothing recorded', async () => {
    // Today's refusal, from the route's own check, for the body to compare.
    const before = await harness();
    expect((await before.putProduction(true)).status).toBe(200);
    const checked = await before.post(deploy({ promoteOnly: true, projectId: before.dev }));
    expect(checked.status).toBe(409);
    expect(before.deployments.inputs).toHaveLength(0);

    const h = await harness();
    h.moments.beforeRegister = async () => {
      h.moments.beforeRegister = undefined;
      expect((await h.putProduction(true)).status).toBe(200);
    };
    const res = await h.post(deploy({ promoteOnly: true, projectId: h.dev }));
    expect(res.status).toBe(409);
    expect(shape(res.body, h.dev)).toBe(shape(checked.body, before.dev));
    expect(refusal(res.body)).toMatchObject({
      code: 'promote-only-build',
      details: { signerKeyId: RELEASE_KEY, projectId: h.dev },
    });
    expect(h.deployments.inputs.map((input) => input.promoteOnly)).toEqual([true]);
    expect(h.deployments.rows).toHaveLength(0);
    expect(await h.inProduction()).toBe(true);
  });

  test('the deploy lands first: the switch refuses in its step, the same 409 naming it, the project stays out', async () => {
    // Today's refusal, from the route's own check, for the body to compare.
    const before = await harness();
    expect((await before.post(deploy({ promoteOnly: true, projectId: before.dev }))).status).toBe(
      201,
    );
    const checked = await before.putProduction(true);
    expect(checked.status).toBe(409);

    const h = await harness();
    h.moments.beforeSwitch = async () => {
      h.moments.beforeSwitch = undefined;
      expect((await h.post(deploy({ promoteOnly: true, projectId: h.dev }))).status).toBe(201);
    };
    const res = await h.putProduction(true);
    expect(res.status).toBe(409);
    const held = h.deployments.rows[0];
    expect(refusal(res.body)).toEqual({
      code: 'promote-only-build',
      message: expect.stringContaining(`holds deployment ${held?.deploymentId}`),
      details: {
        deploymentId: held?.deploymentId,
        signerKeyId: RELEASE_KEY,
        projectId: h.dev,
      },
    });
    // The route's own check's words and details, for this project and deployment.
    expect(shape(res.body, h.dev, held?.deploymentId)).toBe(
      shape(checked.body, before.dev, before.deployments.rows[0]?.deploymentId),
    );
    expect(await h.inProduction()).toBe(false);
  });

  test('an unmarked deploy into a project put in production meanwhile registers as before', async () => {
    const h = await harness();
    h.moments.beforeRegister = async () => {
      h.moments.beforeRegister = undefined;
      expect((await h.putProduction(true)).status).toBe(200);
    };
    expect((await h.post(deploy({ projectId: h.dev }))).status).toBe(201);
    expect(h.deployments.rows).toHaveLength(1);
  });
});
