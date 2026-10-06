// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { generateEd25519KeyPair, serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import type { Project, ProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, SigningKeyId, TenantId } from '@kindgi/types';

import type { Scope } from '@kindgi/platform';
import { createStubAppBindings } from '@kindgi/testing';
import { makeEnvName } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  Deployment,
  DeploymentBinding,
  DeploymentPrimitiveCounts,
  FlowRegistryBinding,
  GuardrailRegistryBinding,
  ImageRegistryBinding,
  RunHandlerBinding,
  SecretBinding,
  SecretRecord,
  SecretVersionRecord,
  SigningKeyBinding as SigningKeyRegistryBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';

/**
 * Deployments route tests. Every binding is
 * caller-plugged and mocked in-memory; no real image registry / trust
 * store / persistent ledger is touched. Real end-to-end integration
 * against a Firecracker sandbox is not covered here.
 */

const tenantId = randomUUID() as TenantId;
const otherTenantId = randomUUID() as TenantId;
const TOKEN = 'deployments-token-abc';
const OTHER_TOKEN = 'deployments-token-other';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  if (token === OTHER_TOKEN) return { tenantId: otherTenantId };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

// ---------------- in-memory bindings ----------------

function makeInMemoryDeploymentBinding(): DeploymentBinding {
  const byTenant = new Map<string, Deployment[]>();
  let seq = 0;
  return {
    async register(input) {
      const list = byTenant.get(input.tenantId as unknown as string) ?? [];
      const existing = list.find((d) => d.imageDigest === input.imageDigest);
      if (existing !== undefined) {
        return { kind: 'already-registered', deployment: existing };
      }
      seq += 1;
      const deployment: Deployment = {
        deploymentId: `dep-${seq.toString().padStart(4, '0')}`,
        tenantId: input.tenantId,
        imageRef: input.imageRef,
        imageDigest: input.imageDigest,
        artifactVersion: input.artifactVersion,
        indexHash: input.indexHash,
        signerKeyId: input.signerKeyId,
        signerPublicKey: input.signerPublicKey,
        signature: input.signature,
        publishedAt: input.publishedAt,
        activatedAt: new Date().toISOString(),
        primitives: input.primitives,
        contents: input.contents,
      };
      byTenant.set(input.tenantId as unknown as string, [...list, deployment]);
      return { kind: 'ok', deployment };
    },
    async get({ tenantId, deploymentId }) {
      const list = byTenant.get(tenantId as unknown as string) ?? [];
      return list.find((d) => d.deploymentId === deploymentId) ?? null;
    },
    async getByImageDigest({ tenantId, imageDigest }) {
      const list = byTenant.get(tenantId as unknown as string) ?? [];
      return list.find((d) => d.imageDigest === imageDigest) ?? null;
    },
    async list({ tenantId, limit, cursor, imageRefPrefix, signerKeyId }) {
      const all = byTenant.get(tenantId as unknown as string) ?? [];
      const filtered = all.filter((d) => {
        if (imageRefPrefix !== undefined && !d.imageRef.startsWith(imageRefPrefix)) return false;
        if (
          signerKeyId !== undefined &&
          (d.signerKeyId as unknown as string) !== (signerKeyId as unknown as string)
        )
          return false;
        return true;
      });
      const sorted = [...filtered].sort((a, b) =>
        a.activatedAt === b.activatedAt
          ? b.deploymentId.localeCompare(a.deploymentId)
          : b.activatedAt.localeCompare(a.activatedAt),
      );
      let startAt = 0;
      if (cursor !== undefined) {
        const cur = cursor as unknown as string;
        const idx = sorted.findIndex((d) => d.deploymentId === cur);
        startAt = idx < 0 ? sorted.length : idx + 1;
      }
      const slice = sorted.slice(startAt, startAt + limit);
      const last = slice[slice.length - 1];
      const hasMore = startAt + slice.length < sorted.length;
      return {
        data: slice,
        ...(hasMore &&
          last !== undefined && {
            nextCursor: last.deploymentId as unknown as Cursor,
          }),
      };
    },
  };
}

interface TrustEntry {
  readonly keyId: SigningKeyId;
  readonly publicKey: string; // base64 of raw
  readonly tenantId: TenantId;
}

function makeMockSigningKeyRegistry(trusted: readonly TrustEntry[]): SigningKeyRegistryBinding {
  return {
    async isTrusted({ tenantId, keyId, publicKey }) {
      const match = trusted.find(
        (e) =>
          (e.tenantId as unknown as string) === (tenantId as unknown as string) &&
          (e.keyId as unknown as string) === (keyId as unknown as string) &&
          e.publicKey === publicKey,
      );
      return { kind: 'ok', value: match !== undefined };
    },
    async verify() {
      // Not exercised — the route uses `verifyEd25519` directly.
      return { kind: 'ok', value: { valid: false } };
    },
    async listTrusted() {
      return { data: [] };
    },
    async getTrusted() {
      return null;
    },
    async addTrusted() {
      return { kind: 'error', code: 'noop', message: 'not used' };
    },
    async revokeTrusted() {
      return { revoked: false };
    },
  };
}

interface FakeImage {
  readonly imageRef: string;
  readonly digest: string;
  readonly indexBytes: Uint8Array;
}

function makeMockImageRegistry(images: readonly FakeImage[]): ImageRegistryBinding {
  return {
    async head({ imageRef }) {
      const img = images.find((i) => i.imageRef === imageRef);
      if (img === undefined) {
        return {
          kind: 'err',
          error: { code: 'image-not-found', message: 'no such image', imageRef },
        };
      }
      return {
        kind: 'ok',
        value: {
          digest: img.digest,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          size: img.indexBytes.length,
          layers: [{ digest: img.digest, mediaType: 'x', size: img.indexBytes.length }],
          config: { digest: 'sha256:cfg', mediaType: 'x', size: 0 },
        },
      };
    },
    async extractFile({ imageRef, path }) {
      const img = images.find((i) => i.imageRef === imageRef);
      if (img === undefined) {
        return {
          kind: 'err',
          error: { code: 'image-not-found', message: 'no such image', imageRef },
        };
      }
      if (path !== '/app/index.json') {
        return {
          kind: 'err',
          error: { code: 'image-file-not-found', message: 'no such path', imageRef, path },
        };
      }
      const sha = createHash('sha256').update(img.indexBytes).digest('hex');
      return {
        kind: 'ok',
        value: {
          path,
          bytes: img.indexBytes,
          sha256: sha,
          layerDigest: img.digest,
        },
      };
    },
    async push() {
      return {
        kind: 'err',
        error: { code: 'image-push-failed', message: 'not used' },
      };
    },
  };
}

let lastToolRegisterProjectId: ProjectId | undefined;

function makeInMemoryToolRegistry(): ToolRegistryBinding {
  const store = new Map<string, Map<string, unknown>>();
  const forT = (t: TenantId): Map<string, unknown> => {
    const k = t as unknown as string;
    let s = store.get(k);
    if (s === undefined) {
      s = new Map();
      store.set(k, s);
    }
    return s;
  };
  return {
    async list({ tenantId }) {
      const rows = [...forT(tenantId).values()] as never[];
      return { data: rows };
    },
    async get({ tenantId, toolId }) {
      return (forT(tenantId).get(toolId as unknown as string) as never) ?? null;
    },
    async getVersion() {
      return null;
    },
    async headExists({ tenantId, toolId }) {
      return forT(tenantId).has(toolId as unknown as string);
    },
    async listVersions() {
      return { data: [] };
    },
    async resolve({ toolId }) {
      return { kind: 'not-found', toolId };
    },
    async publish({ tenantId, projectId, tool }) {
      lastToolRegisterProjectId = projectId;
      const s = forT(tenantId);
      if (s.has(tool.id as unknown as string)) {
        return { kind: 'already-registered', toolId: tool.id, version: tool.version as never };
      }
      s.set(tool.id as unknown as string, tool);
      return { kind: 'ok', toolId: tool.id, version: tool.version as never };
    },
    async unregister({ tenantId, toolId }) {
      return { unregistered: forT(tenantId).delete(toolId as unknown as string) };
    },
    async reinstateVersion({ toolId, version }) {
      return { kind: 'not-found', toolId, version };
    },
  };
}

let lastGuardrailRegisterProjectId: ProjectId | undefined;

function makeInMemoryGuardrailRegistry(): GuardrailRegistryBinding {
  const store = new Map<string, Map<string, unknown>>();
  const forT = (t: TenantId): Map<string, unknown> => {
    const k = t as unknown as string;
    let s = store.get(k);
    if (s === undefined) {
      s = new Map();
      store.set(k, s);
    }
    return s;
  };
  return {
    async list({ tenantId }) {
      return { data: [...forT(tenantId).values()] as never[] };
    },
    async get({ tenantId, guardrailId }) {
      return (forT(tenantId).get(guardrailId as unknown as string) as never) ?? null;
    },
    async register({ tenantId, projectId, guardrail }) {
      lastGuardrailRegisterProjectId = projectId;
      const s = forT(tenantId);
      if (s.has(guardrail.id as unknown as string)) {
        return { kind: 'already-registered', guardrailId: guardrail.id };
      }
      s.set(guardrail.id as unknown as string, guardrail);
      return { kind: 'ok', guardrailId: guardrail.id };
    },
    async unregister({ tenantId, guardrailId }) {
      return { unregistered: forT(tenantId).delete(guardrailId as unknown as string) };
    },
  };
}

let lastAgentPublishProjectId: ProjectId | undefined;

function makeInMemoryAgentRegistry(
  opts: { failOnAgentId?: string; refuseAgentId?: string } = {},
): AgentRegistryBinding {
  const store = new Map<string, Map<string, Map<string, unknown>>>();
  return {
    async list() {
      return { data: [] };
    },
    async get() {
      return null;
    },
    async getVersion() {
      return null;
    },
    async headExists() {
      return false;
    },
    async listVersions() {
      return { data: [] };
    },
    async publish({ tenantId, projectId, agent }) {
      lastAgentPublishProjectId = projectId;
      if (
        opts.failOnAgentId !== undefined &&
        (agent.id as unknown as string) === opts.failOnAgentId
      ) {
        throw new Error(`forced failure on agent ${opts.failOnAgentId}`);
      }
      if (
        opts.refuseAgentId !== undefined &&
        (agent.id as unknown as string) === opts.refuseAgentId
      ) {
        return {
          kind: 'project-not-found',
          agentId: agent.id,
          version: agent.version,
          projectId,
        } as never;
      }
      const key = tenantId as unknown as string;
      let byTenant = store.get(key);
      if (byTenant === undefined) {
        byTenant = new Map();
        store.set(key, byTenant);
      }
      let byId = byTenant.get(agent.id as unknown as string);
      if (byId === undefined) {
        byId = new Map();
        byTenant.set(agent.id as unknown as string, byId);
      }
      if (byId.has(agent.version as unknown as string)) {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      byId.set(agent.version as unknown as string, agent);
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister({ tenantId, agentId, version }) {
      const byTenant = store.get(tenantId as unknown as string);
      const byId = byTenant?.get(agentId as unknown as string);
      if (byId === undefined) return { unregistered: false };
      return { unregistered: byId.delete(version as unknown as string) };
    },
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
  };
}

/**
 * Minimal `ProjectBinding` for the deployments-router agent publish
 * loop. Only `getDefault` is exercised by the loop; the other methods
 * throw to make accidental use visible in the test output.
 */
const DEFAULT_PROJECT_ID = randomUUID() as ProjectId;

function makeMockProjectBinding(defaultProjectId: ProjectId = DEFAULT_PROJECT_ID): ProjectBinding {
  const notImpl = (m: string) => async () => {
    throw new Error(`makeMockProjectBinding: ${m} not used in these tests`);
  };
  return {
    async getDefault(): Promise<Project | undefined> {
      return {
        id: defaultProjectId,
        tenantId,
        name: 'Default',
        slug: 'default',
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Project;
    },
    create: notImpl('create') as ProjectBinding['create'],
    get: notImpl('get') as ProjectBinding['get'],
    list: notImpl('list') as ProjectBinding['list'],
    update: notImpl('update') as ProjectBinding['update'],
    delete: notImpl('delete') as ProjectBinding['delete'],
  };
}

let lastFlowPublishProjectId: ProjectId | undefined;

function makeInMemoryFlowRegistry(): FlowRegistryBinding {
  const store = new Map<string, Map<string, Map<string, unknown>>>();
  return {
    async list() {
      return { data: [] };
    },
    async get() {
      return null;
    },
    async getVersion() {
      return null;
    },
    async headExists() {
      return false;
    },
    async listVersions() {
      return { data: [] };
    },
    async publish({ tenantId, projectId, flow }) {
      lastFlowPublishProjectId = projectId;
      const key = tenantId as unknown as string;
      let byTenant = store.get(key);
      if (byTenant === undefined) {
        byTenant = new Map();
        store.set(key, byTenant);
      }
      let byId = byTenant.get(flow.id as unknown as string);
      if (byId === undefined) {
        byId = new Map();
        byTenant.set(flow.id as unknown as string, byId);
      }
      if (byId.has(flow.version)) {
        return { kind: 'already-registered', flowId: flow.id, version: flow.version };
      }
      byId.set(flow.version, flow);
      return { kind: 'ok', flowId: flow.id, version: flow.version };
    },
    async unregister({ tenantId, flowId, version }) {
      const byTenant = store.get(tenantId as unknown as string);
      const byId = byTenant?.get(flowId as unknown as string);
      if (byId === undefined) return { unregistered: false };
      return { unregistered: byId.delete(version) };
    },
    async reinstateVersion({ flowId, version }) {
      return { kind: 'not-found', flowId, version };
    },
  };
}

// ---------------- fixtures ----------------

const KEY_ID = 'aperture-staging-2026-01' as SigningKeyId;

interface SignedDeploy {
  readonly wire: Record<string, unknown>;
  readonly digest: string;
  readonly indexBytes: Uint8Array;
  readonly publicKeyRaw: Uint8Array;
  readonly imageRef: string;
}

function buildSignedDeploy(
  overrides: {
    imageRef?: string;
    artifactVersion?: string;
    publishedAt?: string;
    index?: Record<string, unknown>;
    tenantIdOverride?: TenantId;
    keyId?: SigningKeyId;
    /** The image's `/app/index.json` bytes as they are, in place of `index`. */
    indexBytes?: Uint8Array;
  } = {},
): SignedDeploy {
  const keyPair = generateEd25519KeyPair();
  const index = overrides.index ?? {
    v: 1,
    packId: 'acme.aperture',
    packVersion: '1.0.0',
    artifactVersion: overrides.artifactVersion ?? '20260920.1',
    publishedAt: overrides.publishedAt ?? '2026-09-20T14:32:07.104Z',
    tools: [
      {
        id: 'acme.verify-citation',
        description: 'Verify a legal citation.',
        version: '1.0.0',
        input: { type: 'object', properties: { citation: { type: 'string' } } },
        output: { type: 'object', properties: { verified: { type: 'boolean' } } },
        modulePath: './tools/legal/verify-citation.js',
      },
    ],
    guardrails: [
      {
        id: 'acme.no-fabricated-quotes',
        kind: 'zero-llm',
        check: 'must-cite',
        action: { 'on-violation': 'halt' },
        checkModulePath: './guardrails/must-cite.js',
      },
    ],
    agents: [],
    flows: [],
  };
  const indexBytes = overrides.indexBytes ?? new TextEncoder().encode(JSON.stringify(index));
  const indexSha = createHash('sha256').update(indexBytes).digest('hex');
  const digest = `sha256:${indexSha}`; // reuse as image digest for the fake registry
  const imageRef = overrides.imageRef ?? `ghcr.io/acme/aperture@${digest}`;
  const artifactVersion = overrides.artifactVersion ?? '20260920.1';
  const publishedAt = overrides.publishedAt ?? '2026-09-20T14:32:07.104Z';
  const indexHash = `sha256:${indexSha}`;
  const envTenant = overrides.tenantIdOverride ?? tenantId;
  const envelope = JSON.stringify({
    artifactVersion,
    imageDigest: digest,
    indexHash,
    publishedAt,
    tenantId: envTenant as unknown as string,
  });
  const sig = signEd25519(keyPair.privateKey, new TextEncoder().encode(envelope));
  if (sig.kind === 'err') throw new Error(`sign failed: ${sig.error.message}`);
  const signaturB64 = Buffer.from(sig.value).toString('base64');
  return {
    wire: {
      imageRef,
      artifactVersion,
      indexHash,
      signerKeyId: (overrides.keyId ?? KEY_ID) as unknown as string,
      signerPublicKey: serializePublicKeyPem(keyPair.publicKey),
      signature: signaturB64,
      publishedAt,
    },
    digest,
    indexBytes,
    publicKeyRaw: keyPair.publicKey,
    imageRef,
  };
}

function makeApp(opts: {
  deploymentRegistry?: DeploymentBinding;
  signingKeyRegistry?: SigningKeyRegistryBinding;
  imageRegistry?: ImageRegistryBinding;
  agentRegistry?: AgentRegistryBinding;
  omit?: 'deployment' | 'signing' | 'image';
  omitProjectBinding?: boolean;
  extraTrust?: readonly TrustEntry[];
  extraImages?: readonly FakeImage[];
  fixture?: SignedDeploy;
  writes?: string[];
}) {
  const deploymentRegistry = opts.deploymentRegistry ?? makeInMemoryDeploymentBinding();
  const trust: TrustEntry[] = [
    ...(opts.fixture !== undefined
      ? [
          {
            keyId: KEY_ID,
            tenantId,
            publicKey: Buffer.from(opts.fixture.publicKeyRaw).toString('base64'),
          },
        ]
      : []),
    ...(opts.extraTrust ?? []),
  ];
  const signingKeyRegistry = opts.signingKeyRegistry ?? makeMockSigningKeyRegistry(trust);
  const images: FakeImage[] = [
    ...(opts.fixture !== undefined
      ? [
          {
            imageRef: opts.fixture.imageRef,
            digest: opts.fixture.digest,
            indexBytes: opts.fixture.indexBytes,
          },
        ]
      : []),
    ...(opts.extraImages ?? []),
  ];
  const imageRegistry = opts.imageRegistry ?? makeMockImageRegistry(images);
  const toolRegistry = makeInMemoryToolRegistry();
  const guardrailRegistry = makeInMemoryGuardrailRegistry();
  const agentRegistry = opts.agentRegistry ?? makeInMemoryAgentRegistry();
  const flowRegistry = makeInMemoryFlowRegistry();

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(opts.omit === 'deployment' ? {} : { deploymentRegistry }),
    ...(opts.omit === 'signing' ? {} : { signingKeyRegistry }),
    ...(opts.omit === 'image' ? {} : { imageRegistry }),
    toolRegistry,
    guardrailRegistry,
    agentRegistry,
    flowRegistry,
    // Content-scope anchor — the deployments router's agents publish
    // loop resolves Default project through this binding. Opt out via
    // `omitProjectBinding: true` for the negative-path test.
    ...(opts.omitProjectBinding === true ? {} : { projectBinding: makeMockProjectBinding() }),
    ...(opts.writes !== undefined && {
      onToolWrite: ({ toolId, version, kind }) => {
        opts.writes?.push(`tool ${toolId as unknown as string}@${version} ${kind}`);
      },
      onGuardrailWrite: ({ guardrailId, kind }) => {
        opts.writes?.push(`guardrail ${guardrailId as unknown as string} ${kind}`);
      },
    }),
  });
  return {
    app,
    deploymentRegistry,
    toolRegistry,
    guardrailRegistry,
    agentRegistry,
    flowRegistry,
  };
}

// ---------------- the image's index is what registers ----------------

describe("POST /v1/deployments — the image's index is what registers", () => {
  const post = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
    app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('an index in the request is not read: only what the signed image declares registers', async () => {
    const fixture = buildSignedDeploy();
    const { app, toolRegistry } = makeApp({ fixture });
    const res = await post(app, {
      ...fixture.wire,
      index: {
        tools: [
          {
            id: 'acme.injected',
            description: 'Not in the image.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/injected.js',
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { contents: unknown }).contents).toMatchObject({
      tools: [{ id: 'acme.verify-citation', version: '1.0.0' }],
    });
    expect(await toolRegistry.get({ tenantId, toolId: 'acme.injected' as never })).toBeNull();
  });

  test('an image whose index names another artifactVersion than the signed one is refused', async () => {
    const fixture = buildSignedDeploy({
      artifactVersion: '20260920.1',
      index: {
        v: 1,
        artifactVersion: '20260920.7',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const { app, deploymentRegistry } = makeApp({ fixture });
    const res = await post(app, fixture.wire);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('image-unverifiable');
    expect(body.error.message).toContain('"20260920.7", not the signed 20260920.1');
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toHaveLength(0);
  });

  test('an image whose /app/index.json is not a JSON object is refused', async () => {
    for (const raw of ['not json', '[1,2]', 'null']) {
      const fixture = buildSignedDeploy({ indexBytes: new TextEncoder().encode(raw) });
      const { app } = makeApp({ fixture });
      const res = await post(app, fixture.wire);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error).toMatchObject({
        code: 'image-unverifiable',
        message: 'Image /app/index.json is not a JSON object',
      });
    }
  });
});

// ---------------- happy path ----------------

describe('POST /v1/deployments — happy path', () => {
  test('signed deployment → 201 with all primitives registered', async () => {
    const fixture = buildSignedDeploy();
    const { app, toolRegistry, guardrailRegistry } = makeApp({ fixture });

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      deploymentId: string;
      artifactVersion: string;
      imageRef: string;
      activatedAt: string;
      primitives: DeploymentPrimitiveCounts;
    };
    expect(body.deploymentId).toMatch(/^dep-/);
    expect(body.artifactVersion).toBe('20260920.1');
    expect(body.imageRef).toBe(fixture.imageRef);
    expect(body.primitives.tools).toBe(1);
    expect(body.primitives.guardrails).toBe(1);
    expect(body.primitives.agents).toBe(0);
    expect(body.primitives.flows).toBe(0);
    expect((body as unknown as { contents: unknown }).contents).toEqual({
      tools: [{ id: 'acme.verify-citation', version: '1.0.0' }],
      guardrails: [{ id: 'acme.no-fabricated-quotes' }],
      agents: [],
      flows: [],
    });

    // Primitives landed in their catalogs.
    const tool = await toolRegistry.get({
      tenantId,
      toolId: 'acme.verify-citation' as never,
    });
    expect(tool).not.toBeNull();
    const inv = await guardrailRegistry.get({
      tenantId,
      guardrailId: 'acme.no-fabricated-quotes' as never,
    });
    expect(inv).not.toBeNull();
  });

  test('tools and guardrails keep where their code is: an oci pointer into the deployed image', async () => {
    const fixture = buildSignedDeploy();
    const { app, toolRegistry, guardrailRegistry } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
    const tool = (await toolRegistry.get({
      tenantId,
      toolId: 'acme.verify-citation' as never,
    })) as unknown as Record<string, unknown>;
    expect(tool.codeArtifactRef).toEqual({
      kind: 'oci',
      imageRef: fixture.imageRef,
      modulePath: './tools/legal/verify-citation.js',
      artifactVersion: '20260920.1',
    });
    expect(tool.modulePath).toBeUndefined();
    const guardrail = (await guardrailRegistry.get({
      tenantId,
      guardrailId: 'acme.no-fabricated-quotes' as never,
    })) as unknown as Record<string, unknown>;
    expect(guardrail).toMatchObject({
      check: 'must-cite',
      codeArtifactRef: {
        kind: 'oci',
        imageRef: fixture.imageRef,
        modulePath: './guardrails/must-cite.js',
        artifactVersion: '20260920.1',
      },
    });
  });

  test("a new deployment tells the catalog caches what it registered; a replay doesn't", async () => {
    const fixture = buildSignedDeploy();
    const writes: string[] = [];
    const { app } = makeApp({ fixture, writes });
    const post = () =>
      app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(fixture.wire),
      });
    expect((await post()).status).toBe(201);
    expect(writes).toEqual([
      'tool acme.verify-citation@1.0.0 publish',
      'guardrail acme.no-fabricated-quotes register',
    ]);
    expect((await post()).status).toBe(200);
    expect(writes).toHaveLength(2);
  });

  test('a guardrail as the indexer writes it (checkId, configSchema) deploys, its check from checkId', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [
          {
            id: 'acme.cites',
            name: 'cites',
            kind: 'zero-llm',
            action: { 'on-violation': 'halt' },
            severity: 'error',
            scope: { when: 'runtime-only' },
            checkModulePath: 'guardrails/cites.mjs',
            checkId: 'acme.checks.cites',
            configSchema: { type: 'object', properties: { strict: { type: 'boolean' } } },
            config: { strict: true },
          },
        ],
        agents: [],
        flows: [],
      },
    });
    const { app, guardrailRegistry } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const guardrail = (await guardrailRegistry.get({
      tenantId,
      guardrailId: 'acme.cites' as never,
    })) as unknown as Record<string, unknown>;
    expect(guardrail).toMatchObject({
      check: 'acme.checks.cites',
      config: { strict: true },
      codeArtifactRef: { kind: 'oci', modulePath: 'guardrails/cites.mjs' },
    });
    expect(guardrail.checkId).toBeUndefined();
    expect(guardrail.configSchema).toBeUndefined();
  });

  test("an index that declares the pack's process env deploys; the env is signed content, not a primitive", async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [],
        env: { optional: ['LOG_LEVEL'], required: ['DATABASE_URL'] },
      },
    });
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

// ---------------- signature failures ----------------

describe('POST /v1/deployments — signature verification', () => {
  test('bad signature → 400 signature-invalid', async () => {
    const fixture = buildSignedDeploy();
    const bad = { ...fixture.wire, signature: Buffer.from(new Uint8Array(64)).toString('base64') };
    const { app } = makeApp({ fixture });

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('signature-invalid');
  });

  test('signer key not trusted → 403 signer-not-trusted', async () => {
    const fixture = buildSignedDeploy();
    // Do NOT include the fixture's public key in the trust list.
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([
        { imageRef: fixture.imageRef, digest: fixture.digest, indexBytes: fixture.indexBytes },
      ]),
      toolRegistry: makeInMemoryToolRegistry(),
      guardrailRegistry: makeInMemoryGuardrailRegistry(),
    });

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('signer-not-trusted');
  });
});

// ---------------- image failures ----------------

describe('POST /v1/deployments — image verification', () => {
  test('image unpullable → 400 image-unverifiable', async () => {
    const fixture = buildSignedDeploy();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([
        {
          keyId: KEY_ID,
          tenantId,
          publicKey: Buffer.from(fixture.publicKeyRaw).toString('base64'),
        },
      ]),
      imageRegistry: makeMockImageRegistry([]), // no images
      toolRegistry: makeInMemoryToolRegistry(),
      guardrailRegistry: makeInMemoryGuardrailRegistry(),
    });

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('image-unverifiable');
  });

  test('image digest mismatch → 400 image-unverifiable', async () => {
    const fixture = buildSignedDeploy();
    const bogusDigest = `sha256:${'0'.repeat(64)}`;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([
        {
          keyId: KEY_ID,
          tenantId,
          publicKey: Buffer.from(fixture.publicKeyRaw).toString('base64'),
        },
      ]),
      // Registry returns a different digest than what the ref says.
      imageRegistry: makeMockImageRegistry([
        { imageRef: fixture.imageRef, digest: bogusDigest, indexBytes: fixture.indexBytes },
      ]),
      toolRegistry: makeInMemoryToolRegistry(),
      guardrailRegistry: makeInMemoryGuardrailRegistry(),
    });

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('image-unverifiable');
  });

  test('indexHash mismatch → 400 image-unverifiable', async () => {
    const fixture = buildSignedDeploy();
    // Serve a different index.json than the one hashed into indexHash.
    const differentIndex = new TextEncoder().encode(JSON.stringify({ v: 1, unrelated: true }));
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([
        {
          keyId: KEY_ID,
          tenantId,
          publicKey: Buffer.from(fixture.publicKeyRaw).toString('base64'),
        },
      ]),
      imageRegistry: makeMockImageRegistry([
        { imageRef: fixture.imageRef, digest: fixture.digest, indexBytes: differentIndex },
      ]),
      toolRegistry: makeInMemoryToolRegistry(),
      guardrailRegistry: makeInMemoryGuardrailRegistry(),
    });

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('image-unverifiable');
  });
});

// ---------------- manifest validation ----------------

describe('POST /v1/deployments — manifest validation', () => {
  test('tool manifest invalid → 400 deployment-validation-failed with per-primitive details', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [{ id: '' /* invalid */, description: 'bad', input: {}, output: {} }],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ primitive: string; index: number }> } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues?.some((d) => d.primitive === 'tool' && d.index === 0)).toBe(
      true,
    );
  });

  test('guardrail manifest invalid → 400 deployment-validation-failed', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [
          // `kind` is an open string (adapter kinds are allowed) but must not be empty.
          { id: 'x', kind: '', check: 'y', action: { 'on-violation': 'halt' } },
        ],
        agents: [],
        flows: [],
      },
    });
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ primitive: string }> } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues?.some((d) => d.primitive === 'guardrail')).toBe(true);
  });

  test('agent manifest invalid → 400 deployment-validation-failed', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [{ id: '' }],
        flows: [],
      },
    });
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ primitive: string }> } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues?.some((d) => d.primitive === 'agent')).toBe(true);
  });

  test('flow manifest invalid → 400 deployment-validation-failed', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [{ id: 'ingest.foo', version: 'not-semver', nodes: 'not-array', edges: [] }],
      },
    });
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ primitive: string }> } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues?.some((d) => d.primitive === 'flow')).toBe(true);
  });
});

// ---------------- rollback ----------------

describe('POST /v1/deployments — rollback', () => {
  test('agent publish throw mid-transaction → 500 + tool/guardrail rolled back', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.verify-citation',
            description: 'x',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
          },
        ],
        guardrails: [
          {
            id: 'acme.no-fabricated-quotes',
            kind: 'zero-llm',
            check: 'must-cite',
            action: { 'on-violation': 'halt' },
          },
        ],
        agents: [
          {
            id: 'acme.drafting',
            version: '1.0.0',
            name: 'Drafting',
            instructions: 'do it',
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
          },
        ],
        flows: [],
      },
    });
    const { app, toolRegistry, guardrailRegistry } = makeApp({
      fixture,
      agentRegistry: makeInMemoryAgentRegistry({ failOnAgentId: 'acme.drafting' }),
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    // Tool + guardrail should have been rolled back.
    const tool = await toolRegistry.get({
      tenantId,
      toolId: 'acme.verify-citation' as never,
    });
    expect(tool).toBeNull();
    const inv = await guardrailRegistry.get({
      tenantId,
      guardrailId: 'acme.no-fabricated-quotes' as never,
    });
    expect(inv).toBeNull();
  });

  test("a primitive refused with a typed outcome (project-not-found) → that outcome's 404, rolled back, no deployment (T205)", async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.verify-citation',
            description: 'x',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
          },
        ],
        guardrails: [
          {
            id: 'acme.no-fabricated-quotes',
            kind: 'zero-llm',
            check: 'must-cite',
            action: { 'on-violation': 'halt' },
          },
        ],
        agents: [
          {
            id: 'acme.drafting',
            version: '1.0.0',
            name: 'Drafting',
            instructions: 'do it',
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
          },
        ],
        flows: [],
      },
    });
    const deploymentRegistry = makeInMemoryDeploymentBinding();
    const { app, toolRegistry, guardrailRegistry } = makeApp({
      fixture,
      agentRegistry: makeInMemoryAgentRegistry({ refuseAgentId: 'acme.drafting' }),
      deploymentRegistry,
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('project-not-found');
    expect(body.error.message).toBe(
      "The agent acme.drafting@1.0.0 wasn't published: project-not-found; nothing was deployed",
    );
    expect(body.error.details).toEqual({ primitive: 'agent', id: 'acme.drafting@1.0.0' });
    // Before: skipped, and the deployment recorded without its agent.
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
    ).toBeNull();
    expect(
      await guardrailRegistry.get({ tenantId, guardrailId: 'acme.no-fabricated-quotes' as never }),
    ).toBeNull();
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });
});

// ---------------- idempotency ----------------

describe('POST /v1/deployments — idempotency', () => {
  test('same digest re-submitted → 200 with same deploymentId', async () => {
    const fixture = buildSignedDeploy();
    const { app } = makeApp({ fixture });
    const first = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { deploymentId: string; artifactVersion: string };

    const second = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { deploymentId: string; artifactVersion: string };
    expect(secondBody.deploymentId).toBe(firstBody.deploymentId);
    expect(secondBody.artifactVersion).toBe(firstBody.artifactVersion);
  });

  test('different digest → new deployment record', async () => {
    // Two fixtures with distinct indexes.
    const a = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const b = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.2',
        publishedAt: '2026-09-20T14:35:00.000Z',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [],
      },
      artifactVersion: '20260920.2',
      publishedAt: '2026-09-20T14:35:00.000Z',
    });

    // Trust both signers, host both images in the same app.
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([
        { keyId: KEY_ID, tenantId, publicKey: Buffer.from(a.publicKeyRaw).toString('base64') },
        { keyId: KEY_ID, tenantId, publicKey: Buffer.from(b.publicKeyRaw).toString('base64') },
      ]),
      imageRegistry: makeMockImageRegistry([
        { imageRef: a.imageRef, digest: a.digest, indexBytes: a.indexBytes },
        { imageRef: b.imageRef, digest: b.digest, indexBytes: b.indexBytes },
      ]),
      toolRegistry: makeInMemoryToolRegistry(),
      guardrailRegistry: makeInMemoryGuardrailRegistry(),
    });

    const res1 = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(a.wire),
    });
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as { deploymentId: string; artifactVersion: string };

    const res2 = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(b.wire),
    });
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { deploymentId: string; artifactVersion: string };
    expect(body2.deploymentId).not.toBe(body1.deploymentId);
    expect(body2.artifactVersion).toBe('20260920.2');
  });
});

// ---------------- list / get ----------------

describe('GET /v1/deployments', () => {
  test('list happy path + pagination', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
      toolRegistry: makeInMemoryToolRegistry(),
      guardrailRegistry: makeInMemoryGuardrailRegistry(),
    });
    // Seed via direct binding rather than through the full pipe.
    const binding = makeInMemoryDeploymentBinding();
    for (let i = 0; i < 3; i++) {
      await binding.register({
        tenantId,
        imageRef: `ghcr.io/a/pack@sha256:${'a'.repeat(63)}${i}`,
        imageDigest: `sha256:${'a'.repeat(63)}${i}`,
        artifactVersion: `20260920.${i + 1}`,
        indexHash: `sha256:${'b'.repeat(64)}`,
        signerKeyId: KEY_ID,
        signerPublicKey: 'noop',
        signature: 'noop',
        publishedAt: '2026-09-20T14:32:07.104Z',
        primitives: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
        contents: { tools: [], guardrails: [], agents: [], flows: [] },
      });
    }
    const app2 = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: binding,
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });

    const res = await app2.request('/v1/deployments?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean; nextCursor?: string };
    expect(body.data.length).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBeTruthy();

    // suppress unused
    expect(app.request).toBeTypeOf('function');
  });

  test('imageRefPrefix filter narrows results', async () => {
    const binding = makeInMemoryDeploymentBinding();
    await binding.register({
      tenantId,
      imageRef:
        'ghcr.io/a/x@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      imageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifactVersion: '20260920.1',
      indexHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      signerKeyId: KEY_ID,
      signerPublicKey: 'x',
      signature: 'y',
      publishedAt: '2026-09-20T14:32:07.104Z',
      primitives: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
      contents: { tools: [], guardrails: [], agents: [], flows: [] },
    });
    await binding.register({
      tenantId,
      imageRef:
        'ghcr.io/b/y@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      imageDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      artifactVersion: '20260920.2',
      indexHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      signerKeyId: KEY_ID,
      signerPublicKey: 'x',
      signature: 'y',
      publishedAt: '2026-09-20T14:32:07.104Z',
      primitives: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
      contents: { tools: [], guardrails: [], agents: [], flows: [] },
    });
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: binding,
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });

    const res = await app.request('/v1/deployments?imageRefPrefix=ghcr.io/a/', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ imageRef: string }> };
    expect(body.data.map((d) => d.imageRef)).toEqual([
      'ghcr.io/a/x@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
  });

  test('get single deployment by id', async () => {
    const fixture = buildSignedDeploy();
    const { app } = makeApp({ fixture });
    const registered = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    const registeredBody = (await registered.json()) as { deploymentId: string };
    const res = await app.request(`/v1/deployments/${registeredBody.deploymentId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploymentId: string; imageRef: string };
    expect(body.deploymentId).toBe(registeredBody.deploymentId);
    expect(body.imageRef).toBe(fixture.imageRef);
  });

  test('unknown deploymentId → 404 deployment-not-found', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });
    const res = await app.request('/v1/deployments/dep-does-not-exist', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('deployment-not-found');
  });
});

// ---------------- cross-tenant isolation ----------------

describe('/v1/deployments — cross-tenant isolation', () => {
  test('deployment from tenant A invisible to tenant B', async () => {
    const fixture = buildSignedDeploy();
    const { app } = makeApp({ fixture });
    const registered = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    const registeredBody = (await registered.json()) as { deploymentId: string };

    // Query as tenant B — nothing.
    const list = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: unknown[] };
    expect(listBody.data).toEqual([]);

    const single = await app.request(`/v1/deployments/${registeredBody.deploymentId}`, {
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(single.status).toBe(404);
  });
});

// ---------------- projectBinding required for agents + flows + guardrails ----------------

describe('POST /v1/deployments — agents/flows/guardrails loops require projectBinding', () => {
  test('deployment with agents but no projectBinding wired → 500 internal-server-error', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [
          {
            id: 'acme.drafting',
            version: '1.0.0',
            name: 'Drafting',
            instructions: 'do it',
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
          },
        ],
        flows: [],
      },
    });
    const { app } = makeApp({ fixture, omitProjectBinding: true });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal-server-error');
    expect(body.error.message).toContain('projectBinding');
  });

  test('deployment with flows but no projectBinding wired → 500 internal-server-error', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [
          {
            id: 'ingest.contract-pdf',
            version: '1.0.0',
            nodes: [{ id: 'n', kind: 'tool', ref: 'inline' }],
            edges: [
              { id: 'e0', from: '$start', to: 'n' },
              { id: 'e1', from: 'n', to: '$end' },
            ],
          },
        ],
      },
    });
    const { app } = makeApp({ fixture, omitProjectBinding: true });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal-server-error');
    expect(body.error.message).toContain('projectBinding');
  });

  test('agents loop threads Default projectId to agentRegistry.publish', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [
          {
            id: 'acme.thread-check',
            version: '1.0.0',
            name: 'Thread Check',
            instructions: 'do it',
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
          },
        ],
        flows: [],
      },
    });
    lastAgentPublishProjectId = undefined;
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
    expect(lastAgentPublishProjectId as unknown as string).toBe(
      DEFAULT_PROJECT_ID as unknown as string,
    );
  });

  test('flows loop threads Default projectId to flowRegistry.publish', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [
          {
            id: 'ingest.thread-check',
            version: '1.0.0',
            nodes: [{ id: 'n', kind: 'tool', ref: 'inline' }],
            edges: [
              { id: 'e0', from: '$start', to: 'n' },
              { id: 'e1', from: 'n', to: '$end' },
            ],
          },
        ],
      },
    });
    lastFlowPublishProjectId = undefined;
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
    expect(lastFlowPublishProjectId as unknown as string).toBe(
      DEFAULT_PROJECT_ID as unknown as string,
    );
  });

  test('deployment with guardrails but no projectBinding wired → 500 internal-server-error', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [
          {
            id: 'acme.no-fabricated-quotes',
            kind: 'zero-llm',
            check: 'must-cite',
            action: { 'on-violation': 'halt' },
          },
        ],
        agents: [],
        flows: [],
      },
    });
    const { app } = makeApp({ fixture, omitProjectBinding: true });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal-server-error');
    expect(body.error.message).toContain('projectBinding');
  });

  test('deployment with tools but no projectBinding wired → 500 internal-server-error', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.verify-citation',
            description: 'Verify a legal citation.',
            version: '1.0.0',
            input: { type: 'object', properties: { citation: { type: 'string' } } },
            output: { type: 'object', properties: { verified: { type: 'boolean' } } },
          },
        ],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const { app } = makeApp({ fixture, omitProjectBinding: true });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal-server-error');
    expect(body.error.message).toContain('projectBinding');
  });

  test('guardrails loop threads Default projectId to guardrailRegistry.register', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [
          {
            id: 'acme.thread-check',
            kind: 'zero-llm',
            check: 'must-cite',
            action: { 'on-violation': 'halt' },
          },
        ],
        agents: [],
        flows: [],
      },
    });
    lastGuardrailRegisterProjectId = undefined;
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
    expect(lastGuardrailRegisterProjectId as unknown as string).toBe(
      DEFAULT_PROJECT_ID as unknown as string,
    );
  });

  test('tools loop threads Default projectId to toolRegistry.register', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.thread-check',
            description: 'thread-check',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
          },
        ],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    lastToolRegisterProjectId = undefined;
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
    expect(lastToolRegisterProjectId as unknown as string).toBe(
      DEFAULT_PROJECT_ID as unknown as string,
    );
  });

  test('deployment with NO agents, flows, tools, or guardrails does not require projectBinding', async () => {
    // Default fixture has 1 tool + 1 guardrail, so we override to zero primitives
    // to prove the projectBinding gate stays closed when nothing needs a project.
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const { app } = makeApp({ fixture, omitProjectBinding: true });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
  });
});

// ---------------- unmounted surface ----------------

describe('/v1/deployments — unmounted when bindings absent', () => {
  test('no deploymentRegistry → 404 at Hono level', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });
    const res = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('no signingKeyRegistry → 404 at Hono level', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      imageRegistry: makeMockImageRegistry([]),
    });
    const res = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('no imageRegistry → 404 at Hono level', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: makeInMemoryDeploymentBinding(),
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
    });
    const res = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------
// POST /v1/deployments/:deploymentId/secrets
// ------------------------------------------------------------------

const SECRETS_TOKEN = 'deployments-token-with-secrets-write';
const NO_CAPS_TOKEN = 'deployments-token-no-caps';

const resolveTokenWithCaps: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  if (token === SECRETS_TOKEN) {
    return { tenantId, capabilities: ['secrets:write'] };
  }
  if (token === NO_CAPS_TOKEN) return { tenantId, capabilities: [] };
  return null;
};

interface RecordedSet {
  readonly scope: Scope;
  readonly envName: string;
  readonly name: string;
  readonly value: string;
  readonly tags?: Readonly<Record<string, string>>;
}

interface FixtureSecretBinding {
  readonly binding: SecretBinding;
  readonly records: Map<string, { record: SecretRecord; versions: SecretVersionRecord[] }>;
  readonly recordedSets: RecordedSet[];
}

/**
 * Minimal in-memory `SecretBinding` for exercising the deployments
 * secret-sync route. Supports `get` + `set` (only the two methods the
 * route calls); the remaining methods throw so accidental use surfaces
 * in test output.
 */
function makeFixtureSecretBinding(
  seed: readonly {
    scope: Scope;
    envName: string;
    name: string;
    currentVersion: number;
  }[] = [],
): FixtureSecretBinding {
  const records = new Map<string, { record: SecretRecord; versions: SecretVersionRecord[] }>();
  const recordedSets: RecordedSet[] = [];
  const keyFor = (scope: Scope, envName: string, name: string): string =>
    `${scopeKey(scope)}::${envName}::${name}`;
  for (const s of seed) {
    const rec: SecretRecord = {
      scope: s.scope,
      envName: s.envName as never,
      name: s.name,
      currentVersion: s.currentVersion,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    records.set(keyFor(s.scope, s.envName, s.name), { record: rec, versions: [] });
  }
  const notImpl = (m: string) => async () => {
    throw new Error(`FixtureSecretBinding.${m} not exercised by the deployments router`);
  };
  const binding: SecretBinding = {
    list: notImpl('list') as SecretBinding['list'],
    async get(input) {
      const row = records.get(keyFor(input.scope, input.envName as unknown as string, input.name));
      return row?.record ?? null;
    },
    resolve: notImpl('resolve') as SecretBinding['resolve'],
    getVersion: notImpl('getVersion') as SecretBinding['getVersion'],
    listVersions: notImpl('listVersions') as SecretBinding['listVersions'],
    async set(input) {
      recordedSets.push({
        scope: input.scope,
        envName: input.envName as unknown as string,
        name: input.name,
        value: input.value,
        ...(input.tags !== undefined && { tags: input.tags }),
      });
      const k = keyFor(input.scope, input.envName as unknown as string, input.name);
      const existing = records.get(k);
      const nextV = (existing?.record.currentVersion ?? 0) + 1;
      const rec: SecretRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        currentVersion: nextV,
        createdAt: existing?.record.createdAt ?? '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:01.000Z',
        ...(input.tags !== undefined && { tags: input.tags }),
      };
      const versions = existing?.versions ?? [];
      versions.push({
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        versionId: nextV,
        createdAt: rec.updatedAt,
        value: null,
      });
      records.set(k, { record: rec, versions });
      return { kind: 'ok', record: rec, versionId: nextV };
    },
    rotate: notImpl('rotate') as SecretBinding['rotate'],
    revoke: notImpl('revoke') as SecretBinding['revoke'],
  };
  return { binding, records, recordedSets };
}

function scopeKey(s: Scope): string {
  switch (s.kind) {
    case 'tenant':
      return `tenant:${s.tenantId as unknown as string}`;
    case 'org':
      return `org:${s.tenantId as unknown as string}:${s.orgId as unknown as string}`;
    case 'project':
      return `project:${s.tenantId as unknown as string}:${s.projectId as unknown as string}`;
    default:
      return 'unknown';
  }
}

interface SyncFixtures {
  readonly app: ReturnType<typeof createApp>;
  readonly deploymentRegistry: DeploymentBinding;
  readonly secretsFixture: FixtureSecretBinding;
  readonly deploymentId: string;
}

async function makeSyncApp(
  opts: {
    seedSecrets?: readonly {
      scope: Scope;
      envName: string;
      name: string;
      currentVersion: number;
    }[];
    omitSecretsBinding?: boolean;
    seedProjectIdOnDeployment?: string;
    resolveTokenOverride?: TokenResolver;
  } = {},
): Promise<SyncFixtures> {
  const secretsFixture = makeFixtureSecretBinding(opts.seedSecrets ?? []);
  const deploymentRegistry = makeInMemoryDeploymentBinding();

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: opts.resolveTokenOverride ?? resolveTokenWithCaps,
    runHandler,
    deploymentRegistry,
    signingKeyRegistry: makeMockSigningKeyRegistry([]),
    imageRegistry: makeMockImageRegistry([]),
    ...(!opts.omitSecretsBinding && { secretsBinding: secretsFixture.binding }),
  });

  // Seed one deployment so the sync route has a valid target.
  const registerOutcome = await deploymentRegistry.register({
    tenantId,
    imageRef:
      'ghcr.io/acme/pack@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    imageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    artifactVersion: '20260922.1',
    indexHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    signerKeyId: 'k' as never,
    signerPublicKey: 'unused',
    signature: 'unused',
    publishedAt: '2026-09-22T00:00:00.000Z',
    primitives: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
    contents: { tools: [], guardrails: [], agents: [], flows: [] },
  });
  if (registerOutcome.kind !== 'ok') {
    throw new Error('failed to seed deployment');
  }
  const deploymentId = registerOutcome.deployment.deploymentId;

  // Optionally attach a projectId to exercise the project-scope path.
  // The in-memory binding stores the returned deployment as-is; monkey-
  // patch its `.get` so the router picks up the extra field.
  if (opts.seedProjectIdOnDeployment !== undefined) {
    const original = deploymentRegistry.get.bind(deploymentRegistry);
    (deploymentRegistry as { get: DeploymentBinding['get'] }).get = async (input) => {
      const rec = await original(input);
      if (rec === null) return null;
      return {
        ...rec,
        projectId: opts.seedProjectIdOnDeployment,
      } as Deployment & { readonly projectId: string };
    };
  }

  return { app, deploymentRegistry, secretsFixture, deploymentId };
}

describe('POST /v1/deployments/:deploymentId/secrets — happy paths', () => {
  test('{ name, ref } entries validate against SecretBinding.get + echo ref + version', async () => {
    const envName = makeEnvName('staging');
    if (envName === null) throw new Error('envName');
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      seedSecrets: [
        {
          scope: { kind: 'tenant', tenantId } as Scope,
          envName: 'staging',
          name: 'stripe.key',
          currentVersion: 4,
        },
        {
          scope: { kind: 'tenant', tenantId } as Scope,
          envName: 'staging',
          name: 'db.url',
          currentVersion: 1,
        },
      ],
    });

    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [
          { name: 'stripe.key', ref: 'secret:staging/stripe.key' },
          { name: 'db.url', ref: 'kms://vault/prod/db-url' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolved: number;
      added: number;
      references: Array<{ name: string; ref: string; version: number }>;
    };
    expect(body.resolved).toBe(2);
    expect(body.added).toBe(0);
    expect(body.references).toHaveLength(2);
    expect(body.references[0]).toEqual({
      name: 'stripe.key',
      ref: 'secret:staging/stripe.key',
      version: 4,
    });
    expect(body.references[1]).toEqual({
      name: 'db.url',
      ref: 'kms://vault/prod/db-url',
      version: 1,
    });
    // No set-calls happened (validate-only path).
    expect(secretsFixture.recordedSets).toHaveLength(0);
    // Silence unused-import lint.
    void envName;
  });

  test('{ name, value } entries write via SecretBinding.set + return created ref', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp();

    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [
          { name: 'api.token', value: 'plaintext-abc-123' },
          { name: 'other.key', value: 'plaintext-xyz' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolved: number;
      added: number;
      references: Array<{ name: string; ref: string; version: number }>;
    };
    expect(body.resolved).toBe(0);
    expect(body.added).toBe(2);
    // Framework-generated references — no plaintext round-trip.
    expect(body.references[0]?.ref).toBe('secret:staging/api.token#1');
    expect(body.references[0]?.version).toBe(1);
    expect(body.references[1]?.ref).toBe('secret:staging/other.key#1');

    // Verify SecretBinding.set was called with add-version + deployment tag.
    expect(secretsFixture.recordedSets).toHaveLength(2);
    const first = secretsFixture.recordedSets[0];
    expect(first?.value).toBe('plaintext-abc-123');
    expect(first?.tags).toEqual({ deployment: deploymentId });
    expect(first?.scope.kind).toBe('tenant');
  });

  test('mixed { name, ref } + { name, value } entries in one request', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      seedSecrets: [
        {
          scope: { kind: 'tenant', tenantId } as Scope,
          envName: 'staging',
          name: 'existing',
          currentVersion: 2,
        },
      ],
    });
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [
          { name: 'existing', ref: 'vault:prod/existing' },
          { name: 'fresh', value: 'brand-new-value' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: number; added: number };
    expect(body.resolved).toBe(1);
    expect(body.added).toBe(1);
    expect(secretsFixture.recordedSets).toHaveLength(1);
  });
});

describe('POST /v1/deployments/:deploymentId/secrets — scope determination', () => {
  test('tenant-scoped deployment → writes to { kind: "tenant", tenantId }', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp();
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [{ name: 'k', value: 'v' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(secretsFixture.recordedSets).toHaveLength(1);
    const scope = secretsFixture.recordedSets[0]?.scope;
    expect(scope?.kind).toBe('tenant');
    if (scope?.kind === 'tenant') {
      expect(scope.tenantId).toBe(tenantId);
    }
  });

  test('project-scoped deployment → writes to { kind: "project", tenantId, projectId }', async () => {
    // Simulate the planned shape where deployments
    // carry a projectId. The binding-get shim (seedProjectIdOnDeployment)
    // attaches the field so `deriveScopeFromDeployment` picks it up.
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      seedProjectIdOnDeployment: DEFAULT_PROJECT_ID as unknown as string,
    });
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'production',
        secrets: [{ name: 'k', value: 'v' }],
      }),
    });
    expect(res.status).toBe(200);
    const scope = secretsFixture.recordedSets[0]?.scope;
    expect(scope?.kind).toBe('project');
    if (scope?.kind === 'project') {
      expect(scope.tenantId).toBe(tenantId);
      expect(scope.projectId as unknown as string).toBe(DEFAULT_PROJECT_ID as unknown as string);
    }
  });

  test('body scope override is REFUSED — server derives scope from deployment row', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp();
    // A caller trying to sneak a project scope override in the body
    // does NOT influence the SecretBinding.set call — the server-side
    // scope-derivation is authoritative. (`scope` is not part of the
    // request schema, so an extra field is simply ignored.)
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        scope: { kind: 'project', tenantId, projectId: 'attacker-project' },
        secrets: [{ name: 'k', value: 'v' }],
      }),
    });
    expect(res.status).toBe(200);
    const scope = secretsFixture.recordedSets[0]?.scope;
    expect(scope?.kind).toBe('tenant');
  });
});

describe('POST /v1/deployments/:deploymentId/secrets — error paths', () => {
  test('{ name, ref } pointing at a missing secret → 404 secret-not-found', async () => {
    const { app, deploymentId } = await makeSyncApp();
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [{ name: 'unknown', ref: 'vault:prod/unknown' }],
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { name?: string } };
    };
    expect(body.error.code).toBe('secret-not-found');
    expect(body.error.details?.name).toBe('unknown');
  });

  test('missing `secrets:write` capability → 403 permission-denied', async () => {
    const { app, deploymentId } = await makeSyncApp();
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${NO_CAPS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [{ name: 'k', value: 'v' }],
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('permission-denied');
  });

  test('unknown deployment id → 404 deployment-not-found', async () => {
    const { app } = await makeSyncApp();
    const res = await app.request('/v1/deployments/dep-does-not-exist/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [{ name: 'k', value: 'v' }],
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('deployment-not-found');
  });

  test('missing envName → 400 env-name-required', async () => {
    const { app, deploymentId } = await makeSyncApp();
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ secrets: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('env-name-required');
  });

  test('entry with both ref AND value → 400 bad-input', async () => {
    const { app, deploymentId } = await makeSyncApp();
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [{ name: 'k', ref: 'v:x', value: 'oops' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toContain('exactly one');
  });

  test('secretsBinding not wired → 500 with actionable message', async () => {
    const { app, deploymentId } = await makeSyncApp({ omitSecretsBinding: true });
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ envName: 'staging', secrets: [] }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal-server-error');
    expect(body.error.message).toContain('secretsBinding');
  });
});

describe('POST /v1/deployments/:deploymentId/secrets — Idempotency-Key', () => {
  test('same key returns same response byte-identical; different key runs the write again', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp();
    const body = JSON.stringify({
      envName: 'staging',
      secrets: [{ name: 'k', value: 'v1' }],
    });
    const first = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'sha256:aaaa',
      },
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { added: number; references: unknown[] };
    expect(firstBody.added).toBe(1);
    expect(secretsFixture.recordedSets).toHaveLength(1);

    // Same key + same body → replay, no additional write.
    const replay = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'sha256:aaaa',
      },
      body,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { added: number };
    expect(replayBody.added).toBe(1);
    expect(secretsFixture.recordedSets).toHaveLength(1);

    // Different key → write happens again (new version).
    const secondKey = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'sha256:bbbb',
      },
      body,
    });
    expect(secondKey.status).toBe(200);
    expect(secretsFixture.recordedSets).toHaveLength(2);
  });
});
