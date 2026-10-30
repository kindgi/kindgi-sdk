// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Agent, type AgentPins, pinsDigest } from '@kindgi/agents';
import { SELF_HOSTED_BOUNDS, currentTenant } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { generateEd25519KeyPair, serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import { type Flow, type FlowPins, flowPinsDigest } from '@kindgi/flow';
import type { Guardrail } from '@kindgi/guardrails';
import type { LogFields, Logger } from '@kindgi/log';
import type { Project, ProjectBinding } from '@kindgi/platform';
import { latestVersion } from '@kindgi/tools';
import type {
  Cursor,
  EnvName,
  OrgId,
  ProjectId,
  Semver,
  SigningKeyId,
  TenantId,
} from '@kindgi/types';

import type { Scope } from '@kindgi/platform';
import { makeEnvName } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, resolveAtScope, scopeOfRecorded } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinResolveInput,
  AgentRegistryBinding,
  Deployment,
  DeploymentBinding,
  DeploymentPrimitiveCounts,
  DeploymentRegisterInput,
  FlowRegistryBinding,
  GuardrailRegistryBinding,
  ImageRegistryBinding,
  ImageRegistryError,
  PinnedResolveInput,
  ProviderRegistryBinding,
  RunHandlerBinding,
  SecretBinding,
  SecretRecord,
  SecretVersionRecord,
  SigningKeyBinding as SigningKeyRegistryBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';
import { sameGuardrailDefinition } from '../src/routes/deployments.js';
import { expectCompileBudgetRefused } from './support/compile-budget.js';
import { environmentOrders } from './support/environment-orders.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';
import { toolPinsBinding } from './support/tool-pins.js';

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
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.packEnv !== undefined && { packEnv: input.packEnv }),
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

/** JSON with keys sorted: equality of values, as a store compares them. */
function canon(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function makeInMemoryToolRegistry(opts: { refreshes?: boolean } = {}): ToolRegistryBinding {
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
    async getVersion({ tenantId, toolId, version }) {
      const tool = forT(tenantId).get(toolId as unknown as string) as
        | { version?: string }
        | undefined;
      return tool !== undefined && tool.version === (version as unknown as string)
        ? (tool as never)
        : null;
    },
    async headExists({ tenantId, toolId }) {
      return forT(tenantId).has(toolId as unknown as string);
    },
    ...(opts.refreshes === true && {
      async refreshCodeArtifactRef({ tenantId, toolId, codeArtifactRef, expected }) {
        const s = forT(tenantId);
        const tool = s.get(toolId as unknown as string) as Record<string, unknown> | undefined;
        if (tool === undefined) return { refreshed: false };
        if (expected !== undefined && canon(tool.codeArtifactRef) !== canon(expected)) {
          return { refreshed: false };
        }
        const { codeArtifactRef: _old, ...rest } = tool;
        s.set(toolId as unknown as string, {
          ...rest,
          ...(codeArtifactRef !== null && { codeArtifactRef }),
        });
        return { refreshed: true };
      },
    }),
    async listVersions({ tenantId, toolId }) {
      const tool = forT(tenantId).get(toolId as unknown as string);
      return { data: tool === undefined ? [] : [tool as never] };
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

/** Guardrails by tenant, each row in its project, as the registry keeps them. */
function makeInMemoryGuardrailRegistry(
  opts: { refreshes?: boolean } = {},
): GuardrailRegistryBinding {
  const store = new Map<string, Map<string, { guardrail: unknown; projectId: ProjectId }>>();
  const forT = (t: TenantId): Map<string, { guardrail: unknown; projectId: ProjectId }> => {
    const k = t as unknown as string;
    let s = store.get(k);
    if (s === undefined) {
      s = new Map();
      store.set(k, s);
    }
    return s;
  };
  return {
    async list({ tenantId, scope, nameFilter }) {
      const rows = [...forT(tenantId).entries()]
        .filter(([id]) => nameFilter === undefined || id.startsWith(nameFilter))
        .filter(([, row]) => scope?.kind !== 'project' || row.projectId === scope.projectId);
      return { data: rows.map(([, row]) => row.guardrail) as never[] };
    },
    async get({ tenantId, guardrailId }) {
      return (forT(tenantId).get(guardrailId as unknown as string)?.guardrail as never) ?? null;
    },
    async register({ tenantId, projectId, guardrail }) {
      lastGuardrailRegisterProjectId = projectId;
      const s = forT(tenantId);
      if (s.has(guardrail.id as unknown as string)) {
        return { kind: 'already-registered', guardrailId: guardrail.id };
      }
      s.set(guardrail.id as unknown as string, { guardrail, projectId });
      return { kind: 'ok', guardrailId: guardrail.id };
    },
    async unregister({ tenantId, guardrailId }) {
      return { unregistered: forT(tenantId).delete(guardrailId as unknown as string) };
    },
    ...(opts.refreshes === true && {
      async refreshDeployedFields({
        tenantId,
        guardrailId,
        codeArtifactRef,
        configSchema,
        expected,
      }) {
        const s = forT(tenantId);
        const row = s.get(guardrailId as unknown as string);
        if (row === undefined) return { refreshed: false };
        const held = row.guardrail as { codeArtifactRef?: unknown; configSchema?: unknown };
        if (
          expected !== undefined &&
          canon({
            codeArtifactRef: held.codeArtifactRef ?? null,
            configSchema: held.configSchema ?? null,
          }) !== canon(expected)
        ) {
          return { refreshed: false };
        }
        const {
          codeArtifactRef: _ref,
          configSchema: _schema,
          ...rest
        } = row.guardrail as Record<string, unknown>;
        s.set(guardrailId as unknown as string, {
          projectId: row.projectId,
          guardrail: {
            ...rest,
            ...(codeArtifactRef !== null && { codeArtifactRef }),
            ...(configSchema !== null && { configSchema }),
          },
        });
        return { refreshed: true };
      },
    }),
  };
}

let lastAgentPublishProjectId: ProjectId | undefined;

/** The project an agent of `elsewhereAgentId` belongs to, in these tests. */
const ELSEWHERE_PROJECT_ID = randomUUID() as ProjectId;

/** What a runtime routing pack calls per deployment passes. */
const PER_DEPLOYMENT = {
  systemDeployments: {
    binding: {} as never,
    endpointHostAllowed: () => false,
  },
} as const;

function makeInMemoryAgentRegistry(
  opts: { failOnAgentId?: string; refuseAgentId?: string; elsewhereAgentId?: string } = {},
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
      if (
        opts.elsewhereAgentId !== undefined &&
        (agent.id as unknown as string) === opts.elsewhereAgentId
      ) {
        return {
          kind: 'project-mismatch',
          agentId: agent.id,
          version: agent.version,
          projectId: ELSEWHERE_PROJECT_ID,
        };
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
/** Two client projects of the tenant, each deployed into by name. */
const CLIENT_A = randomUUID() as ProjectId;
const CLIENT_B = randomUUID() as ProjectId;

function makeMockProjectBinding(defaultProjectId: ProjectId = DEFAULT_PROJECT_ID): ProjectBinding {
  const notImpl = (m: string) => async () => {
    throw new Error(`makeMockProjectBinding: ${m} not used in these tests`);
  };
  const project = {
    id: defaultProjectId,
    tenantId,
    name: 'Default',
    slug: 'default',
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Project;
  return {
    async getDefault(): Promise<Project | undefined> {
      return project;
    },
    create: notImpl('create') as ProjectBinding['create'],
    // The tenant's projects a deploy may name (the project-ref check reads them).
    async get(t, projectId) {
      if (t !== tenantId) return undefined;
      const known = [defaultProjectId, CLIENT_A, CLIENT_B, ELSEWHERE_PROJECT_ID];
      if (!known.includes(projectId)) return undefined;
      return {
        id: projectId,
        tenantId,
        name: projectId === defaultProjectId ? 'Default' : 'Client',
        slug: projectId === defaultProjectId ? 'default' : `client-${projectId.slice(0, 8)}`,
        isDefault: projectId === defaultProjectId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Project;
    },
    list: notImpl('list') as ProjectBinding['list'],
    update: notImpl('update') as ProjectBinding['update'],
    delete: notImpl('delete') as ProjectBinding['delete'],
  };
}

let lastFlowPublishProjectId: ProjectId | undefined;

function makeInMemoryFlowRegistry(opts: { refuseFlowId?: string } = {}): FlowRegistryBinding {
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
      if (opts.refuseFlowId !== undefined && (flow.id as unknown as string) === opts.refuseFlowId) {
        return {
          kind: 'project-not-found',
          flowId: flow.id,
          version: flow.version,
          projectId,
        } as never;
      }
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
  toolRegistry?: ToolRegistryBinding;
  flowRegistry?: FlowRegistryBinding;
  /** More of the app's bindings, as given (e.g. `agentPins`). */
  extra?: Partial<Parameters<typeof createApp>[0]>;
  /** A binding the app goes without (`tools`: no tool registry, so agents and flows register unpinned). */
  omit?: 'deployment' | 'signing' | 'image' | 'tools';
  omitProjectBinding?: boolean;
  extraTrust?: readonly TrustEntry[];
  extraImages?: readonly FakeImage[];
  fixture?: SignedDeploy;
  writes?: string[];
  /** The project the deploy lands in. Default `DEFAULT_PROJECT_ID`. */
  projectId?: ProjectId;
  /** The tool and guardrail registries take a redeploy's code pointer (and config schema). */
  refreshes?: boolean;
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
  const refreshes = { refreshes: opts.refreshes === true };
  const toolRegistry = opts.toolRegistry ?? makeInMemoryToolRegistry(refreshes);
  const guardrailRegistry = makeInMemoryGuardrailRegistry(refreshes);
  const agentRegistry = opts.agentRegistry ?? makeInMemoryAgentRegistry();
  const flowRegistry = opts.flowRegistry ?? makeInMemoryFlowRegistry();

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(opts.omit === 'deployment' ? {} : { deploymentRegistry }),
    ...(opts.omit === 'signing' ? {} : { signingKeyRegistry }),
    ...(opts.omit === 'image' ? {} : { imageRegistry }),
    ...(opts.omit === 'tools' ? {} : { toolRegistry }),
    guardrailRegistry,
    agentRegistry,
    flowRegistry,
    ...opts.extra,
    // Content-scope anchor — the deployments router's agents publish
    // loop resolves Default project through this binding. Opt out via
    // `omitProjectBinding: true` for the negative-path test.
    ...(opts.omitProjectBinding === true
      ? {}
      : { projectBinding: makeMockProjectBinding(opts.projectId) }),
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

  test('a deployment into a read-only registry is refused before anything is written', async () => {
    const fixture = buildSignedDeploy();
    const reason = "Under kindgi dev, the pack is the source of tools: edit the pack's file.";
    const tools = makeInMemoryToolRegistry();
    const writes: string[] = [];
    const toolRegistry: ToolRegistryBinding = {
      ...tools,
      readOnly: { reason },
      publish: async (input) => {
        writes.push('publish');
        return tools.publish(input);
      },
    };
    const { app, deploymentRegistry } = makeApp({ fixture, toolRegistry });
    const res = await post(app, fixture.wire);
    expect(res.status).toBe(409);
    expect(
      ((await res.json()) as { error: { code: string; message: string } }).error,
    ).toMatchObject({ code: 'registry-read-only', message: reason });
    expect(writes).toEqual([]);
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
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

  test('the names its pack service reads (`env`) are kept on the deployment, as the build wrote them', async () => {
    const env = { required: ['API_BASE', 'SHOP_URL'], optional: ['LOG_LEVEL'] };
    const fixture = buildSignedDeploy({ index: { ...indexWith('20260920.1'), env } });
    const { app, deploymentRegistry } = makeApp({ fixture });
    const res = await post(app, fixture.wire);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { packEnv?: unknown }).packEnv).toEqual(env);
    const [stored] = (await deploymentRegistry.list({ tenantId, limit: 10 })).data;
    expect(stored?.packEnv).toEqual(env);
  });

  test('an index without `env` keeps no declaration', async () => {
    const fixture = buildSignedDeploy();
    const { app, deploymentRegistry } = makeApp({ fixture });
    const res = await post(app, fixture.wire);
    expect(res.status).toBe(201);
    expect('packEnv' in ((await res.json()) as object)).toBe(false);
    const [stored] = (await deploymentRegistry.list({ tenantId, limit: 10 })).data;
    expect(stored?.packEnv).toBeUndefined();
  });

  test('an image whose index declares a malformed `env` is refused, and nothing is written', async () => {
    for (const env of [
      { required: ['KINDGI_TOKEN'] },
      { required: 'API_BASE' },
      { required: ['API_BASE'], optional: ['API_BASE'] },
      { secrets: ['API_KEY'] },
    ]) {
      const fixture = buildSignedDeploy({ index: { ...indexWith('20260920.1'), env } });
      const { app, deploymentRegistry, toolRegistry } = makeApp({ fixture });
      const res = await post(app, fixture.wire);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('image-unverifiable');
      expect(body.error.message).toMatch(/^Image \/app\/index\.json's env is malformed: /);
      expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toHaveLength(0);
      expect(
        await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
      ).toBeNull();
    }
  });
  test("its tools' schema compiles count against the tenant's budget, first ones included: refused, nothing is written", async () => {
    const fixture = buildSignedDeploy();
    const {
      app,
      toolRegistry,
      guardrailRegistry,
      agentRegistry,
      flowRegistry,
      deploymentRegistry,
    } = makeApp({ fixture });
    const restore = overrideTenantInputBounds({ ...SELF_HOSTED_BOUNDS, schemaCompileBudgetMs: 0 });
    try {
      const refused = await post(app, fixture.wire);
      await expectCompileBudgetRefused(refused);
      expect((await toolRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
      expect((await guardrailRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
      expect((await agentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
      expect((await flowRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
      expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
    } finally {
      restore();
    }
    expect((await post(app, fixture.wire)).status).toBe(201);
  });

  test('past its first write, nothing it compiles counts: the budget was charged before the write', async () => {
    const fixture = buildSignedDeploy();
    const inner = makeInMemoryToolRegistry();
    const scopes: unknown[] = [];
    const toolRegistry: ToolRegistryBinding = {
      ...inner,
      async publish(input) {
        scopes.push(currentTenant() ?? 'none');
        return inner.publish(input);
      },
    };
    const { app } = makeApp({ fixture, toolRegistry });
    expect((await post(app, fixture.wire)).status).toBe(201);
    expect(scopes.length).toBeGreaterThan(0);
    expect(new Set(scopes)).toEqual(new Set(['none']));
  });

  test("its agents' data blocks pin before anything is written: checking model settings can't follow a write", async () => {
    const order: string[] = [];
    const blocks = inMemoryBlocks();
    await blocks.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      block: {
        id: 'acme.model',
        version: '1.0.0',
        kind: 'settings',
        content: { values: { temperature: 0.2 } },
      },
    });
    const tools = makeInMemoryToolRegistry();
    const agents = makeInMemoryAgentRegistry();
    const pinned: unknown[] = [];
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
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/legal/verify-citation.js',
          },
        ],
        guardrails: [],
        agents: [
          {
            id: 'acme.drafting',
            version: '1.0.0',
            name: 'Drafting',
            instructions: 'do it',
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
            modelSettings: { id: 'acme.model', version: '^1.0.0' },
          },
        ],
        flows: [],
      },
    });
    const { app } = makeApp({
      fixture,
      agentRegistry: {
        ...agents,
        publish: async (input) => {
          order.push('agent written');
          pinned.push(input.agent.pins);
          return agents.publish(input);
        },
      },
      toolRegistry: {
        ...tools,
        publish: async (input) => {
          order.push('tool written');
          return tools.publish(input);
        },
      },
      extra: {
        blockRegistry: {
          ...blocks,
          getVersion: async (input) => {
            order.push('block read');
            return blocks.getVersion(input);
          },
        },
      },
    });
    const res = await post(app, fixture.wire);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(order).toEqual(['block read', 'tool written', 'agent written']);
    expect(pinned).toEqual([expect.objectContaining({ settings: { 'acme.model': '1.0.0' } })]);
  });
});

// ---------------- happy path ----------------

describe('POST /v1/deployments — happy path', () => {
  test("a pack tool's declared secret: where it's read is recorded with the version", async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.lookup',
            description: 'Looks things up with its own key.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/lookup.js',
            needsSpec: { secrets: { ACME_LOOKUP_KEY: { type: 'string' } } },
          },
        ],
        guardrails: [],
      },
    });
    const tools = makeVersionedToolRegistry();
    const published: Record<string, unknown>[] = [];
    const toolRegistry = {
      ...tools,
      publish: async (input: Parameters<ToolRegistryBinding['publish']>[0]) => {
        published.push(input as unknown as Record<string, unknown>);
        return tools.publish(input);
      },
    } as ToolRegistryBinding;
    // Set at the tenant, in the env this deployment serves; the deployer is the tenant's admin.
    const secretsBinding = {
      get: async (input: { scope: { kind: string }; envName: string; name: string }) =>
        input.scope.kind === 'tenant' &&
        input.envName === 'prod' &&
        input.name === 'ACME_LOOKUP_KEY'
          ? { name: input.name, currentVersion: 1 }
          : null,
    } as unknown as SecretBinding;
    const { app } = makeApp({
      fixture,
      toolRegistry,
      extra: { secretsBinding, envName: 'prod' as never },
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(published.map((p) => p.secretScopes)).toEqual([{ ACME_LOOKUP_KEY: { kind: 'tenant' } }]);
  });

  test("deployed into a named project, a tool's secret is read there, else at the tenant", async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.lookup',
            description: 'Looks things up with its own key.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/lookup.js',
            needsSpec: { secrets: { ACME_LOOKUP_KEY: { type: 'string' } } },
          },
        ],
        guardrails: [],
      },
    });
    type StoredScope = { kind: string; projectId?: ProjectId };
    // The scopes recorded for a deploy into CLIENT_A, with the secret stored where `storedAt` says.
    const scopesWhenStoredAt = async (storedAt: (scope: StoredScope) => boolean) => {
      const tools = makeVersionedToolRegistry();
      const published: Record<string, unknown>[] = [];
      const toolRegistry = {
        ...tools,
        publish: async (input: Parameters<ToolRegistryBinding['publish']>[0]) => {
          published.push(input as unknown as Record<string, unknown>);
          return tools.publish(input);
        },
      } as ToolRegistryBinding;
      const secretsBinding = {
        get: async (input: { scope: StoredScope; envName: string; name: string }) =>
          storedAt(input.scope) && input.envName === 'prod' && input.name === 'ACME_LOOKUP_KEY'
            ? { name: input.name, currentVersion: 1 }
            : null,
      } as unknown as SecretBinding;
      const { app } = makeApp({
        fixture,
        toolRegistry,
        extra: { secretsBinding, envName: 'prod' as never },
      });
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...fixture.wire, projectId: CLIENT_A }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return published.map((p) => p.secretScopes);
    };
    expect(
      await scopesWhenStoredAt((scope) => scope.kind === 'project' && scope.projectId === CLIENT_A),
    ).toEqual([{ ACME_LOOKUP_KEY: { kind: 'project', projectId: CLIENT_A } }]);
    expect(await scopesWhenStoredAt((scope) => scope.kind === 'tenant')).toEqual([
      { ACME_LOOKUP_KEY: { kind: 'tenant' } },
    ]);
  });

  test("a tool naming a model provider's key is refused, naming the tool, the key and the provider", async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.summarize',
            description: 'Summarize with a model of its own.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/summarize.js',
            needsSpec: { secrets: { ANTHROPIC_API_KEY: { type: 'string' } } },
          },
        ],
        guardrails: [],
      },
    });
    const providerRegistry = {
      resolveForRuntime: async () => [
        {
          metadata: { id: 'anthropic-main' },
          adapterId: 'anthropic',
          secretRef: { envName: 'prod', name: 'ANTHROPIC_API_KEY' },
        },
      ],
    } as unknown as ProviderRegistryBinding;
    const { app, toolRegistry } = makeApp({ fixture, extra: { providerRegistry } });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { issues: unknown[] } } };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details.issues).toEqual([
      {
        primitive: 'tool',
        index: 0,
        id: 'acme.summarize',
        path: '/secrets/ANTHROPIC_API_KEY',
        message:
          '`ANTHROPIC_API_KEY` is the key of model provider "anthropic-main": a tool never gets a model provider\'s key. If it needs to call a model itself, store the key under its own name (the same value is fine) and use that name',
      },
    ]);
    expect(await toolRegistry.get({ tenantId, toolId: 'acme.summarize' as never })).toBeNull();
  });

  test('a tool naming a reserved `kindgi.` secret is refused, with no provider registered', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.relay',
            description: "Relay with a token of the runtime's own.",
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/relay.js',
            needsSpec: { secrets: { 'kindgi.connection-token': { type: 'string' } } },
          },
        ],
        guardrails: [],
      },
    });
    const { app, toolRegistry } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { issues: unknown[] } } };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details.issues).toEqual([
      {
        primitive: 'tool',
        index: 0,
        id: 'acme.relay',
        path: '/secrets/kindgi.connection-token',
        message:
          '`kindgi.connection-token` uses the reserved "kindgi." prefix: a tool never names one. Those names are Kindgi\'s own; store the secret under a name of its own and use that',
      },
    ]);
    expect(await toolRegistry.get({ tenantId, toolId: 'acme.relay' as never })).toBeNull();
  });

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

  test("an unpinned `kindgi build`'s artifact version (YYYYMMDD.HHMMSS) deploys; one that isn't YYYYMMDD.N is refused", async () => {
    const deploy = async (artifactVersion: string) => {
      const fixture = buildSignedDeploy({
        artifactVersion,
        publishedAt: '2026-10-08T09:05:03.042Z',
      });
      const { app } = makeApp({ fixture });
      return app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(fixture.wire),
      });
    };
    const ok = await deploy('20261008.090503');
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { artifactVersion: string }).artifactVersion).toBe(
      '20261008.090503',
    );
    for (const bad of ['2026-10-08.1', '20261008', '20261008.09:05:03']) {
      const res = await deploy(bad);
      expect(res.status, bad).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: { issues?: { path: string; message: string }[] } };
      };
      expect(body.error.code).toBe('bad-input');
      expect(body.error.details?.issues).toContainEqual({
        path: 'artifactVersion',
        message: 'artifactVersion must match YYYYMMDD.N',
      });
    }
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

  test('a guardrail as the indexer writes it (checkId, configSchema) deploys, its check from checkId, its configSchema kept (T338)', async () => {
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
    // Kept: the runtime checks a guardrail naming this check against it.
    expect(guardrail.configSchema).toEqual({
      type: 'object',
      properties: { strict: { type: 'boolean' } },
    });
  });

  test("an index guardrail carrying a field this runtime doesn't know (a newer CLI) deploys: it's dropped, not refused; the built-in marker is kept", async () => {
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
            kind: 'zero-llm',
            action: { 'on-violation': 'halt' },
            checkModulePath: 'guardrails/cites.mjs',
            checkId: 'must-cite',
            config: { minCitations: 1 },
            checkBuiltIn: true,
            someLaterField: { anything: 1 },
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
    expect(guardrail).toMatchObject({ check: 'must-cite', config: { minCitations: 1 } });
    // The marker the runtime reads to tell a guardrail merely naming a built-in from an older
    // CLI's pack that may ship its own check under one.
    expect(guardrail.checkBuiltIn).toBe(true);
    expect(guardrail.someLaterField).toBeUndefined();
  });

  test("an index guardrail naming a built-in with a config the built-in refuses: 400, the config's problem named", async () => {
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
            id: 'acme.no-refunds',
            kind: 'zero-llm',
            action: { 'on-violation': 'halt' },
            checkModulePath: 'guardrails/no-refunds.mjs',
            checkId: 'never-call-tool',
            config: { tools: 'acme.refund' },
          },
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
      error: { code: string; details?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues).toEqual([
      {
        primitive: 'guardrail',
        index: 0,
        id: 'acme.no-refunds',
        path: '/config/tools',
        message: 'config.tools must be array.',
      },
    ]);
  });

  const pointIndex = (guardrail: Record<string, unknown>) => ({
    v: 1,
    packId: 'acme.aperture',
    packVersion: '1.0.0',
    artifactVersion: '20260920.1',
    publishedAt: '2026-09-20T14:32:07.104Z',
    tools: [],
    guardrails: [
      {
        id: 'acme.no-refunds',
        kind: 'zero-llm',
        action: { 'on-violation': 'halt' },
        checkModulePath: './guardrails/no-refunds.js',
        ...guardrail,
      },
    ],
    agents: [],
    flows: [],
  });

  test.each([
    [
      "a built-in at a point it doesn't run at",
      { checkId: 'never-call-tool', config: { tools: ['acme.woo.refund'] }, at: 'model-step' },
      'at "model-step" isn\'t one of the check\'s points (before-tool, final-answer).',
    ],
    [
      "a pack check at a point its index doesn't list",
      { checkId: 'acme.checks.args', checkPoints: ['before-tool'] },
      'at "final-answer" isn\'t one of the check\'s points (before-tool).',
    ],
    [
      "a pack check whose index lists no points (an older CLI's), anywhere but the final answer",
      { checkId: 'acme.checks.args', at: 'before-tool' },
      'at "before-tool" isn\'t one of the check\'s points (final-answer).',
    ],
    [
      "a pack check whose index lists only points this runtime doesn't know (a newer CLI's)",
      { checkId: 'acme.checks.args', checkPoints: ['mid-thought', 'after-answer'] },
      'at "final-answer" isn\'t one of the check\'s points (none this runtime knows: mid-thought, after-answer).',
    ],
    [
      'a pack check whose index lists an empty list of points',
      { checkId: 'acme.checks.args', checkPoints: [] },
      'at "final-answer" isn\'t one of the check\'s points (the index lists none).',
    ],
  ])('%s: 400, the point named at /at', async (_what, guardrail, message) => {
    const fixture = buildSignedDeploy({ index: pointIndex(guardrail) });
    const { app } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues).toEqual([
      { primitive: 'guardrail', index: 0, id: 'acme.no-refunds', path: '/at', message },
    ]);
  });

  test('a pack check at a point its index lists deploys, with its point', async () => {
    const fixture = buildSignedDeploy({
      index: pointIndex({
        checkId: 'acme.checks.args',
        checkPoints: ['before-tool', 'final-answer'],
        at: 'before-tool',
        sees: 'conversation',
        scope: { tools: ['acme.woo.*'] },
      }),
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
      guardrailId: 'acme.no-refunds' as never,
    })) as unknown as Record<string, unknown>;
    expect(guardrail).toMatchObject({
      check: 'acme.checks.args',
      at: 'before-tool',
      sees: 'conversation',
      scope: { tools: ['acme.woo.*'] },
    });
    // The index's list of the check's points is the deployment's to read, not the guardrail's.
    expect(guardrail.checkPoints).toBeUndefined();
  });

  test("a guardrail naming a built-in, which the index lists no points for, takes the built-in's points", async () => {
    const fixture = buildSignedDeploy({
      index: pointIndex({
        checkId: 'never-call-tool',
        checkBuiltIn: true,
        config: { tools: ['acme.woo.refund'] },
        at: 'before-tool',
      }),
    });
    const { app, guardrailRegistry } = makeApp({ fixture });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(
      await guardrailRegistry.get({ tenantId, guardrailId: 'acme.no-refunds' as never }),
    ).toMatchObject({ check: 'never-call-tool', at: 'before-tool' });
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

  test("a failed registry read names the binding's code in details.cause, and a limit's bound in details.limit", async () => {
    const fixture = buildSignedDeploy();
    const served = makeMockImageRegistry([
      { imageRef: fixture.imageRef, digest: fixture.digest, indexBytes: fixture.indexBytes },
    ]);
    const cases: readonly {
      readonly step: 'head' | 'extractFile';
      readonly error: ImageRegistryError;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    }[] = [
      {
        step: 'head',
        error: { code: 'image-limit-exceeded', message: 'manifest over 4 MiB', limit: 'manifest' },
        message: 'Image head probe failed: manifest over 4 MiB',
        details: { imageRef: fixture.imageRef, cause: 'image-limit-exceeded', limit: 'manifest' },
      },
      {
        step: 'extractFile',
        error: { code: 'image-limit-exceeded', message: 'unpacks past 4 GiB', limit: 'unpack' },
        message: 'Extract /app/index.json failed: unpacks past 4 GiB',
        details: { imageRef: fixture.imageRef, cause: 'image-limit-exceeded', limit: 'unpack' },
      },
      // A binding's own `cause` (an Error here) never reaches the wire.
      {
        step: 'extractFile',
        error: { code: 'image-unreadable', message: 'not a tar', cause: new Error('bad header') },
        message: 'Extract /app/index.json failed: not a tar',
        details: { imageRef: fixture.imageRef, cause: 'image-unreadable' },
      },
      {
        step: 'head',
        error: {
          code: 'image-registry-unreachable',
          message: 'connect ECONNREFUSED',
          cause: new Error('ECONNREFUSED'),
        },
        message: 'Image head probe failed: connect ECONNREFUSED',
        details: { imageRef: fixture.imageRef, cause: 'image-registry-unreachable' },
      },
    ];
    for (const { step, error, message, details } of cases) {
      const refused = async () => ({ kind: 'err' as const, error });
      const imageRegistry: ImageRegistryBinding =
        step === 'head' ? { ...served, head: refused } : { ...served, extractFile: refused };
      const { app, deploymentRegistry } = makeApp({ fixture, imageRegistry });
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(fixture.wire),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      expect(body.error).toMatchObject({ code: 'image-unverifiable', message });
      expect(body.error.details).toEqual(details);
      expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toHaveLength(0);
    }
  });

  test("the tenant's hour of image reads passes: 429 rate-limit-exceeded with details.limit and Retry-After, the binding's wait rounded up, else the hour", async () => {
    const fixture = buildSignedDeploy();
    const served = makeMockImageRegistry([
      { imageRef: fixture.imageRef, digest: fixture.digest, indexBytes: fixture.indexBytes },
    ]);
    const cases: readonly { readonly retryAfterMs?: number; readonly retryAfter: string }[] = [
      { retryAfterMs: 12 * 60_000 + 1, retryAfter: '721' },
      { retryAfterMs: 0, retryAfter: '1' },
      { retryAfter: '3600' },
      { retryAfterMs: Number.NaN, retryAfter: '3600' },
    ];
    for (const { retryAfterMs, retryAfter } of cases) {
      const error: ImageRegistryError = {
        code: 'image-limit-exceeded',
        message: 'try again in 13 min',
        limit: 'tenant-unpack-hour',
        ...(retryAfterMs !== undefined && { retryAfterMs }),
      };
      const imageRegistry: ImageRegistryBinding = {
        ...served,
        extractFile: async () => ({ kind: 'err' as const, error }),
      };
      const { app, deploymentRegistry } = makeApp({ fixture, imageRegistry });
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(fixture.wire),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe(retryAfter);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      expect(body.error).toEqual({
        code: 'rate-limit-exceeded',
        message: 'Extract /app/index.json failed: try again in 13 min',
        details: { limit: 'tenant-unpack-hour' },
        requestId: expect.any(String),
      });
      expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toHaveLength(0);
    }
  });

  test("an image's own bound with a wait is still the image's: 400 image-unverifiable, no Retry-After", async () => {
    const fixture = buildSignedDeploy();
    const served = makeMockImageRegistry([
      { imageRef: fixture.imageRef, digest: fixture.digest, indexBytes: fixture.indexBytes },
    ]);
    const error: ImageRegistryError = {
      code: 'image-limit-exceeded',
      message: 'unpacks past 4 GiB',
      limit: 'unpack',
      retryAfterMs: 60_000,
    };
    const { app } = makeApp({
      fixture,
      imageRegistry: { ...served, extractFile: async () => ({ kind: 'err' as const, error }) },
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('retry-after')).toBeNull();
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('image-unverifiable');
    expect(body.error.details).toEqual({
      imageRef: fixture.imageRef,
      cause: 'image-limit-exceeded',
      limit: 'unpack',
    });
  });

  test('a check after a read that succeeded names no cause', async () => {
    const fixture = buildSignedDeploy();
    const { app } = makeApp({
      fixture,
      imageRegistry: makeMockImageRegistry([
        {
          imageRef: fixture.imageRef,
          digest: `sha256:${'0'.repeat(64)}`,
          indexBytes: fixture.indexBytes,
        },
      ]),
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('image-unverifiable');
    expect(body.error.details).toEqual({ imageRef: fixture.imageRef });
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

  test("an agent's template with a partial → 400, naming the agent and where", async () => {
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
            instructions: "Draft it. {% layout 'package.json' %}",
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
          },
        ],
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
      error: { code: string; details?: { issues?: Array<Record<string, unknown>> } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues).toEqual([
      {
        primitive: 'agent',
        index: 0,
        id: 'acme.drafting',
        path: '/instructions',
        message: "templates can't use include, render or layout",
      },
    ]);
  });

  test("a tool's needsSpec schema that wouldn't compile → 400, naming the tool and where", async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.sign',
            description: 'Signs a receipt.',
            version: '0.1.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: 'tools/sign.js',
            needsSpec: { secrets: { SIGNING_KEY: { type: 'string', 'x-unknown': true } } },
          },
        ],
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
      error: { code: string; details?: { issues?: Array<Record<string, unknown>> } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues).toContainEqual(
      expect.objectContaining({
        primitive: 'tool',
        index: 0,
        id: 'acme.sign',
        path: '/needsSpec/secrets/SIGNING_KEY',
        message: expect.stringContaining('unknown keyword: "x-unknown"'),
      }),
    );
  });

  const post = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
    app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** An index of one agent with `output` (absent when undefined), and `flows`. */
  function indexWith(output: unknown, flows: readonly unknown[] = []) {
    return {
      v: 1,
      artifactVersion: '20260920.1',
      publishedAt: '2026-09-20T14:32:07.104Z',
      tools: [],
      guardrails: [],
      agents: [
        {
          id: 'acme.summary',
          version: '1.0.0',
          name: 'Summary',
          instructions: 'Summarize the request.',
          capabilities: [{ feature: 'model.text.chat' }],
          tools: [],
          ...(output !== undefined && { output }),
        },
      ],
      flows,
    };
  }

  /** A flow whose fanout's second branch and output carry `schema`; the first branch's compiles. */
  function fanoutFlow(schema: unknown) {
    return {
      id: 'acme.intake',
      version: '1.0.0',
      nodes: [
        {
          id: 'fan',
          kind: 'fanout',
          convergence: 'settle-all',
          branches: [
            { branchId: 'a', handler: 'ha', outputSchema: { type: 'object' } },
            { branchId: 'b', handler: 'hb', outputSchema: schema },
          ],
        },
      ],
      edges: [
        { id: 'e0', from: '$start', to: 'fan' },
        { id: 'e1', from: 'fan', to: '$end' },
      ],
      output: { mapping: { x: { literal: 1 } }, schema },
    };
  }

  const uncompilable = { type: 'object', 'x-unknown': true };

  test("an agent's output schema and a flow's schemas that wouldn't compile → 400, each named where it sits; nothing is deployed", async () => {
    const fixture = buildSignedDeploy({
      index: indexWith({ schema: uncompilable }, [fanoutFlow(uncompilable)]),
    });
    const { app, deploymentRegistry } = makeApp({ fixture });
    const res = await post(app, fixture.wire);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<Record<string, unknown>> } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    const why = expect.stringMatching(/^doesn't compile: .*unknown keyword: "x-unknown"/);
    expect(body.error.details?.issues).toEqual([
      { primitive: 'agent', index: 0, id: 'acme.summary', path: '/output/schema', message: why },
      {
        primitive: 'flow',
        index: 0,
        id: 'acme.intake',
        path: '/nodes/0/branches/1/outputSchema',
        message: why,
      },
      { primitive: 'flow', index: 0, id: 'acme.intake', path: '/output/schema', message: why },
    ]);
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test("an agent's output that isn't an object → 400 at /output", async () => {
    for (const output of [null, 'json', [{ type: 'object' }]]) {
      const fixture = buildSignedDeploy({ index: indexWith(output) });
      const { app } = makeApp({ fixture });
      const res = await post(app, fixture.wire);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { details?: { issues?: Array<Record<string, unknown>> } };
      };
      expect(body.error.details?.issues).toEqual([
        {
          primitive: 'agent',
          index: 0,
          id: 'acme.summary',
          path: '/output',
          message: 'agent.output must be an object { schema, name?, maxRepairs? }',
        },
      ]);
    }
  });

  test("an agent's parallelToolCalls that isn't true or false → 400 at /parallelToolCalls", async () => {
    const index = indexWith(undefined);
    const fixture = buildSignedDeploy({
      index: { ...index, agents: index.agents.map((a) => ({ ...a, parallelToolCalls: 'false' })) },
    });
    const { app, deploymentRegistry } = makeApp({ fixture });
    const res = await post(app, fixture.wire);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { issues?: Array<Record<string, unknown>> } };
    };
    expect(body.error.details?.issues).toEqual([
      {
        primitive: 'agent',
        index: 0,
        id: 'acme.summary',
        path: '/parallelToolCalls',
        message: 'agent.parallelToolCalls must be true or false',
      },
    ]);
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test("an agent's parallelToolCalls: false deploys, and its agent is registered with it", async () => {
    const index = indexWith(undefined);
    const fixture = buildSignedDeploy({
      index: { ...index, agents: index.agents.map((a) => ({ ...a, parallelToolCalls: false })) },
    });
    const agents = makeInMemoryAgentRegistry();
    const written: Agent[] = [];
    const { app } = makeApp({
      fixture,
      agentRegistry: {
        ...agents,
        publish: async (input) => {
          written.push(input.agent);
          return agents.publish(input);
        },
      },
    });
    const res = await post(app, fixture.wire);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(written.map((a) => a.parallelToolCalls)).toEqual([false]);
  });

  test('an agent whose output schema compiles deploys', async () => {
    const fixture = buildSignedDeploy({
      index: indexWith({
        schema: { type: 'object', properties: { summary: { type: 'string' } } },
      }),
    });
    const { app, deploymentRegistry } = makeApp({ fixture });
    const res = await post(app, fixture.wire);
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { contents: { agents: unknown[] } };
    expect(body.contents.agents).toEqual([{ id: 'acme.summary', version: '1.0.0' }]);
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toHaveLength(1);
  });

  test('a pack built before autoCloseAfterInactiveSeconds was taken out still deploys, and its agent answers without it', async () => {
    const policy = { historyLimit: 5, autoCloseAfterInactiveSeconds: 600 };
    const index = indexWith(undefined);
    const fixture = buildSignedDeploy({
      index: { ...index, agents: index.agents.map((a) => ({ ...a, conversationPolicy: policy })) },
    });
    const agents = makeInMemoryAgentRegistry();
    const written: Agent[] = [];
    const { app } = makeApp({
      fixture,
      agentRegistry: {
        ...agents,
        publish: async (input) => {
          written.push(input.agent);
          return agents.publish(input);
        },
        get: async () => written[0] ?? null,
      },
    });
    const res = await post(app, fixture.wire);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(written.map((a) => a.conversationPolicy)).toEqual([policy]);
    const answered = await app.request('/v1/agents/acme.summary', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect(
      ((await answered.json()) as { conversationPolicy?: unknown }).conversationPolicy,
    ).toEqual({ historyLimit: 5 });
  });

  test("its agents' and flows' schema compiles count against the tenant's budget: refused, nothing is deployed", async () => {
    const compiles = { type: 'object' };
    const fixture = buildSignedDeploy({
      index: indexWith({ schema: compiles }, [fanoutFlow(compiles)]),
    });
    const { app, deploymentRegistry } = makeApp({ fixture });
    const restore = overrideTenantInputBounds({ ...SELF_HOSTED_BOUNDS, schemaCompileBudgetMs: 0 });
    try {
      await expectCompileBudgetRefused(await post(app, fixture.wire));
      expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
    } finally {
      restore();
    }
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

// ------- 500 bodies route through the central handler -------

describe('POST /v1/deployments — 500s route through the central handler', () => {
  test('a trust-check error is a fixed-message 500 that leaks no raw detail', async () => {
    const fixture = buildSignedDeploy();
    const signingKeyRegistry: SigningKeyRegistryBinding = {
      ...makeMockSigningKeyRegistry([]),
      isTrusted: async () => ({
        kind: 'err',
        error: {
          code: 'signing-key-store-error',
          message: 'trust store query failed: SELECT 1 FROM trust_keys WHERE tenant = $1',
        },
      }),
    };
    const { app, toolRegistry, guardrailRegistry } = makeApp({ fixture, signingKeyRegistry });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());
    // A mutant restoring the interpolated `Trust check failed: ${...}` body is killed.
    expect(JSON.parse(raw).error.code).toBe('internal-server-error');
    expect(raw).not.toContain('trust store query failed');
    expect(raw).not.toContain('SELECT 1 FROM trust_keys');
    // The trust check precedes any write: nothing landed.
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
    ).toBeNull();
    expect(
      await guardrailRegistry.get({ tenantId, guardrailId: 'acme.no-fabricated-quotes' as never }),
    ).toBeNull();
  });

  test('a deployment-record throw is a fixed-message 500, leaks nothing, and rolls back', async () => {
    const fixture = buildSignedDeploy();
    const deploymentRegistry: DeploymentBinding = {
      ...makeInMemoryDeploymentBinding(),
      register: async () => {
        throw new Error(
          'insert into deployments failed: duplicate key value violates "deployments_pkey"',
        );
      },
    };
    const { app, toolRegistry, guardrailRegistry } = makeApp({ fixture, deploymentRegistry });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());
    // A mutant that restores a route-built 500 body here is killed.
    expect(JSON.parse(raw).error.code).toBe('internal-server-error');
    expect(raw).not.toContain('insert into deployments failed');
    expect(raw).not.toContain('deployments_pkey');
    // The tool + guardrail written before the record step are rolled back.
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
    ).toBeNull();
    expect(
      await guardrailRegistry.get({ tenantId, guardrailId: 'acme.no-fabricated-quotes' as never }),
    ).toBeNull();
  });

  test('a deployment-record error outcome is a fixed-message 500, leaks nothing, and rolls back', async () => {
    const fixture = buildSignedDeploy();
    const deploymentRegistry: DeploymentBinding = {
      ...makeInMemoryDeploymentBinding(),
      register: async () => ({
        kind: 'error',
        code: 'constraint-violation',
        message: 'row rejected: CHECK (artifact_version ~ ...) on table deployments',
      }),
    };
    const { app, toolRegistry, guardrailRegistry } = makeApp({ fixture, deploymentRegistry });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());
    // A mutant that restores the interpolated `Deployment record failed (...)` body is killed.
    expect(JSON.parse(raw).error.code).toBe('internal-server-error');
    expect(raw).not.toContain('row rejected');
    expect(raw).not.toContain('artifact_version');
    // Rolled back.
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
    ).toBeNull();
    expect(
      await guardrailRegistry.get({ tenantId, guardrailId: 'acme.no-fabricated-quotes' as never }),
    ).toBeNull();
  });
});

// ---------------- rollback ----------------

/** A deployment record that throws for the first `failures` deploys, then records them. */
function makeFailingDeploymentBinding(failures: number): DeploymentBinding {
  let left = failures;
  const records = makeInMemoryDeploymentBinding();
  return {
    ...records,
    register: async (input) => {
      if (left > 0) {
        left -= 1;
        throw new Error('the deployment record failed');
      }
      return records.register(input);
    },
  };
}

/** A logger that keeps each warn; a child is the same logger. */
function recordingLogger(): Logger & {
  warns: { readonly message: string; readonly fields: LogFields | undefined }[];
} {
  const warns: { readonly message: string; readonly fields: LogFields | undefined }[] = [];
  const log: Logger & { warns: typeof warns } = {
    warns,
    error: () => undefined,
    warn: (message, fields) => void warns.push({ message, fields }),
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
    isLevelEnabled: () => true,
  };
  return log;
}

/** The rollback's warns `logger` kept. */
const rollbackWarns = (logger: ReturnType<typeof recordingLogger>) =>
  logger.warns.filter((w) => w.message.startsWith('deploy rollback'));

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
    // The fixed 500 body carries no raw detail of the thrown cause. A mutant
    // that restores a route-built body at the upsert fall-through is killed.
    const raw = JSON.stringify(await res.json());
    expect(JSON.parse(raw).error.code).toBe('internal-server-error');
    expect(raw).not.toContain('forced failure');
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

  test("a tool whose id is an MCP endpoint's tool → 409 tool-kind-mismatch, naming the endpoint; rolled back, nothing deployed", async () => {
    const tool = (id: string) => ({
      id,
      description: 'x',
      version: '1.0.0',
      input: { type: 'object' },
      output: { type: 'object' },
    });
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [tool('acme.verify-citation'), tool('acme.search')],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const tools = makeInMemoryToolRegistry();
    // As a registry holding MCP endpoint `acme`'s tool `search`.
    const toolRegistry: ToolRegistryBinding = {
      ...tools,
      publish: async (input) =>
        (input.tool.id as unknown as string) === 'acme.search'
          ? {
              kind: 'kind-mismatch',
              toolId: input.tool.id,
              version: input.tool.version as never,
              endpointId: 'acme',
            }
          : tools.publish(input),
    };
    const { app, deploymentRegistry } = makeApp({ fixture, toolRegistry });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('tool-kind-mismatch');
    expect(body.error.message).toBe(
      "The tool acme.search@1.0.0 wasn't published: its id is MCP endpoint \"acme\"'s tool (give the pack's tool another name, or unregister the endpoint first); nothing was deployed",
    );
    expect(body.error.details).toEqual({
      primitive: 'tool',
      id: 'acme.search@1.0.0',
      endpointId: 'acme',
    });
    // What it published before is rolled back.
    expect(await tools.get({ tenantId, toolId: 'acme.verify-citation' as never })).toBeNull();
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test.each([
    {
      runs: 'a pack service per deployment',
      extra: PER_DEPLOYMENT,
      fix: ' (one pack per client: `kindgi init` a copy of the pack for this client, with its own pack id)',
    },
    {
      runs: 'one pack service, with environment orders',
      extra: { environmentOrders: environmentOrders([]) },
      fix: " (this runtime runs one pack service, so a copy of the pack wouldn't run: if both projects are in the same org, or neither is in an org, put them in one environment order (`kindgi environments set`), this one right after the one it belongs to, and `kindgi promote` the build to this one instead of deploying it; otherwise they can't share an order until both are in the same org, or neither is in an org (a project not in an order can move))",
    },
    { runs: 'one pack service, no environment orders', extra: {}, fix: '' },
  ])(
    'an agent that belongs to another project, on a runtime with $runs → 409 agent-project-mismatch naming the fix it has, rolled back, nothing deployed',
    async ({ extra, fix }) => {
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
        agentRegistry: makeInMemoryAgentRegistry({ elsewhereAgentId: 'acme.drafting' }),
        deploymentRegistry,
        extra,
      });
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(fixture.wire),
      });
      expect(res.status).toBe(409);
      const text = await res.text();
      const body = JSON.parse(text) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      expect(body.error.code).toBe('agent-project-mismatch');
      expect(body.error.message).toBe(
        `The agent acme.drafting@1.0.0 wasn't published: it belongs to another project${fix}; nothing was deployed`,
      );
      expect(body.error.details).toEqual({ primitive: 'agent', id: 'acme.drafting@1.0.0' });
      // The project it belongs to stays off the wire.
      expect(text).not.toContain(ELSEWHERE_PROJECT_ID);
      // A deploy never moves it: what it published before is rolled back.
      expect(
        await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
      ).toBeNull();
      expect(
        await guardrailRegistry.get({
          tenantId,
          guardrailId: 'acme.no-fabricated-quotes' as never,
        }),
      ).toBeNull();
      expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
    },
  );

  test('a flow refused with a typed outcome → its 404, the tool it shipped with rolled back (T205)', async () => {
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'inline',
            description: 'Runs inline.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/inline.js',
          },
        ],
        guardrails: [],
        agents: [],
        flows: [
          {
            id: 'ingest.refused',
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
    const deploymentRegistry = makeInMemoryDeploymentBinding();
    const { app, toolRegistry } = makeApp({
      fixture,
      flowRegistry: makeInMemoryFlowRegistry({ refuseFlowId: 'ingest.refused' }),
      deploymentRegistry,
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('project-not-found');
    expect(body.error.message).toBe(
      "The flow ingest.refused@1.0.0 wasn't published: project-not-found; nothing was deployed",
    );
    expect(await toolRegistry.get({ tenantId, toolId: 'inline' as never })).toBeNull();
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test("a guardrail the rollback can't unregister is warned, by name, and the tool before it is still unregistered", async () => {
    const fixture = buildSignedDeploy({
      artifactVersion: '20260920.1',
      index: indexWith('20260920.1'),
    });
    const logger = recordingLogger();
    const { app, toolRegistry } = makeApp({
      fixture,
      deploymentRegistry: makeFailingDeploymentBinding(1),
      extra: {
        logger,
        guardrailRegistry: {
          ...makeInMemoryGuardrailRegistry(),
          unregister: async () => {
            throw new Error('the guardrail store is down');
          },
        },
      },
    });

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    expect(rollbackWarns(logger)).toEqual([
      {
        message: `deploy rollback: couldn't unregister guardrail "acme.no-fabricated-quotes", so it stays as this deploy left it`,
        fields: {
          primitive: 'guardrail',
          id: 'acme.no-fabricated-quotes',
          err: new Error('the guardrail store is down'),
        },
      },
    ]);
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
    ).toBeNull();
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

  // The list handler lets a throw from the registry propagate to the central
  // error handler instead of catching it and building its own 500. A mutant
  // that restores the inline `catch (cause)` 500 is killed by both tests:
  // the busy case stops being a 503, and the generic case starts leaking
  // `Deployment list failed: <cause>`.
  test('a database-busy registry answers 503 + Retry-After, not a 500', async () => {
    const busy: DeploymentBinding = {
      ...makeInMemoryDeploymentBinding(),
      list: async () => {
        const cause = new Error('connect ECONNREFUSED 10.0.0.5:5432') as Error & { code?: string };
        cause.code = 'database-busy';
        throw cause;
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: busy,
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });
    const res = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('database-busy');
  });

  test('a generic registry throw is a 500 whose body carries no raw error text', async () => {
    const leak =
      'Failed query: SELECT * FROM deployments WHERE tenant = $1; params: alice@example.com';
    const throwing: DeploymentBinding = {
      ...makeInMemoryDeploymentBinding(),
      list: async () => {
        throw new Error(leak);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: throwing,
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });
    const res = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('Deployment list failed');
    const body = JSON.parse(raw) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal-server-error');
    expect(['Unhandled server error', 'A database query failed.']).toContain(body.error.message);
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

  test('projectId and packId reach the binding, and every page names them, an empty one too', async () => {
    const binding = makeInMemoryDeploymentBinding();
    const asked: unknown[] = [];
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: {
        ...binding,
        list: async (input) => {
          asked.push(input);
          return binding.list(input);
        },
      },
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });
    const headers = { authorization: `Bearer ${TOKEN}` };

    const res = await app.request('/v1/deployments?projectId=p-staging&packId=acme.pack', {
      headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      hasMore: false,
      projectId: 'p-staging',
      packId: 'acme.pack',
    });
    expect(asked).toEqual([
      expect.objectContaining({ projectId: 'p-staging', packId: 'acme.pack' }),
    ]);

    const unfiltered = await app.request('/v1/deployments', { headers });
    expect(await unfiltered.json()).toEqual({ data: [], hasMore: false });
    expect(asked[1]).not.toHaveProperty('projectId');
    expect(asked[1]).not.toHaveProperty('packId');
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

describe('GET /v1/deployments — the endpoint, under per-deployment routing', () => {
  async function seeded(endpoint?: Deployment['endpoint']) {
    const inner = makeInMemoryDeploymentBinding();
    const reg = await inner.register({
      tenantId,
      imageRef: `ghcr.io/a/pack@sha256:${'c'.repeat(64)}`,
      imageDigest: `sha256:${'c'.repeat(64)}`,
      artifactVersion: '20260920.1',
      indexHash: `sha256:${'b'.repeat(64)}`,
      signerKeyId: KEY_ID,
      signerPublicKey: 'noop',
      signature: 'noop',
      publishedAt: '2026-09-20T14:32:07.104Z',
      primitives: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
      contents: { tools: [], guardrails: [], agents: [], flows: [] },
    });
    if (reg.kind !== 'ok') throw new Error('seed failed');
    const withEndpoint = (d: Deployment): Deployment =>
      endpoint === undefined ? d : { ...d, endpoint };
    const binding: DeploymentBinding = {
      ...inner,
      get: async (input) => {
        const d = await inner.get(input);
        return d === null ? null : withEndpoint(d);
      },
      list: async (input) => {
        const page = await inner.list(input);
        return { ...page, data: page.data.map(withEndpoint) };
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      deploymentRegistry: binding,
      signingKeyRegistry: makeMockSigningKeyRegistry([]),
      imageRegistry: makeMockImageRegistry([]),
    });
    return { app, deploymentId: reg.deployment.deploymentId };
  }

  test('a deployment the binding reports an endpoint for carries its status and when, never a URL or token', async () => {
    const { app, deploymentId } = await seeded({
      status: 'ready',
      since: '2026-10-11T12:00:00.000Z',
    });
    const one = await app.request(`/v1/deployments/${deploymentId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(one.status).toBe(200);
    const body = (await one.json()) as Record<string, unknown>;
    expect(body.endpoint).toEqual({ status: 'ready', since: '2026-10-11T12:00:00.000Z' });
    const listed = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const page = (await listed.json()) as { data: Record<string, unknown>[] };
    expect(page.data[0]?.endpoint).toEqual({ status: 'ready', since: '2026-10-11T12:00:00.000Z' });
  });

  test('without per-deployment routing, no endpoint field at all', async () => {
    const { app, deploymentId } = await seeded();
    const one = await app.request(`/v1/deployments/${deploymentId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await one.json()) as Record<string, unknown>;
    expect('endpoint' in body).toBe(false);
  });

  test("a pending deployment carries its problem's code and when, and nothing else the binding holds", async () => {
    const { app, deploymentId } = await seeded({
      status: 'pending',
      since: '2026-10-11T12:00:00.000Z',
      problem: {
        code: 'endpoint-host-not-allowed',
        since: '2026-10-11T12:01:00.000Z',
        host: 'kp-x-123.us-central1.run.app',
      },
      url: 'https://kp-x-123.us-central1.run.app',
      token: 'pack-token',
    } as unknown as Deployment['endpoint']);
    const expected = {
      status: 'pending',
      since: '2026-10-11T12:00:00.000Z',
      problem: { code: 'endpoint-host-not-allowed', since: '2026-10-11T12:01:00.000Z' },
    };
    const one = await app.request(`/v1/deployments/${deploymentId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await one.json()) as Record<string, unknown>).endpoint).toEqual(expected);
    const listed = await app.request('/v1/deployments', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const page = (await listed.json()) as { data: Record<string, unknown>[] };
    expect(page.data[0]?.endpoint).toEqual(expected);
  });

  async function endpointOf(endpoint: Deployment['endpoint']) {
    const { app, deploymentId } = await seeded(endpoint);
    const one = await app.request(`/v1/deployments/${deploymentId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return ((await one.json()) as Record<string, unknown>).endpoint;
  }

  const CLEARED = { status: 'cleared', since: '2026-10-11T12:00:00.000Z' } as const;
  const PROBLEM = { code: 'service-start-failed', since: '2026-10-11T12:03:00.000Z' } as const;

  test('a cleared deployment waiting for its pack service again (a suspension lifted) says so, with its problem', async () => {
    expect(await endpointOf({ ...CLEARED, waiting: true, problem: PROBLEM })).toEqual({
      ...CLEARED,
      problem: PROBLEM,
      waiting: true,
    });
  });

  test('a retired cleared deployment says why, and shows no problem, whatever the binding holds', async () => {
    expect(await endpointOf({ ...CLEARED, retired: 'superseded', problem: PROBLEM })).toEqual({
      ...CLEARED,
      retired: 'superseded',
    });
  });

  test('a cleared deployment from a binding that says neither (an older server) shows neither, and no problem', async () => {
    expect(await endpointOf({ ...CLEARED, problem: PROBLEM })).toEqual(CLEARED);
  });

  test('a cleared deployment carries one of the two: waiting, should a binding give both', async () => {
    expect(await endpointOf({ ...CLEARED, waiting: true, retired: 'pack-suspended' })).toEqual({
      ...CLEARED,
      waiting: true,
    });
  });

  test('only a cleared deployment carries waiting or retired', async () => {
    const since = '2026-10-11T12:00:00.000Z';
    expect(
      await endpointOf({
        status: 'pending',
        since,
        waiting: true,
        retired: 'superseded',
        problem: PROBLEM,
      }),
    ).toEqual({ status: 'pending', since, problem: PROBLEM });
    expect(
      await endpointOf({ status: 'ready', since, waiting: true, retired: 'superseded' }),
    ).toEqual({
      status: 'ready',
      since,
    });
  });

  test('a ready deployment shows no problem, whatever the binding holds', async () => {
    const { app, deploymentId } = await seeded({
      status: 'ready',
      since: '2026-10-11T12:05:00.000Z',
      problem: { code: 'capacity-unavailable', since: '2026-10-11T12:01:00.000Z' },
    });
    const one = await app.request(`/v1/deployments/${deploymentId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await one.json()) as Record<string, unknown>).endpoint).toEqual({
      status: 'ready',
      since: '2026-10-11T12:05:00.000Z',
    });
  });
});

describe('POST /v1/deployments — the pack id reaches the binding', () => {
  test("the image index's packId is passed to register, so a binding running a service per deployment can keep it", async () => {
    const fixture = buildSignedDeploy();
    const inner = makeInMemoryDeploymentBinding();
    const seen: DeploymentRegisterInput[] = [];
    const binding: DeploymentBinding = {
      ...inner,
      register: async (input) => {
        seen.push(input);
        return inner.register(input);
      },
    };
    const { app } = makeApp({ fixture, deploymentRegistry: binding });
    const r = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(r.status).toBe(201);
    expect(seen.map((input) => input.packId)).toEqual(['acme.aperture']);
    expect(seen.map((input) => input.packChecks)).toEqual([['must-cite']]);
  });

  test("packChecks: only the checks the image's pack service runs, not a built-in a guardrail merely names", async () => {
    const guardrail = (id: string, checkId: string, extra: Record<string, unknown>) => ({
      id,
      kind: 'zero-llm',
      action: { 'on-violation': 'halt' },
      checkId,
      ...extra,
    });
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [
          guardrail('acme.own', 'acme.checks.own', { checkModulePath: 'guardrails/own.mjs' }),
          guardrail('acme.cites', 'must-cite', {
            checkModulePath: 'guardrails/cites.mjs',
            checkBuiltIn: true,
            config: { minCitations: 1 },
          }),
        ],
        agents: [],
        flows: [],
      },
    });
    const inner = makeInMemoryDeploymentBinding();
    const seen: DeploymentRegisterInput[] = [];
    const binding: DeploymentBinding = {
      ...inner,
      register: async (input) => {
        seen.push(input);
        return inner.register(input);
      },
    };
    const { app } = makeApp({ fixture, deploymentRegistry: binding });
    const r = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(seen.map((input) => input.packChecks)).toEqual([['acme.checks.own']]);
  });
});

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
        // The flow's tool ships in the pack: a flow is pinned at deploy,
        // and a tool with no published version refuses it.
        tools: [
          {
            id: 'inline',
            description: 'Runs inline.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/inline.js',
          },
        ],
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
    /** The project the seeded deployment was deployed into; absent: tenant-wide. */
    deployedInto?: ProjectId;
    resolveTokenOverride?: TokenResolver;
    /** The env the runtime serves, refusing every other (`refuseOtherEnvs`). */
    servedEnv?: string;
    /** The providers registered, whose keys a sync under their env may still write. */
    providerRegistry?: unknown;
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
    ...(opts.servedEnv !== undefined && {
      envName: opts.servedEnv as EnvName,
      refuseOtherEnvs: true,
    }),
    ...(opts.providerRegistry !== undefined && {
      providerRegistry: opts.providerRegistry as never,
    }),
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
    ...(opts.deployedInto !== undefined && { projectId: opts.deployedInto }),
  });
  if (registerOutcome.kind !== 'ok') {
    throw new Error('failed to seed deployment');
  }
  const deploymentId = registerOutcome.deployment.deploymentId;

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

describe('POST /v1/deployments/:deploymentId/secrets — a new inline name is held to the shared grammar', () => {
  test('refuses a new { name, value } whose name is out of grammar, writing nothing', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp();
    const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRETS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        envName: 'staging',
        secrets: [{ name: 'acme/new-inline', value: 'v' }],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'secret-name-invalid',
    );
    expect(secretsFixture.recordedSets).toHaveLength(0);
  });

  test('the refusal leaves nothing half-written when a valid entry comes before the bad one', async () => {
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
          { name: 'fine.one', value: 'v1' },
          { name: '.bad', value: 'v2' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'secret-name-invalid',
    );
    expect(secretsFixture.recordedSets).toHaveLength(0);
  });

  test('an existing out-of-grammar name still takes a new inline value (add-version)', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      seedSecrets: [
        {
          scope: { kind: 'tenant', tenantId } as Scope,
          envName: 'staging',
          name: 'acme/legacy',
          currentVersion: 3,
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
        secrets: [{ name: 'acme/legacy', value: 'rotated' }],
      }),
    });
    expect(res.status).toBe(200);
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

  test('a deploy into a named project → writes to { kind: "project", tenantId, projectId }', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      deployedInto: DEFAULT_PROJECT_ID,
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

// ---------------- agents are pinned (evals step 2) ----------------

/** A tool registry keyed by (id, version), as the runtime's is. */
function makeVersionedToolRegistry(): ToolRegistryBinding & { versions: (id: string) => string[] } {
  const rows = new Map<string, Map<string, unknown>>();
  const versionsOf = (id: string) => [...(rows.get(id)?.keys() ?? [])];
  return {
    versions: versionsOf,
    async list() {
      return { data: [] };
    },
    async get() {
      return null;
    },
    async getVersion({ toolId, version }) {
      return (rows.get(toolId as unknown as string)?.get(version as unknown as string) ??
        null) as never;
    },
    async headExists({ toolId }) {
      return rows.has(toolId as unknown as string);
    },
    async listVersions({ toolId }) {
      return { data: [...(rows.get(toolId as unknown as string)?.values() ?? [])] as never[] };
    },
    async resolve({ toolId }) {
      return { kind: 'not-found', toolId };
    },
    async publish({ tool }) {
      const id = tool.id as unknown as string;
      const version = tool.version as unknown as string;
      let byVersion = rows.get(id);
      if (byVersion === undefined) {
        byVersion = new Map();
        rows.set(id, byVersion);
      }
      if (byVersion.has(version)) {
        return { kind: 'already-registered', toolId: tool.id, version: tool.version as never };
      }
      byVersion.set(version, tool);
      return { kind: 'ok', toolId: tool.id, version: tool.version as never };
    },
    async unregister({ toolId, version }) {
      return {
        unregistered: rows.get(toolId as unknown as string)?.delete(version as never) ?? false,
      };
    },
    async reinstateVersion({ toolId, version }) {
      return { kind: 'not-found', toolId, version };
    },
  };
}

/** An agent registry that lists and reads its versions back, as the runtime's does. */
function makeVersionedAgentRegistry(
  opts: { recordsProject?: boolean } = {},
): AgentRegistryBinding & {
  versions: () => Agent[];
  seed: (agent: Agent) => void;
} {
  const rows = new Map<string, Agent>();
  // With `recordsProject`, the agent stays in its first version's project.
  let owner: ProjectId | undefined;
  return {
    versions: () => [...rows.values()],
    seed: (agent) => rows.set(agent.version as unknown as string, agent),
    async list() {
      return { data: [] };
    },
    async get() {
      const latest = latestVersion([...rows.keys()]);
      return latest === undefined ? null : (rows.get(latest) ?? null);
    },
    async getVersion({ version }) {
      const row = rows.get(version as unknown as string);
      if (row === undefined) return null;
      return owner === undefined ? row : { ...row, projectId: owner };
    },
    async headExists() {
      return rows.size > 0;
    },
    async listVersions() {
      return { data: [...rows.values()] };
    },
    async publish({ agent, projectId }) {
      if (owner !== undefined && owner !== projectId) {
        return {
          kind: 'project-mismatch',
          agentId: agent.id,
          version: agent.version,
          projectId: owner,
        };
      }
      if (rows.has(agent.version as unknown as string)) {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      rows.set(agent.version as unknown as string, agent);
      if (opts.recordsProject === true) owner = projectId;
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister({ version }) {
      return { unregistered: rows.delete(version as unknown as string) };
    },
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
  };
}

/** A flow registry that lists and reads its versions back, as the runtime's does. */
function makeVersionedFlowRegistry(
  opts: { recordsProject?: boolean } = {},
): FlowRegistryBinding & { versions: () => Flow[] } {
  const rows = new Map<string, Flow>();
  // With `recordsProject`, the flow stays in its first version's project.
  let owner: ProjectId | undefined;
  return {
    versions: () => [...rows.values()],
    async list() {
      return { data: [] };
    },
    async get() {
      return null;
    },
    async getVersion({ version }: Parameters<FlowRegistryBinding['getVersion']>[0]) {
      const row = rows.get(version as unknown as string);
      if (row === undefined) return null;
      return owner === undefined ? row : { ...row, projectId: owner };
    },
    async headExists() {
      return rows.size > 0;
    },
    async listVersions() {
      return { data: [...rows.values()] };
    },
    async publish({ flow, projectId }: Parameters<FlowRegistryBinding['publish']>[0]) {
      if (owner !== undefined && owner !== projectId) {
        return {
          kind: 'project-mismatch',
          flowId: flow.id,
          version: flow.version,
          projectId: owner,
        };
      }
      if (rows.has(flow.version)) {
        return { kind: 'already-registered', flowId: flow.id, version: flow.version };
      }
      rows.set(flow.version, flow);
      if (opts.recordsProject === true) owner = projectId;
      return { kind: 'ok', flowId: flow.id, version: flow.version };
    },
    async unregister({ version }: Parameters<FlowRegistryBinding['unregister']>[0]) {
      return { unregistered: rows.delete(version as unknown as string) };
    },
    async reinstateVersion({
      flowId,
      version,
    }: Parameters<FlowRegistryBinding['reinstateVersion']>[0]) {
      return { kind: 'not-found', flowId, version };
    },
  } as unknown as FlowRegistryBinding & { versions: () => Flow[] };
}

/**
 * A pack with one tool version and one agent that uses the tool by
 * range; with `flowVersion`, also a flow that runs the tool and the
 * agent (at no named version).
 */
function pinnedPack(opts: {
  toolVersion: string;
  agentVersion: string;
  range?: string;
  instructions?: string;
  artifactVersion?: string;
  flowVersion?: string;
  /** The tool's `needsSpec`, when it names any. */
  needsSpec?: Record<string, unknown>;
}): SignedDeploy {
  const artifactVersion = opts.artifactVersion ?? '20261005.1';
  const publishedAt = '2026-10-05T00:00:00.000Z';
  return buildSignedDeploy({
    artifactVersion,
    publishedAt,
    index: {
      v: 1,
      artifactVersion,
      publishedAt,
      tools: [
        {
          id: 'acme.score',
          description: 'Scores a match.',
          version: opts.toolVersion,
          input: { type: 'object', properties: { q: { type: 'string' } } },
          output: { type: 'object', properties: { score: { type: 'number' } } },
          modulePath: `./tools/score-${opts.toolVersion}.js`,
          ...(opts.needsSpec !== undefined && { needsSpec: opts.needsSpec }),
        },
      ],
      guardrails: [],
      agents: [
        {
          id: 'acme.matcher',
          version: opts.agentVersion,
          name: 'Matcher',
          instructions: opts.instructions ?? 'Match the request.',
          capabilities: [{ feature: 'model.text.chat' }],
          tools: [{ id: 'acme.score', version: opts.range ?? '^1.0.0' }],
        },
      ],
      flows:
        opts.flowVersion === undefined
          ? []
          : [
              {
                id: 'acme.review',
                version: opts.flowVersion,
                nodes: [
                  { id: 'score', kind: 'tool', ref: 'acme.score' },
                  { id: 'match', kind: 'agent', ref: 'acme.matcher' },
                ],
                edges: [
                  { id: 'e0', from: '$start', to: 'score' },
                  { id: 'e1', from: 'score', to: 'match' },
                  { id: 'e2', from: 'match', to: '$end' },
                ],
              },
            ],
    },
  });
}

describe('POST /v1/deployments — agents are pinned, and a deploy never keeps old pins', () => {
  const trustOf = (f: SignedDeploy): TrustEntry => ({
    keyId: KEY_ID,
    tenantId,
    publicKey: Buffer.from(f.publicKeyRaw).toString('base64'),
  });
  const imageOf = (f: SignedDeploy): FakeImage => ({
    imageRef: f.imageRef,
    digest: f.digest,
    indexBytes: f.indexBytes,
  });

  function setup(...packs: SignedDeploy[]) {
    return setupWith(undefined, ...packs);
  }

  function setupWith(agentPins: AgentPinBindings | undefined, ...packs: SignedDeploy[]) {
    return setupWithApp(agentPins !== undefined ? { agentPins } : {}, ...packs);
  }

  function setupWithApp(extra: Partial<Parameters<typeof createApp>[0]>, ...packs: SignedDeploy[]) {
    const tools = makeVersionedToolRegistry();
    const agents = makeVersionedAgentRegistry();
    const flows = makeVersionedFlowRegistry();
    const { app } = makeApp({
      toolRegistry: tools,
      agentRegistry: agents,
      flowRegistry: flows,
      extra,
      extraTrust: packs.map(trustOf),
      extraImages: packs.map(imageOf),
    });
    const deploy = async (f: SignedDeploy) => {
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(f.wire),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { tools, agents, flows, deploy };
  }

  /** A pack whose agent and flow name `acme.other-tool`, which it doesn't bring. */
  function packNamingAnOutsideTool(): SignedDeploy {
    const artifactVersion = '20261011.1';
    const publishedAt = '2026-10-11T00:00:00.000Z';
    return buildSignedDeploy({
      artifactVersion,
      publishedAt,
      index: {
        v: 1,
        artifactVersion,
        publishedAt,
        tools: [
          {
            id: 'acme.score',
            description: 'Scores a match.',
            version: '1.0.0',
            input: { type: 'object', properties: { q: { type: 'string' } } },
            output: { type: 'object', properties: { score: { type: 'number' } } },
            modulePath: './tools/score-1.0.0.js',
          },
        ],
        guardrails: [],
        agents: [
          {
            id: 'acme.matcher',
            version: '1.4.0',
            name: 'Matcher',
            instructions: 'Match the request.',
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [
              { id: 'acme.score', version: '^1.0.0' },
              { id: 'acme.other-tool', version: '^1.0.0' },
            ],
          },
        ],
        flows: [
          {
            id: 'acme.route',
            version: '1.0.0',
            nodes: [{ id: 'step', kind: 'tool', ref: 'acme.other-tool' }],
            edges: [
              { id: 'e0', from: '$start', to: 'step' },
              { id: 'e1', from: 'step', to: '$end' },
            ],
          },
        ],
      },
    });
  }

  test('an agent or flow naming a tool neither the deploy brings nor its project reaches is refused, before anything registers', async () => {
    const pack = packNamingAnOutsideTool();
    const asked: string[] = [];
    const tools = makeVersionedToolRegistry();
    const { app } = makeApp({
      toolRegistry: tools,
      agentRegistry: makeVersionedAgentRegistry(),
      flowRegistry: makeVersionedFlowRegistry(),
      extra: {
        referenceScope: {
          reachable: async ({ ref }) => {
            asked.push(ref.id);
            return !ref.id.startsWith('acme.other');
          },
        },
      },
      extraTrust: [trustOf(pack)],
      extraImages: [imageOf(pack)],
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(pack.wire),
    });
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('reference-out-of-scope');
    expect(body.error.details.issues).toEqual([
      expect.objectContaining({ path: '/agents/0/tools/1', kind: 'tool', id: 'acme.other-tool' }),
      expect.objectContaining({ path: '/flows/0/nodes/step', kind: 'tool', id: 'acme.other-tool' }),
    ]);
    // What the deploy brings itself is never asked about.
    expect(asked).toEqual(['acme.other-tool']);
    expect(tools.versions('acme.score')).toEqual([]);
  });

  test('a deploy into a named project is checked against what that project reaches', async () => {
    const pack = packNamingAnOutsideTool();
    const tools = makeVersionedToolRegistry();
    // Registered already, by another pack: the Default project's to reach, not the client's.
    await tools.publish({ tool: { id: 'acme.other-tool', version: '1.0.0' } } as never);
    const { app } = makeApp({
      toolRegistry: tools,
      agentRegistry: makeVersionedAgentRegistry(),
      flowRegistry: makeVersionedFlowRegistry(),
      extra: {
        referenceScope: {
          reachable: async ({ fromProjectId, ref }) =>
            fromProjectId === DEFAULT_PROJECT_ID || !ref.id.startsWith('acme.other'),
        },
      },
      extraTrust: [trustOf(pack)],
      extraImages: [imageOf(pack)],
    });
    const deploy = (wire: unknown) =>
      app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(wire),
      });
    const intoClient = await deploy({ ...pack.wire, projectId: CLIENT_A });
    const body = (await intoClient.json()) as Record<string, any>;
    expect(intoClient.status).toBe(400);
    expect(body.error.code).toBe('reference-out-of-scope');
    expect(tools.versions('acme.score')).toEqual([]);
    // The same pack, into the Default project, reaches it.
    const intoDefault = await deploy(pack.wire);
    expect(intoDefault.status, await intoDefault.clone().text()).toBe(201);
  });

  test('a new tool version in range registers the next patch of the agent, naming the pin that changed', async () => {
    const first = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0' });
    const second = pinnedPack({ toolVersion: '1.1.0', agentVersion: '1.4.0' });
    const { agents, deploy } = setup(first, second);

    const one = await deploy(first);
    expect(one.status).toBe(201);
    expect(one.body.contents.agents).toEqual([{ id: 'acme.matcher', version: '1.4.0' }]);

    const two = await deploy(second);
    expect(two.status).toBe(201);
    expect(two.body.contents.agents).toEqual([
      {
        id: 'acme.matcher',
        version: '1.4.1',
        authoredVersion: '1.4.0',
        reason: 'pins-changed',
        newVersion: true,
        pinChanges: [{ kind: 'tool', id: 'acme.score', from: '1.0.0', to: '1.1.0' }],
      },
    ]);
    const byVersion = Object.fromEntries(agents.versions().map((a) => [a.version, a]));
    expect(byVersion['1.4.0']?.pins?.tools).toEqual({ 'acme.score': '1.0.0' });
    expect(byVersion['1.4.1']?.pins?.tools).toEqual({ 'acme.score': '1.1.0' });
    expect(byVersion['1.4.1']?.derivedFrom).toEqual({ version: '1.4.0', reason: 'pins-changed' });
    expect(byVersion['1.4.1']?.pinsDigest).toBe(pinsDigest(byVersion['1.4.1']?.pins as AgentPins));
  });

  test('redeploying changes nothing; setting the registered version in the code is unchanged too', async () => {
    const first = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0' });
    const second = pinnedPack({ toolVersion: '1.1.0', agentVersion: '1.4.0' });
    const again = pinnedPack({
      toolVersion: '1.1.0',
      agentVersion: '1.4.0',
      artifactVersion: '20261005.2',
    });
    const matched = pinnedPack({
      toolVersion: '1.1.0',
      agentVersion: '1.4.1',
      artifactVersion: '20261005.3',
    });
    const { agents, deploy } = setup(first, second, again, matched);
    await deploy(first);
    await deploy(second);

    const three = await deploy(again);
    expect(three.status).toBe(201);
    expect(three.body.contents.agents).toEqual([
      {
        id: 'acme.matcher',
        version: '1.4.1',
        authoredVersion: '1.4.0',
        reason: 'pins-changed',
        newVersion: false,
        pinChanges: [{ kind: 'tool', id: 'acme.score', from: '1.0.0', to: '1.1.0' }],
      },
    ]);
    const four = await deploy(matched);
    expect(four.body.contents.agents).toEqual([{ id: 'acme.matcher', version: '1.4.1' }]);
    expect(
      agents
        .versions()
        .map((a) => a.version)
        .sort(),
    ).toEqual(['1.4.0', '1.4.1']);
  });

  /** A deploy of each pack into `projectId`, against the same registries. */
  function deployInto(
    registries: {
      tools: ToolRegistryBinding;
      agents: AgentRegistryBinding;
      flows: FlowRegistryBinding;
    },
    projectId: ProjectId,
    deploymentRegistry: DeploymentBinding,
    ...packs: SignedDeploy[]
  ) {
    const { app } = makeApp({
      toolRegistry: registries.tools,
      agentRegistry: registries.agents,
      flowRegistry: registries.flows,
      deploymentRegistry,
      projectId,
      extraTrust: packs.map(trustOf),
      extraImages: packs.map(imageOf),
    });
    return async (f: SignedDeploy) => {
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(f.wire),
      });
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
    };
  }

  test('an unchanged agent of another project is refused: 409 agent-project-mismatch, nothing deployed', async () => {
    const pack = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0' });
    const registries = {
      tools: makeVersionedToolRegistry(),
      agents: makeVersionedAgentRegistry({ recordsProject: true }),
      flows: makeVersionedFlowRegistry({ recordsProject: true }),
    };
    const projectB = randomUUID() as ProjectId;
    const recordedB = makeInMemoryDeploymentBinding();
    const intoA = deployInto(registries, DEFAULT_PROJECT_ID, makeInMemoryDeploymentBinding(), pack);
    const intoB = deployInto(registries, projectB, recordedB, pack);

    expect((await intoA(pack)).status).toBe(201);
    // The same pack again, unchanged, into another project: it would write nothing.
    const moved = await intoB(pack);
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('agent-project-mismatch');
    expect(moved.body.error.details).toEqual({ primitive: 'agent', id: 'acme.matcher@1.4.0' });
    expect(moved.text).not.toContain(DEFAULT_PROJECT_ID);
    expect((await recordedB.list({ tenantId, limit: 10 })).data).toEqual([]);
    // The same project, unchanged: as before.
    const again = deployInto(registries, DEFAULT_PROJECT_ID, makeInMemoryDeploymentBinding(), pack);
    const same = await again(pack);
    expect(same.status).toBe(201);
    expect(same.body.contents.agents).toEqual([{ id: 'acme.matcher', version: '1.4.0' }]);
  });

  test('an unchanged flow of another project is refused: 409 flow-project-mismatch, nothing deployed', async () => {
    const pack = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0', flowVersion: '1.0.0' });
    const registries = {
      tools: makeVersionedToolRegistry(),
      // The agent's registry records no project: only the flow is held to its project here.
      agents: makeVersionedAgentRegistry(),
      flows: makeVersionedFlowRegistry({ recordsProject: true }),
    };
    const projectB = randomUUID() as ProjectId;
    const recordedB = makeInMemoryDeploymentBinding();
    const intoA = deployInto(registries, DEFAULT_PROJECT_ID, makeInMemoryDeploymentBinding(), pack);
    const intoB = deployInto(registries, projectB, recordedB, pack);

    expect((await intoA(pack)).status).toBe(201);
    const moved = await intoB(pack);
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('flow-project-mismatch');
    expect(moved.body.error.details).toEqual({ primitive: 'flow', id: 'acme.review@1.0.0' });
    expect(moved.text).not.toContain(DEFAULT_PROJECT_ID);
    expect((await recordedB.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test('a version taken by a different definition registers the next free one in its line', async () => {
    const first = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0' });
    const edited = pinnedPack({
      toolVersion: '1.0.0',
      agentVersion: '1.4.0',
      instructions: 'Match the request, strictly.',
      artifactVersion: '20261005.2',
    });
    const { agents, deploy } = setup(first, edited);
    // 1.4.1 is taken: an earlier, different definition holds it.
    agents.seed({
      id: 'acme.matcher',
      version: '1.4.1',
      name: 'Matcher',
      instructions: 'Something else entirely.',
      capabilities: [{ feature: 'model.text.chat' }],
      tools: [],
    } as unknown as Agent);
    await deploy(first);

    const two = await deploy(edited);
    expect(two.body.contents.agents).toEqual([
      {
        id: 'acme.matcher',
        version: '1.4.2',
        authoredVersion: '1.4.0',
        reason: 'version-taken',
        newVersion: true,
      },
    ]);
  });

  test('a version published before pins registers a pinned next patch', async () => {
    const pack = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0' });
    const { agents, deploy } = setup(pack);
    agents.seed({
      id: 'acme.matcher',
      version: '1.4.0',
      name: 'Matcher',
      instructions: 'Match the request.',
      capabilities: [{ feature: 'model.text.chat' }],
      tools: [{ id: 'acme.score', version: '^1.0.0' }],
    } as unknown as Agent);

    const res = await deploy(pack);
    expect(res.body.contents.agents).toEqual([
      {
        id: 'acme.matcher',
        version: '1.4.1',
        authoredVersion: '1.4.0',
        reason: 'unpinned',
        newVersion: true,
      },
    ]);
  });

  test('a range that matches no published version refuses the deploy and rolls back its tools', async () => {
    const pack = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0', range: '^2.0.0' });
    const { tools, agents, deploy } = setup(pack);
    const res = await deploy(pack);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(res.body.error.details.issues).toEqual([
      {
        path: '/agents/0/tools/0/version',
        message: expect.stringContaining(
          'agent "acme.matcher": tool "acme.score" has no published version in "^2.0.0" (published: 1.0.0)',
        ),
      },
    ]);
    expect(tools.versions('acme.score')).toEqual([]);
    expect(agents.versions()).toEqual([]);
  });

  test("with pinned versions, a deployed flow's agent pins to what's pinned for the project, not the version this deploy registered (T268)", async () => {
    const pack = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0', flowVersion: '2.0.0' });
    const asked: AgentPinResolveInput[] = [];
    const pinStore = {
      pinned: {
        async resolve(input: AgentPinResolveInput) {
          asked.push(input);
          return input.agentId === 'acme.matcher'
            ? { version: '1.3.0' as Semver, scope: { kind: 'tenant' as const } }
            : null;
        },
        list: async () => [],
      },
      changes: {},
    } as unknown as AgentPinBindings;
    const { flows, deploy } = setupWith(pinStore, pack);

    const res = await deploy(pack);
    expect(res.status).toBe(201);
    expect(flows.versions()[0]?.pins).toEqual({
      tools: { 'acme.score': '1.0.0' },
      agents: { 'acme.matcher': '1.3.0' },
    });
    expect(asked).toEqual([
      { tenantId: expect.any(String), agentId: 'acme.matcher', projectId: DEFAULT_PROJECT_ID },
    ]);
  });

  test('one tool change cascades through an agent into a flow in a single deploy, each derived once', async () => {
    const first = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0', flowVersion: '2.0.0' });
    const second = pinnedPack({
      toolVersion: '1.1.0',
      agentVersion: '1.4.0',
      flowVersion: '2.0.0',
    });
    const again = pinnedPack({
      toolVersion: '1.1.0',
      agentVersion: '1.4.0',
      flowVersion: '2.0.0',
      artifactVersion: '20261005.2',
    });
    const { agents, flows, deploy } = setup(first, second, again);

    const one = await deploy(first);
    expect(one.status).toBe(201);
    expect(one.body.contents.flows).toEqual([{ id: 'acme.review', version: '2.0.0' }]);
    expect(flows.versions()[0]?.pins).toEqual({
      tools: { 'acme.score': '1.0.0' },
      agents: { 'acme.matcher': '1.4.0' },
    });

    const two = await deploy(second);
    expect(two.status).toBe(201);
    expect(two.body.contents.agents).toMatchObject([
      { id: 'acme.matcher', version: '1.4.1', authoredVersion: '1.4.0', newVersion: true },
    ]);
    expect(two.body.contents.flows).toEqual([
      {
        id: 'acme.review',
        version: '2.0.1',
        authoredVersion: '2.0.0',
        reason: 'pins-changed',
        newVersion: true,
        pinChanges: [
          { kind: 'tool', id: 'acme.score', from: '1.0.0', to: '1.1.0' },
          { kind: 'agent', id: 'acme.matcher', from: '1.4.0', to: '1.4.1' },
        ],
      },
    ]);
    const derived = flows.versions().find((f) => f.version === '2.0.1');
    expect(derived?.pins).toEqual({
      tools: { 'acme.score': '1.1.0' },
      agents: { 'acme.matcher': '1.4.1' },
    });
    expect(derived?.pinsDigest).toBe(flowPinsDigest(derived?.pins as FlowPins));
    expect(derived?.derivedFrom).toEqual({ version: '2.0.0', reason: 'pins-changed' });

    // A redeploy derives nothing more: the cascade ended in the one deploy.
    const three = await deploy(again);
    expect(three.body.contents.agents).toMatchObject([{ version: '1.4.1', newVersion: false }]);
    expect(three.body.contents.flows).toMatchObject([{ version: '2.0.1', newVersion: false }]);
    expect(
      agents
        .versions()
        .map((a) => a.version)
        .sort(),
    ).toEqual(['1.4.0', '1.4.1']);
    expect(
      flows
        .versions()
        .map((f) => f.version)
        .sort(),
    ).toEqual(['2.0.0', '2.0.1']);
  });

  test("a tool's pin for the deploy's project is the lock: a new tool version in range changes no agent or flow", async () => {
    const first = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.4.0', flowVersion: '2.0.0' });
    const second = pinnedPack({
      toolVersion: '1.1.0',
      agentVersion: '1.4.0',
      flowVersion: '2.0.0',
    });
    const asked: PinnedResolveInput[] = [];
    const { tools, agents, flows, deploy } = setupWithApp(
      { pinnedVersions: toolPinsBinding({ 'acme.score': '1.0.0' }, asked) },
      first,
      second,
    );

    expect((await deploy(first)).status).toBe(201);
    const two = await deploy(second);
    expect(two.status).toBe(201);
    // The new tool version is registered, and nothing locks to it.
    expect(tools.versions('acme.score')).toEqual(['1.0.0', '1.1.0']);
    expect(two.body.contents.agents).toEqual([{ id: 'acme.matcher', version: '1.4.0' }]);
    expect(two.body.contents.flows).toEqual([{ id: 'acme.review', version: '2.0.0' }]);
    expect(agents.versions().map((a) => [a.version, a.pins?.tools])).toEqual([
      ['1.4.0', { 'acme.score': '1.0.0' }],
    ]);
    expect(flows.versions().map((f) => [f.version, f.pins])).toEqual([
      ['2.0.0', { tools: { 'acme.score': '1.0.0' }, agents: { 'acme.matcher': '1.4.0' } }],
    ]);
    // Asked for the deploy's project, about the tool only.
    expect(new Set(asked.map((a) => `${a.kind} ${a.itemId} ${a.projectId}`))).toEqual(
      new Set([`tool acme.score ${DEFAULT_PROJECT_ID}`]),
    );
  });
});

// ---------------- a redeploy after a rolled-back deploy ----------------

/**
 * A tool registry keyed by (id, version) whose `unregister` retires a
 * version, as the runtime's does: its number stays taken (`publish`
 * answers `already-registered`), `listVersions` lists it only with
 * `includeTombstoned` (with `unregisteredAt`), and `reinstateVersion`
 * makes it active again.
 */
function makeRetiringToolRegistry(opts: { versionsPerPage?: number } = {}): ToolRegistryBinding & {
  /** Each version, as `id@version active|unregistered`. */
  states: () => string[];
  /** Every reinstate asked, as `id@version`. */
  reinstated: string[];
  /** Store `tool` as a version an earlier deploy published, since unregistered. */
  seedRetired: (tool: Record<string, unknown>) => void;
  /** Store `tool` as a version an earlier deploy published. */
  seedActive: (tool: Record<string, unknown>) => void;
} {
  const rows = new Map<
    string,
    { readonly tool: Record<string, unknown>; unregisteredAt: string | undefined }
  >();
  const key = (id: unknown, version: unknown) => `${id as string}@${version as string}`;
  const reinstated: string[] = [];
  return {
    states: () =>
      [...rows.entries()]
        .map(([k, r]) => `${k} ${r.unregisteredAt === undefined ? 'active' : 'unregistered'}`)
        .sort(),
    reinstated,
    seedRetired: (tool) =>
      rows.set(key(tool.id, tool.version), { tool, unregisteredAt: '2026-10-01T00:00:00.000Z' }),
    seedActive: (tool) => rows.set(key(tool.id, tool.version), { tool, unregisteredAt: undefined }),
    async list() {
      return { data: [] };
    },
    async get() {
      return null;
    },
    async getVersion({ toolId, version }) {
      return (rows.get(key(toolId, version))?.tool as never) ?? null;
    },
    async headExists({ toolId }) {
      return [...rows.keys()].some((k) => k.startsWith(key(toolId, '')));
    },
    async listVersions({ toolId, includeTombstoned, cursor }) {
      const all = [...rows.entries()]
        .filter(([k]) => k.startsWith(key(toolId, '')))
        .filter(([, r]) => includeTombstoned === true || r.unregisteredAt === undefined)
        .map(([, r]) => ({
          ...r.tool,
          ...(r.unregisteredAt !== undefined && { unregisteredAt: r.unregisteredAt }),
        }));
      // Pages of `versionsPerPage`, the cursor the next page's first index.
      const from = cursor === undefined ? 0 : Number(cursor);
      const to = from + (opts.versionsPerPage ?? all.length);
      return {
        data: all.slice(from, to) as never[],
        ...(to < all.length && { nextCursor: String(to) as never }),
      };
    },
    async resolve({ toolId }) {
      return { kind: 'not-found', toolId };
    },
    async publish({ tool }) {
      const k = key(tool.id, tool.version);
      if (rows.has(k)) {
        return { kind: 'already-registered', toolId: tool.id, version: tool.version as never };
      }
      rows.set(k, { tool: tool as never, unregisteredAt: undefined });
      return { kind: 'ok', toolId: tool.id, version: tool.version as never };
    },
    async unregister({ toolId, version }) {
      const row = rows.get(key(toolId, version));
      if (row === undefined || row.unregisteredAt !== undefined) return { unregistered: false };
      row.unregisteredAt = new Date().toISOString();
      return { unregistered: true };
    },
    async reinstateVersion({ toolId, version }) {
      reinstated.push(key(toolId, version));
      const row = rows.get(key(toolId, version));
      if (row === undefined) return { kind: 'not-found', toolId, version };
      const wasTombstoned = row.unregisteredAt !== undefined;
      row.unregisteredAt = undefined;
      return { kind: 'ok', toolId, version, wasTombstoned };
    },
  };
}

describe('POST /v1/deployments — a redeploy after a rolled-back deploy', () => {
  const pack = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.0.0', flowVersion: '1.0.0' });
  /** `acme.score@1.0.0` as a deploy of `pack` stores it: the pack's tool, with its code's place. */
  const scoreTool = {
    id: 'acme.score',
    description: 'Scores a match.',
    version: '1.0.0',
    input: { type: 'object', properties: { q: { type: 'string' } } },
    output: { type: 'object', properties: { score: { type: 'number' } } },
    codeArtifactRef: {
      kind: 'oci',
      imageRef: pack.imageRef,
      modulePath: './tools/score-1.0.0.js',
      artifactVersion: '20261005.1',
    },
  };

  /** One app over `tools`; its deployment record throws for the first `failures` deploys. */
  function setup(
    tools: ToolRegistryBinding,
    opts: {
      failures?: number;
      packs?: readonly SignedDeploy[];
      extra?: Partial<Parameters<typeof createApp>[0]>;
    } = {},
  ) {
    const deploymentRegistry = makeFailingDeploymentBinding(opts.failures ?? 0);
    const packs = opts.packs ?? [pack];
    const flows = makeVersionedFlowRegistry();
    const { app } = makeApp({
      deploymentRegistry,
      toolRegistry: tools,
      agentRegistry: makeVersionedAgentRegistry(),
      flowRegistry: flows,
      ...(opts.extra !== undefined && { extra: opts.extra }),
      extraTrust: packs.map((f) => ({
        keyId: KEY_ID,
        tenantId,
        publicKey: Buffer.from(f.publicKeyRaw).toString('base64'),
      })),
      extraImages: packs.map((f) => ({
        imageRef: f.imageRef,
        digest: f.digest,
        indexBytes: f.indexBytes,
      })),
    });
    const deploy = async (f: SignedDeploy = pack) => {
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(f.wire),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { flows, deploy };
  }

  test('a deploy that failed after its tool publish unregistered the tool; the same image deploys again, and its agent and flow pin the tool', async () => {
    const tools = makeRetiringToolRegistry();
    const { flows, deploy } = setup(tools, { failures: 1 });

    const failed = await deploy();
    expect(failed.status).toBe(500);
    expect(tools.states()).toEqual(['acme.score@1.0.0 unregistered']);

    const again = await deploy();
    expect(again.status).toBe(201);
    expect(tools.reinstated).toEqual(['acme.score@1.0.0']);
    expect(tools.states()).toEqual(['acme.score@1.0.0 active']);
    expect(again.body.contents.tools).toEqual([{ id: 'acme.score', version: '1.0.0' }]);
    expect(flows.versions()[0]?.pins).toEqual({
      tools: { 'acme.score': '1.0.0' },
      agents: { 'acme.matcher': '1.0.0' },
    });
  });

  test('a redeploy that fails again unregisters the version it reinstated', async () => {
    const tools = makeRetiringToolRegistry();
    const { deploy } = setup(tools, { failures: 2 });

    expect((await deploy()).status).toBe(500);
    expect((await deploy()).status).toBe(500);
    expect(tools.reinstated).toEqual(['acme.score@1.0.0']);
    expect(tools.states()).toEqual(['acme.score@1.0.0 unregistered']);

    expect((await deploy()).status).toBe(201);
    expect(tools.states()).toEqual(['acme.score@1.0.0 active']);
  });

  test("a version past its registry's first page of versions is found, and reinstated", async () => {
    const tools = makeRetiringToolRegistry({ versionsPerPage: 1 });
    tools.seedActive({ ...scoreTool, version: '0.9.0' });
    tools.seedRetired(scoreTool);
    const { deploy } = setup(tools);

    expect((await deploy()).status).toBe(201);
    expect(tools.reinstated).toEqual(['acme.score@1.0.0']);
    expect(tools.states()).toEqual(['acme.score@0.9.0 active', 'acme.score@1.0.0 active']);
  });

  test("a version reinstated since its registry listed it isn't this deploy's to unregister rolling back", async () => {
    const tools = makeRetiringToolRegistry();
    tools.seedRetired(scoreTool);
    const { deploy } = setup(
      {
        ...tools,
        // Another caller reinstates it first: this deploy's reinstate finds it active.
        reinstateVersion: async (input) => {
          await tools.reinstateVersion(input);
          return tools.reinstateVersion(input);
        },
      },
      { failures: 1 },
    );

    expect((await deploy()).status).toBe(500);
    expect(tools.states()).toEqual(['acme.score@1.0.0 active']);
  });

  test("an active tool version isn't reinstated (as under kindgi dev, whose registry answers every publish already-registered and every reinstate not-found)", async () => {
    const tools = makeRetiringToolRegistry();
    const asked: string[] = [];
    const dev: ToolRegistryBinding = {
      ...tools,
      reinstateVersion: async ({ toolId, version }) => {
        asked.push(`${toolId as unknown as string}@${version as unknown as string}`);
        return { kind: 'not-found', toolId, version };
      },
    };
    const next = pinnedPack({
      toolVersion: '1.0.0',
      agentVersion: '1.0.0',
      flowVersion: '1.0.0',
      artifactVersion: '20261005.2',
      instructions: 'Match the request, briefly.',
    });
    const { deploy } = setup(dev, { packs: [pack, next] });

    expect((await deploy()).status).toBe(201);
    // A new image of the same pack: its tool version is already published, and active.
    expect((await deploy(next)).status).toBe(201);
    expect(asked).toEqual([]);
    expect(tools.states()).toEqual(['acme.score@1.0.0 active']);
  });

  test('a reinstate its registry answers not-found is a 500, and nothing else is written', async () => {
    const tools = makeRetiringToolRegistry();
    tools.seedRetired(scoreTool);
    const { flows, deploy } = setup({
      ...tools,
      reinstateVersion: async ({ toolId, version }) => ({ kind: 'not-found', toolId, version }),
    });

    const res = await deploy();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal-server-error');
    expect(tools.states()).toEqual(['acme.score@1.0.0 unregistered']);
    expect(flows.versions()).toEqual([]);
  });

  test("a reinstate its registry refuses as another kind (an MCP endpoint's tool) is a 409 tool-kind-mismatch, as its publish is; it stays unregistered, and nothing else is written", async () => {
    const tools = makeRetiringToolRegistry();
    tools.seedRetired(scoreTool);
    const { flows, deploy } = setup({
      ...tools,
      reinstateVersion: async ({ toolId, version }) => ({
        kind: 'kind-mismatch',
        toolId,
        version,
        endpointId: 'acme',
      }),
    });

    const res = await deploy();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('tool-kind-mismatch');
    expect(tools.states()).toEqual(['acme.score@1.0.0 unregistered']);
    expect(flows.versions()).toEqual([]);
  });

  test("an unregistered version naming a model provider's key stays unregistered: the pack's tool names it too, and the deploy is refused before any write", async () => {
    const needsSpec = { secrets: { ANTHROPIC_API_KEY: { type: 'string' } } };
    const keyed = pinnedPack({
      toolVersion: '1.0.0',
      agentVersion: '1.0.0',
      flowVersion: '1.0.0',
      artifactVersion: '20261005.2',
      needsSpec,
    });
    const tools = makeRetiringToolRegistry();
    // A deploy keeps a version only with the pack's definition, so the
    // stored version names the key as the pack's tool does.
    tools.seedRetired({ ...scoreTool, needsSpec });
    const { flows, deploy } = setup(tools, {
      packs: [keyed],
      extra: {
        providerRegistry: {
          resolveForRuntime: async () => [
            {
              metadata: { id: 'anthropic-main' },
              adapterId: '@kindgi/adapter-model-anthropic',
              secretRef: { envName: 'local', name: 'ANTHROPIC_API_KEY' },
            },
          ],
          register: async () => ({ kind: 'ok', providerId: 'anthropic-main' }),
          list: async () => ({ data: [] }),
          get: async () => null,
        } as never,
      },
    });

    const res = await deploy(keyed);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('deployment-validation-failed');
    expect(res.body.error.details.issues).toEqual([
      {
        primitive: 'tool',
        index: 0,
        id: 'acme.score',
        path: '/secrets/ANTHROPIC_API_KEY',
        message: expect.stringMatching(
          /^`ANTHROPIC_API_KEY` is the key of model provider "anthropic-main"/,
        ),
      },
    ]);
    expect(tools.reinstated).toEqual([]);
    expect(tools.states()).toEqual(['acme.score@1.0.0 unregistered']);
    expect(flows.versions()).toEqual([]);
  });

  /** `tools`, its unregister failing. */
  const unregisterFails = (tools: ToolRegistryBinding): ToolRegistryBinding => ({
    ...tools,
    unregister: async () => {
      throw new Error('the tool store is down');
    },
  });
  const toolWarn = {
    message: `deploy rollback: couldn't unregister tool "acme.score@1.0.0", so it stays as this deploy left it`,
    fields: { primitive: 'tool', id: 'acme.score@1.0.0', err: new Error('the tool store is down') },
  };

  test("a tool version the rollback can't unregister is warned, by name", async () => {
    const tools = makeRetiringToolRegistry();
    const logger = recordingLogger();
    const { deploy } = setup(unregisterFails(tools), { failures: 1, extra: { logger } });

    expect((await deploy()).status).toBe(500);
    expect(rollbackWarns(logger)).toEqual([toolWarn]);
    expect(tools.states()).toEqual(['acme.score@1.0.0 active']);
  });

  test("a reinstated tool version the rollback can't unregister again is warned, by name", async () => {
    const tools = makeRetiringToolRegistry();
    tools.seedRetired(scoreTool);
    const logger = recordingLogger();
    const { deploy } = setup(unregisterFails(tools), { failures: 1, extra: { logger } });

    expect((await deploy()).status).toBe(500);
    expect(tools.reinstated).toEqual(['acme.score@1.0.0']);
    expect(rollbackWarns(logger)).toEqual([toolWarn]);
    expect(tools.states()).toEqual(['acme.score@1.0.0 active']);
  });
});

/**
 * Agent or flow versions keyed by (id, version), whose `unregister`
 * retires a version as the runtime's does: its number stays taken
 * (`publish` answers `already-registered`), `getVersion` reads it with
 * `unregisteredAt`, and `reinstateVersion` makes it active again.
 */
function makeRetiringVersions() {
  const rows = new Map<
    string,
    { readonly definition: Record<string, unknown>; unregisteredAt: string | undefined }
  >();
  const key = (id: unknown, version: unknown) => `${id as string}@${version as string}`;
  const reinstated: string[] = [];
  return {
    /** Each version, as `id@version active|unregistered`. */
    states: () =>
      [...rows.entries()]
        .map(([k, r]) => `${k} ${r.unregisteredAt === undefined ? 'active' : 'unregistered'}`)
        .sort(),
    /** Every reinstate asked, as `id@version`. */
    reinstated,
    /** Store `definition` as a version an earlier deploy published, since unregistered. */
    seedRetired: (definition: Record<string, unknown>) =>
      rows.set(key(definition.id, definition.version), {
        definition: { ...definition, projectId: DEFAULT_PROJECT_ID },
        unregisteredAt: '2026-10-01T00:00:00.000Z',
      }),
    read: (id: unknown, version: unknown) => {
      const row = rows.get(key(id, version));
      if (row === undefined) return null;
      return {
        ...row.definition,
        ...(row.unregisteredAt !== undefined && { unregisteredAt: row.unregisteredAt }),
      } as never;
    },
    /** Whether `definition` is newly stored: `false` when its number is taken. */
    publish: (
      definition: { readonly id: unknown; readonly version: unknown },
      projectId: ProjectId,
    ) => {
      const k = key(definition.id, definition.version);
      if (rows.has(k)) return false;
      rows.set(k, { definition: { ...definition, projectId }, unregisteredAt: undefined });
      return true;
    },
    unregister: (id: unknown, version: unknown) => {
      const row = rows.get(key(id, version));
      if (row === undefined || row.unregisteredAt !== undefined) return false;
      row.unregisteredAt = new Date().toISOString();
      return true;
    },
    /** `undefined` for a version never stored, else whether it was unregistered. */
    reinstate: (id: unknown, version: unknown) => {
      reinstated.push(key(id, version));
      const row = rows.get(key(id, version));
      if (row === undefined) return undefined;
      const wasTombstoned = row.unregisteredAt !== undefined;
      row.unregisteredAt = undefined;
      return wasTombstoned;
    },
  };
}

type RetiringVersions = ReturnType<typeof makeRetiringVersions>;

function makeRetiringAgentRegistry(versions: RetiringVersions): AgentRegistryBinding {
  return {
    async list() {
      return { data: [] };
    },
    async get() {
      return null;
    },
    async getVersion({ agentId, version }) {
      return versions.read(agentId, version);
    },
    async headExists() {
      return false;
    },
    async listVersions() {
      return { data: [] };
    },
    async publish({ projectId, agent }) {
      return versions.publish(agent, projectId)
        ? { kind: 'ok', agentId: agent.id, version: agent.version }
        : { kind: 'already-registered', agentId: agent.id, version: agent.version };
    },
    async unregister({ agentId, version }) {
      return { unregistered: versions.unregister(agentId, version) };
    },
    async reinstateVersion({ agentId, version }) {
      const wasTombstoned = versions.reinstate(agentId, version);
      return wasTombstoned === undefined
        ? { kind: 'not-found', agentId, version }
        : { kind: 'ok', agentId, version, wasTombstoned };
    },
  };
}

function makeRetiringFlowRegistry(versions: RetiringVersions): FlowRegistryBinding {
  return {
    async list() {
      return { data: [] };
    },
    async get() {
      return null;
    },
    async getVersion({ flowId, version }) {
      return versions.read(flowId, version);
    },
    async headExists() {
      return false;
    },
    async listVersions() {
      return { data: [] };
    },
    async publish({ projectId, flow }) {
      return versions.publish(flow, projectId)
        ? { kind: 'ok', flowId: flow.id, version: flow.version }
        : { kind: 'already-registered', flowId: flow.id, version: flow.version };
    },
    async unregister({ flowId, version }) {
      return { unregistered: versions.unregister(flowId, version) };
    },
    async reinstateVersion({ flowId, version }) {
      const wasTombstoned = versions.reinstate(flowId, version);
      return wasTombstoned === undefined
        ? { kind: 'not-found', flowId, version }
        : { kind: 'ok', flowId, version, wasTombstoned };
    },
  };
}

describe('POST /v1/deployments — a redeploy after a rolled-back deploy, its agents and flows unpinned', () => {
  const pack = pinnedPack({ toolVersion: '1.0.0', agentVersion: '1.0.0', flowVersion: '1.0.0' });
  /** `acme.matcher@1.0.0` and `acme.review@1.0.0` as their registries store them. */
  const matcher = {
    id: 'acme.matcher',
    version: '1.0.0',
    name: 'Matcher',
    instructions: 'Match the request.',
    capabilities: [{ feature: 'model.text.chat' }],
    tools: [{ id: 'acme.score', version: '^1.0.0' }],
  };
  const review = {
    id: 'acme.review',
    version: '1.0.0',
    nodes: [
      { id: 'score', kind: 'tool', ref: 'acme.score' },
      { id: 'match', kind: 'agent', ref: 'acme.matcher' },
    ],
    edges: [
      { id: 'e0', from: '$start', to: 'score' },
      { id: 'e1', from: 'score', to: 'match' },
      { id: 'e2', from: 'match', to: '$end' },
    ],
  };
  /** A reference scope that reaches all but `acme.elsewhere`. */
  const scope: Partial<Parameters<typeof createApp>[0]> = {
    referenceScope: { reachable: async ({ ref }) => ref.id !== 'acme.elsewhere' },
  };

  /**
   * One app with no tool registry, so its agents and flows register
   * unpinned; its deployment record throws for the first `failures`
   * deploys.
   */
  function setup(
    opts: {
      failures?: number;
      agents?: (registry: AgentRegistryBinding) => AgentRegistryBinding;
      flows?: (registry: FlowRegistryBinding) => FlowRegistryBinding;
      extra?: Partial<Parameters<typeof createApp>[0]>;
    } = {},
  ) {
    const deploymentRegistry = makeFailingDeploymentBinding(opts.failures ?? 0);
    const agents = makeRetiringVersions();
    const flows = makeRetiringVersions();
    const agentRegistry = makeRetiringAgentRegistry(agents);
    const flowRegistry = makeRetiringFlowRegistry(flows);
    const { app } = makeApp({
      fixture: pack,
      deploymentRegistry,
      omit: 'tools',
      agentRegistry: opts.agents?.(agentRegistry) ?? agentRegistry,
      flowRegistry: opts.flows?.(flowRegistry) ?? flowRegistry,
      ...(opts.extra !== undefined && { extra: opts.extra }),
    });
    const deploy = async () => {
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(pack.wire),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { agents, flows, deploy };
  }

  test('a deploy that failed after its agent and flow publish unregistered them; the same image deploys again, each reinstated', async () => {
    const { agents, flows, deploy } = setup({ failures: 1 });

    expect((await deploy()).status).toBe(500);
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 unregistered']);
    expect(flows.states()).toEqual(['acme.review@1.0.0 unregistered']);

    expect((await deploy()).status).toBe(201);
    expect(agents.reinstated).toEqual(['acme.matcher@1.0.0']);
    expect(flows.reinstated).toEqual(['acme.review@1.0.0']);
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 active']);
    expect(flows.states()).toEqual(['acme.review@1.0.0 active']);

    // Deployed again, both are active: nothing to reinstate.
    expect((await deploy()).status).toBe(200);
    expect(agents.reinstated).toEqual(['acme.matcher@1.0.0']);
    expect(flows.reinstated).toEqual(['acme.review@1.0.0']);
  });

  test('a redeploy that fails again unregisters the agent and flow versions it reinstated', async () => {
    const { agents, flows, deploy } = setup({ failures: 2 });

    expect((await deploy()).status).toBe(500);
    expect((await deploy()).status).toBe(500);
    expect(agents.reinstated).toEqual(['acme.matcher@1.0.0']);
    expect(flows.reinstated).toEqual(['acme.review@1.0.0']);
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 unregistered']);
    expect(flows.states()).toEqual(['acme.review@1.0.0 unregistered']);

    expect((await deploy()).status).toBe(201);
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 active']);
    expect(flows.states()).toEqual(['acme.review@1.0.0 active']);
  });

  test("an agent version reinstated since its registry read it isn't this deploy's to unregister rolling back", async () => {
    const { agents, deploy } = setup({
      failures: 1,
      agents: (registry) => ({
        ...registry,
        // Another caller reinstates it first: this deploy's reinstate finds it active.
        reinstateVersion: async (input) => {
          await registry.reinstateVersion(input);
          return registry.reinstateVersion(input);
        },
      }),
    });
    agents.seedRetired(matcher);

    expect((await deploy()).status).toBe(500);
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 active']);
  });

  test('an agent reinstate its registry answers not-found is a 500, and no flow is written', async () => {
    const { agents, flows, deploy } = setup({
      agents: (registry) => ({
        ...registry,
        reinstateVersion: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
      }),
    });
    agents.seedRetired(matcher);

    const res = await deploy();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal-server-error');
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 unregistered']);
    expect(flows.states()).toEqual([]);
  });

  test("an unregistered agent version naming what its project doesn't reach stays unregistered: the deploy is refused, as the same name in the pack's agent is", async () => {
    const { agents, flows, deploy } = setup({ extra: scope });
    // The stored version names a tool its project doesn't reach; the pack's agent, at the same version, doesn't.
    agents.seedRetired({ ...matcher, tools: [{ id: 'acme.elsewhere', version: '^1.0.0' }] });

    const res = await deploy();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('reference-out-of-scope');
    expect(res.body.error.message).toBe(
      `This project can't reference tool "acme.elsewhere": it isn't registered in this project, its org or the tenant`,
    );
    expect(res.body.error.details.issues).toEqual([
      {
        path: '/agents/0',
        kind: 'tool',
        id: 'acme.elsewhere',
        message: `version 1.0.0 of this agent is unregistered and can't be reinstated: tool "acme.elsewhere" isn't registered in this project, its org or the tenant. Publish the agent under a new version`,
      },
    ]);
    expect(agents.reinstated).toEqual([]);
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 unregistered']);
    expect(flows.states()).toEqual([]);
  });

  test("an unregistered flow version naming what its project doesn't reach stays unregistered, and the deploy is refused", async () => {
    const { agents, flows, deploy } = setup({ extra: scope });
    flows.seedRetired({
      ...review,
      nodes: [
        { id: 'score', kind: 'tool', ref: 'acme.elsewhere' },
        { id: 'match', kind: 'agent', ref: 'acme.matcher' },
      ],
    });

    const res = await deploy();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('reference-out-of-scope');
    expect(res.body.error.details.issues).toEqual([
      {
        path: '/flows/0',
        kind: 'tool',
        id: 'acme.elsewhere',
        message: `version 1.0.0 of this flow is unregistered and can't be reinstated: tool "acme.elsewhere" isn't registered in this project, its org or the tenant. Publish the flow under a new version`,
      },
    ]);
    expect(flows.reinstated).toEqual([]);
    expect(flows.states()).toEqual(['acme.review@1.0.0 unregistered']);
    // The agent this deploy published is rolled back with it.
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 unregistered']);
  });

  test("each undo the rollback can't do is warned, by name, last write first, and none stops the rest", async () => {
    const logger = recordingLogger();
    const fails =
      <R extends AgentRegistryBinding | FlowRegistryBinding>(what: string) =>
      (registry: R): R => ({
        ...registry,
        unregister: async () => {
          throw new Error(`the ${what} store is down`);
        },
      });
    const { agents, flows, deploy } = setup({
      failures: 1,
      agents: fails('agent'),
      flows: fails('flow'),
      extra: { logger },
    });

    expect((await deploy()).status).toBe(500);
    expect(rollbackWarns(logger)).toEqual([
      {
        message: `deploy rollback: couldn't unregister flow "acme.review@1.0.0", so it stays as this deploy left it`,
        fields: {
          primitive: 'flow',
          id: 'acme.review@1.0.0',
          err: new Error('the flow store is down'),
        },
      },
      {
        message: `deploy rollback: couldn't unregister agent "acme.matcher@1.0.0", so it stays as this deploy left it`,
        fields: {
          primitive: 'agent',
          id: 'acme.matcher@1.0.0',
          err: new Error('the agent store is down'),
        },
      },
    ]);
    expect(agents.states()).toEqual(['acme.matcher@1.0.0 active']);
    expect(flows.states()).toEqual(['acme.review@1.0.0 active']);
  });
});

// ---------------- a guardrail id that's already live ----------------

/** The fixture's index, its guardrail changed by `guardrail`, for `artifactVersion`. */
function indexWith(
  artifactVersion: string,
  guardrail: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    packId: 'acme.aperture',
    packVersion: '1.0.0',
    artifactVersion,
    publishedAt: '2026-09-20T14:32:07.104Z',
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
        ...guardrail,
      },
    ],
    agents: [],
    flows: [],
  };
}

const SECOND_KEY_ID = 'aperture-staging-2026-02' as SigningKeyId;

/** An app that trusts two images of the pack: the first (`opts.first`, else the fixture's), and a later one (`second`). */
function twoImages(
  second: SignedDeploy,
  opts: {
    refreshes?: boolean;
    first?: SignedDeploy;
    toolRegistry?: ToolRegistryBinding;
    logger?: Logger;
  } = {},
) {
  const first =
    opts.first ??
    buildSignedDeploy({
      artifactVersion: '20260920.1',
      index: indexWith('20260920.1'),
    });
  const made = makeApp({
    fixture: first,
    ...(opts.refreshes === true && { refreshes: true }),
    ...(opts.toolRegistry !== undefined && { toolRegistry: opts.toolRegistry }),
    ...(opts.logger !== undefined && { extra: { logger: opts.logger } }),
    extraTrust: [
      {
        keyId: SECOND_KEY_ID,
        tenantId,
        publicKey: Buffer.from(second.publicKeyRaw).toString('base64'),
      },
    ],
    extraImages: [
      { imageRef: second.imageRef, digest: second.digest, indexBytes: second.indexBytes },
    ],
  });
  const deploy = async (fixture: SignedDeploy) => {
    const res = await made.app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    return { status: res.status, text: await res.text() };
  };
  return { ...made, first, deploy };
}

const laterImage = (guardrail: Record<string, unknown> = {}) =>
  buildSignedDeploy({
    artifactVersion: '20260921.1',
    keyId: SECOND_KEY_ID,
    index: indexWith('20260921.1', guardrail),
  });

describe("POST /v1/deployments — a guardrail id that's already live", () => {
  test('in another project: 409 guardrail-project-mismatch, its project unnamed, and nothing deployed', async () => {
    const elsewhere = randomUUID() as ProjectId;
    const { guardrailRegistry, toolRegistry, deploymentRegistry, deploy, first } = twoImages(
      laterImage(),
    );
    await guardrailRegistry.register({
      tenantId,
      projectId: elsewhere,
      guardrail: {
        id: 'acme.no-fabricated-quotes',
        kind: 'zero-llm',
        check: 'must-cite',
        action: { 'on-violation': 'halt' },
      } as never,
      enqueueTuples: () => [],
    });

    const answer = await deploy(first);
    expect(answer.status).toBe(409);
    const body = JSON.parse(answer.text) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('guardrail-project-mismatch');
    expect(body.error.message).toBe(
      // One pack service and no environment orders: no fix to name.
      "The guardrail acme.no-fabricated-quotes wasn't published: it belongs to another project; nothing was deployed",
    );
    expect(body.error.details).toEqual({ primitive: 'guardrail', id: 'acme.no-fabricated-quotes' });
    // The project it belongs to stays off the wire.
    expect(answer.text).not.toContain(elsewhere);
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
    // The tool this deploy had registered is rolled back.
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
    ).toBeNull();
  });

  test('in this project, the same definition in a new image: kept, the deploy goes through', async () => {
    const second = laterImage();
    const { guardrailRegistry, toolRegistry, deploy, first } = twoImages(second);
    expect((await deploy(first)).status).toBe(201);
    expect((await deploy(second)).status).toBe(201);
    // Kept as it was: a registry without the refresh methods keeps the
    // first image's pointer, for the guardrail and the tool alike.
    const kept = (await guardrailRegistry.get({
      tenantId,
      guardrailId: 'acme.no-fabricated-quotes' as never,
    })) as unknown as { codeArtifactRef: { artifactVersion: string; imageRef: string } };
    expect(kept.codeArtifactRef.artifactVersion).toBe('20260920.1');
    expect(kept.codeArtifactRef.imageRef).toBe(first.imageRef);
    const tool = (await toolRegistry.get({
      tenantId,
      toolId: 'acme.verify-citation' as never,
    })) as unknown as { codeArtifactRef: { artifactVersion: string; imageRef: string } };
    expect(tool.codeArtifactRef).toMatchObject({
      artifactVersion: '20260920.1',
      imageRef: first.imageRef,
    });
  });

  test('in this project with another definition: 409 guardrail-already-registered, nothing deployed', async () => {
    const second = laterImage({ action: { 'on-violation': 'flag' } });
    const { guardrailRegistry, deploymentRegistry, deploy, first } = twoImages(second);
    expect((await deploy(first)).status).toBe(201);

    const answer = await deploy(second);
    expect(answer.status).toBe(409);
    const body = JSON.parse(answer.text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('guardrail-already-registered');
    expect(body.error.message).toBe(
      "The guardrail acme.no-fabricated-quotes wasn't published: it is already registered with a different definition; unregister it (`kindgi guardrails unregister acme.no-fabricated-quotes`) and deploy again; nothing was deployed",
    );
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toHaveLength(1);
    const kept = (await guardrailRegistry.get({
      tenantId,
      guardrailId: 'acme.no-fabricated-quotes' as never,
    })) as unknown as { action: unknown };
    expect(kept.action).toEqual({ 'on-violation': 'halt' });
  });

  test.each([
    [
      'stored by a 0.1.4 deploy (no configSchema), the pack now carrying one',
      {},
      { configSchema: { type: 'object', properties: { min: { type: 'integer' } } } },
    ],
    ['stored with a field a later release added', { checkBuiltIn: false }, {}],
  ])('in this project, %s: kept, the deploy goes through', async (_why, stored, indexed) => {
    const fixture = buildSignedDeploy({ index: indexWith('20260920.1', indexed) });
    const { app, guardrailRegistry } = makeApp({ fixture });
    await guardrailRegistry.register({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      guardrail: {
        id: 'acme.no-fabricated-quotes',
        kind: 'zero-llm',
        check: 'must-cite',
        action: { 'on-violation': 'halt' },
        codeArtifactRef: {
          kind: 'oci',
          imageRef: 'ghcr.io/acme/aperture@sha256:0123',
          modulePath: './guardrails/must-cite.js',
          artifactVersion: '20260901.1',
        },
        ...stored,
      } as never,
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status, await res.text()).toBe(201);
  });

  test('unregistered between the registry answering and the deploy looking: registered again', async () => {
    const fixture = buildSignedDeploy({ index: indexWith('20260920.1') });
    const { app, guardrailRegistry } = makeApp({ fixture });
    // The registry answers `already-registered` once, for a row that's then gone.
    const register = guardrailRegistry.register.bind(guardrailRegistry);
    let answered = false;
    (guardrailRegistry as { register: GuardrailRegistryBinding['register'] }).register = async (
      input,
    ) => {
      if (!answered) {
        answered = true;
        return { kind: 'already-registered', guardrailId: input.guardrail.id };
      }
      return register(input);
    };
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(201);
    expect(
      await guardrailRegistry.get({ tenantId, guardrailId: 'acme.no-fabricated-quotes' as never }),
    ).not.toBeNull();
  });

  test("registered again, then a guardrail the rollback can't unregister is warned, by name", async () => {
    const fixture = buildSignedDeploy({ index: indexWith('20260920.1') });
    const logger = recordingLogger();
    const { app, guardrailRegistry } = makeApp({
      fixture,
      deploymentRegistry: makeFailingDeploymentBinding(1),
      extra: { logger },
    });
    const register = guardrailRegistry.register.bind(guardrailRegistry);
    let answered = false;
    (guardrailRegistry as { register: GuardrailRegistryBinding['register'] }).register = async (
      input,
    ) => {
      if (!answered) {
        answered = true;
        return { kind: 'already-registered', guardrailId: input.guardrail.id };
      }
      return register(input);
    };
    const down = new Error('the guardrail store is down');
    (guardrailRegistry as { unregister: GuardrailRegistryBinding['unregister'] }).unregister =
      async () => {
        throw down;
      };
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    expect(rollbackWarns(logger)).toEqual([
      {
        message: `deploy rollback: couldn't unregister guardrail "acme.no-fabricated-quotes", so it stays as this deploy left it`,
        fields: { primitive: 'guardrail', id: 'acme.no-fabricated-quotes', err: down },
      },
    ]);
  });
});

describe("POST /v1/deployments — a tool version that's already published", () => {
  const TOOL_ID = 'acme.verify-citation';
  /** The fixture's index for `artifactVersion`, its tool changed by `tool`. */
  const indexWithTool = (artifactVersion: string, tool: Record<string, unknown>) => {
    const index = indexWith(artifactVersion) as { tools: Record<string, unknown>[] };
    return { ...index, tools: index.tools.map((t) => ({ ...t, ...tool })) };
  };
  const firstImage = (tool: Record<string, unknown> = {}) =>
    buildSignedDeploy({ artifactVersion: '20260920.1', index: indexWithTool('20260920.1', tool) });
  const laterToolImage = (tool: Record<string, unknown>) =>
    buildSignedDeploy({
      artifactVersion: '20260921.1',
      keyId: SECOND_KEY_ID,
      index: indexWithTool('20260921.1', tool),
    });
  const PERSON = { mail: { app: 'google', permissions: ['gmail.send'], as: 'person' } };
  const COMPANY = { mail: { app: 'google', permissions: ['gmail.send'], as: 'company' } };
  const errorOf = (text: string) =>
    (JSON.parse(text) as { error: { code: string; message: string; details?: unknown } }).error;
  /** Counts the registry's publishes and code-pointer refreshes from now on. */
  const countWrites = (registry: ToolRegistryBinding) => {
    const counts = { publish: 0, refresh: 0 };
    const publish = registry.publish.bind(registry);
    const refresh = registry.refreshCodeArtifactRef?.bind(registry);
    const writable = registry as {
      publish: ToolRegistryBinding['publish'];
      refreshCodeArtifactRef?: ToolRegistryBinding['refreshCodeArtifactRef'];
    };
    writable.publish = async (input) => {
      counts.publish += 1;
      return publish(input);
    };
    if (refresh !== undefined) {
      writable.refreshCodeArtifactRef = async (input) => {
        counts.refresh += 1;
        return refresh(input);
      };
    }
    return counts;
  };

  test.each([
    [
      'its input',
      {},
      {
        input: {
          type: 'object',
          properties: { citation: { type: 'string' }, court: { type: 'string' } },
        },
      },
      ['input'],
    ],
    [
      "whose account a connection it needs is (a mail's `as`)",
      { needsSpec: { connections: PERSON } },
      { needsSpec: { connections: COMPANY } },
      ['needsSpec'],
    ],
    ['whether it changes anything', {}, { mutating: false }, ['mutating']],
    ['its metadata', {}, { metadata: { team: 'legal' } }, ['metadata']],
    [
      'where its code lives in the pack',
      {},
      { modulePath: './tools/legal/verify.js' },
      ['modulePath'],
    ],
    [
      'its input and whether it changes anything',
      {},
      { mutating: true, input: { type: 'object' } },
      ['input', 'mutating'],
    ],
  ])(
    'the same version with another %s: 409 tool-already-registered naming the fields, nothing written',
    async (_why, was, now, fields) => {
      const second = laterToolImage({ ...was, ...now });
      const made = twoImages(second, { refreshes: true, first: firstImage(was) });
      expect((await made.deploy(made.first)).status).toBe(201);
      const stored = await made.toolRegistry.get({ tenantId, toolId: TOOL_ID as never });
      const writes = countWrites(made.toolRegistry);

      const answer = await made.deploy(second);
      expect(answer.status, answer.text).toBe(409);
      const error = errorOf(answer.text);
      expect(error.code).toBe('tool-already-registered');
      expect(error.message).toBe(
        `The tool ${TOOL_ID}@1.0.0 wasn't published: version 1.0.0 is already published with another definition (it differs in ${fields.join(', ')}); a version never changes, so give the pack's tool a new version; nothing was deployed`,
      );
      expect(error.details).toEqual({ primitive: 'tool', id: `${TOOL_ID}@1.0.0`, fields });
      // Refused before the first write: no publish (so no secret scopes
      // recorded), no pointer moved, no deployment recorded.
      expect(writes).toEqual({ publish: 0, refresh: 0 });
      expect(await made.toolRegistry.get({ tenantId, toolId: TOOL_ID as never })).toEqual(stored);
      expect((await made.deploymentRegistry.list({ tenantId, limit: 10 })).data).toHaveLength(1);
    },
  );

  test('stored with what a deploy derives (another image, its project, its secret scopes): kept, the deploy goes through', async () => {
    const fixture = firstImage();
    const { app, toolRegistry } = makeApp({ fixture, refreshes: true });
    const published = await toolRegistry.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      tool: {
        id: TOOL_ID,
        description: 'Verify a legal citation.',
        version: '1.0.0',
        output: { properties: { verified: { type: 'boolean' } }, type: 'object' },
        input: { type: 'object', properties: { citation: { type: 'string' } } },
        codeArtifactRef: {
          kind: 'oci',
          imageRef: 'ghcr.io/acme/aperture@sha256:0123',
          modulePath: './tools/legal/verify-citation.js',
          artifactVersion: '20260901.1',
        },
        projectId: DEFAULT_PROJECT_ID,
        madeInProjectId: DEFAULT_PROJECT_ID,
        secretScopes: {},
      } as never,
      enqueueTuples: () => [],
    });
    expect(published.kind).toBe('ok');
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status, await res.text()).toBe(201);
    const kept = (await toolRegistry.get({ tenantId, toolId: TOOL_ID as never })) as unknown as {
      codeArtifactRef: { artifactVersion: string };
    };
    expect(kept.codeArtifactRef.artifactVersion).toBe('20260920.1');
  });

  /**
   * A registry that lists the tool's versions as unregistered
   * (`unregisteredAt`) until each is reinstated. Answers the versions it
   * reinstated, as `id@version`.
   */
  const listedUnregistered = (registry: ToolRegistryBinding): string[] => {
    const reinstated: string[] = [];
    const overlay = registry as {
      listVersions: ToolRegistryBinding['listVersions'];
      reinstateVersion: ToolRegistryBinding['reinstateVersion'];
    };
    const listVersions = registry.listVersions.bind(registry);
    overlay.listVersions = async (input) => {
      const page = await listVersions(input);
      return {
        ...page,
        data: page.data.map((row) =>
          reinstated.includes(`${input.toolId}@${row.version}`)
            ? row
            : { ...row, unregisteredAt: '2026-09-20T15:00:00.000Z' },
        ),
      };
    };
    overlay.reinstateVersion = async ({ toolId, version }) => {
      reinstated.push(`${toolId}@${version}`);
      return { kind: 'ok', toolId, version, wasTombstoned: true };
    };
    return reinstated;
  };

  test('unregistered, the same definition: kept and reinstated, the deploy goes through', async () => {
    const second = laterImage();
    const made = twoImages(second);
    expect((await made.deploy(made.first)).status).toBe(201);
    const reinstated = listedUnregistered(made.toolRegistry);
    expect((await made.deploy(second)).status).toBe(201);
    expect(reinstated).toEqual([`${TOOL_ID}@1.0.0`]);
  });

  test('unregistered, another definition: 409 tool-already-registered, saying it is unregistered', async () => {
    const second = laterToolImage({ mutating: false });
    const made = twoImages(second);
    expect((await made.deploy(made.first)).status).toBe(201);
    listedUnregistered(made.toolRegistry);
    const answer = await made.deploy(second);
    expect(answer.status).toBe(409);
    const error = errorOf(answer.text);
    expect(error.code).toBe('tool-already-registered');
    expect(error.message).toBe(
      `The tool ${TOOL_ID}@1.0.0 wasn't published: version 1.0.0 is already published (now unregistered) with another definition (it differs in mutating); a version never changes, so give the pack's tool a new version; nothing was deployed`,
    );
  });

  test('published with another definition after the deploy checked: 409, and what it wrote before is rolled back', async () => {
    const tool = (id: string, input: Record<string, unknown>) => ({
      id,
      description: 'x',
      version: '1.0.0',
      input,
      output: { type: 'object' },
      modulePath: `./tools/${id}.js`,
    });
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [tool('acme.search', { type: 'object' }), tool(TOOL_ID, { type: 'object' })],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const tools = makeInMemoryToolRegistry();
    // Another deploy publishes the tool's version, with another input,
    // between this deploy's check and its write.
    let checked = false;
    const toolRegistry: ToolRegistryBinding = {
      ...tools,
      getVersion: async (input) => {
        if ((input.toolId as unknown as string) === TOOL_ID && !checked) {
          checked = true;
          return null;
        }
        return tools.getVersion(input);
      },
      publish: async (input) => {
        if ((input.tool.id as unknown as string) === TOOL_ID) {
          await tools.publish({
            ...input,
            tool: {
              ...input.tool,
              input: { type: 'object', properties: { q: { type: 'string' } } },
            },
          });
        }
        return tools.publish(input);
      },
    };
    const { app, deploymentRegistry } = makeApp({ fixture, toolRegistry });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(409);
    const error = errorOf(await res.text());
    expect(error.code).toBe('tool-already-registered');
    expect(error.details).toEqual({ primitive: 'tool', id: `${TOOL_ID}@1.0.0`, fields: ['input'] });
    // The tool it published first is rolled back.
    expect(await tools.get({ tenantId, toolId: 'acme.search' as never })).toBeNull();
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test("published after the deploy checked, but its version can't be read at the write: 500, nothing kept, what it wrote before rolled back", async () => {
    const tool = (id: string) => ({
      id,
      description: 'x',
      version: '1.0.0',
      input: { type: 'object' },
      output: { type: 'object' },
      modulePath: `./tools/${id}.js`,
    });
    const fixture = buildSignedDeploy({
      index: {
        v: 1,
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [tool('acme.search'), tool(TOOL_ID)],
        guardrails: [],
        agents: [],
        flows: [],
      },
    });
    const tools = makeInMemoryToolRegistry();
    let reads = 0;
    const refreshes: unknown[] = [];
    const toolRegistry: ToolRegistryBinding = {
      ...tools,
      // The check's read and the write's fail; a later one would find it.
      getVersion: async (input) => {
        if ((input.toolId as unknown as string) === TOOL_ID && ++reads <= 2) return null;
        return tools.getVersion(input);
      },
      // Another deploy publishes the version, from another image, between
      // this deploy's check and its write.
      publish: async (input) => {
        if ((input.tool.id as unknown as string) === TOOL_ID) {
          await tools.publish({
            ...input,
            tool: {
              ...input.tool,
              codeArtifactRef: {
                ...input.tool.codeArtifactRef,
                imageRef: `ghcr.io/acme/elsewhere@sha256:${'b'.repeat(64)}`,
              } as never,
            },
          });
        }
        return tools.publish(input);
      },
      async refreshCodeArtifactRef(input) {
        refreshes.push(input);
        return { refreshed: false };
      },
    };
    const { app, deploymentRegistry } = makeApp({ fixture, toolRegistry });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    expect(res.status).toBe(500);
    expect(errorOf(await res.text()).code).toBe('internal-server-error');
    // It stops at the read that failed: the version isn't pointed at this image uncompared.
    expect(reads).toBe(2);
    expect(refreshes).toEqual([]);
    // The tool it published first is rolled back.
    expect(await tools.get({ tenantId, toolId: 'acme.search' as never })).toBeNull();
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  describe('held where its publish decides', () => {
    const elsewhere = randomUUID() as ProjectId;
    /** The registry holds the tool's version as `stored`, and its publish answers `publish`. */
    const holding = (
      stored: Record<string, unknown>,
      publish: Awaited<ReturnType<ToolRegistryBinding['publish']>>,
    ): ToolRegistryBinding => {
      const tools = makeInMemoryToolRegistry();
      return {
        ...tools,
        getVersion: async (input) =>
          (input.toolId as unknown as string) === TOOL_ID
            ? (stored as never)
            : tools.getVersion(input),
        publish: async (input) =>
          (input.tool.id as unknown as string) === TOOL_ID ? publish : tools.publish(input),
      };
    };
    const changed = {
      id: TOOL_ID,
      description: 'Verify a legal citation.',
      version: '1.0.0',
      input: { type: 'object' },
      output: { type: 'object' },
    };
    const deployWith = async (toolRegistry: ToolRegistryBinding) => {
      const fixture = firstImage();
      const { app } = makeApp({ fixture, toolRegistry });
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(fixture.wire),
      });
      return { status: res.status, text: await res.text() };
    };

    test("another project's, with another definition: 409 tool-project-mismatch as before, its project unnamed", async () => {
      const answer = await deployWith(
        holding({ ...changed, projectId: elsewhere }, {
          kind: 'project-mismatch',
          projectId: elsewhere,
        } as never),
      );
      expect(answer.status).toBe(409);
      expect(errorOf(answer.text).code).toBe('tool-project-mismatch');
      expect(answer.text).not.toContain(elsewhere);
    });

    test('in another project of its environment order, with another definition: 409 tool-already-registered at the write', async () => {
      const answer = await deployWith(
        holding(
          { ...changed, projectId: elsewhere },
          { kind: 'already-registered', toolId: TOOL_ID as never, version: '1.0.0' as never },
        ),
      );
      expect(answer.status).toBe(409);
      const error = errorOf(answer.text);
      expect(error.code).toBe('tool-already-registered');
      expect(error.details).toEqual({
        primitive: 'tool',
        id: `${TOOL_ID}@1.0.0`,
        fields: ['input', 'output', 'modulePath'],
      });
    });

    test("an MCP endpoint's tool: 409 tool-kind-mismatch as before", async () => {
      const answer = await deployWith(
        holding(
          { ...changed, transport: 'mcp', projectId: DEFAULT_PROJECT_ID },
          {
            kind: 'kind-mismatch',
            toolId: TOOL_ID as never,
            version: '1.0.0' as never,
            endpointId: 'acme',
          },
        ),
      );
      expect(answer.status).toBe(409);
      expect(errorOf(answer.text).code).toBe('tool-kind-mismatch');
    });
  });
});

describe('sameGuardrailDefinition', () => {
  const base = {
    id: 'acme.no-fabricated-quotes',
    kind: 'zero-llm',
    check: 'must-cite',
    action: { 'on-violation': 'halt' },
    codeArtifactRef: {
      kind: 'oci',
      imageRef: 'ghcr.io/acme/aperture@sha256:aaa',
      modulePath: './guardrails/must-cite.js',
      artifactVersion: '20260920.1',
    },
  } as unknown as Guardrail;
  const g = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as unknown as Guardrail;

  test.each([
    ['keys in another order', g({ action: { 'on-violation': 'halt' }, id: base.id })],
    ['an undefined field', g({ description: undefined })],
    ['a configSchema only one has', g({ configSchema: { type: 'object' } })],
    ['a field a later release adds', g({ checkBuiltIn: true })],
    [
      'another image and artifact version',
      g({
        codeArtifactRef: {
          kind: 'oci',
          artifactVersion: '20260921.1',
          modulePath: './guardrails/must-cite.js',
          imageRef: 'ghcr.io/acme/aperture@sha256:bbb',
        },
      }),
    ],
  ])('the same, with %s', (_why, other) => {
    expect(sameGuardrailDefinition(base, other)).toBe(true);
  });

  test.each([
    ['another action', g({ action: { 'on-violation': 'flag' } })],
    ['another check', g({ check: 'never-call-tool' })],
    ['another description', g({ description: 'Quotes must be cited.' })],
    ['a config', g({ config: { min: 1 } })],
    [
      'another module path',
      g({ codeArtifactRef: { ...(base.codeArtifactRef as object), modulePath: './other.js' } }),
    ],
    ['no code pointer', g({ codeArtifactRef: undefined })],
  ])('different, with %s', (_why, other) => {
    expect(sameGuardrailDefinition(base, other)).toBe(false);
  });
});

describe('POST /v1/deployments — a redeploy refreshes what it derived', () => {
  const SCHEMA = { type: 'object', properties: { min: { type: 'integer' } } };
  const pointerOf = async (made: ReturnType<typeof twoImages>) => {
    const guardrail = (await made.guardrailRegistry.get({
      tenantId,
      guardrailId: 'acme.no-fabricated-quotes' as never,
    })) as unknown as { codeArtifactRef: { artifactVersion: string }; configSchema?: unknown };
    const tool = (await made.toolRegistry.get({
      tenantId,
      toolId: 'acme.verify-citation' as never,
    })) as unknown as { codeArtifactRef: { artifactVersion: string } };
    return {
      guardrail: guardrail.codeArtifactRef.artifactVersion,
      schema: guardrail.configSchema,
      tool: tool.codeArtifactRef.artifactVersion,
    };
  };

  test("a kept tool version and guardrail get the new image's pointer, the guardrail its config schema", async () => {
    const second = laterImage({ configSchema: SCHEMA });
    const made = twoImages(second, { refreshes: true });
    expect((await made.deploy(made.first)).status).toBe(201);
    expect(await pointerOf(made)).toEqual({
      guardrail: '20260920.1',
      schema: undefined,
      tool: '20260920.1',
    });
    expect((await made.deploy(second)).status).toBe(201);
    expect(await pointerOf(made)).toEqual({
      guardrail: '20260921.1',
      schema: SCHEMA,
      tool: '20260921.1',
    });
  });

  test('a deploy refused after refreshing puts the old pointer and schema back', async () => {
    // The later image also brings a guardrail whose id lives in another project.
    const index = indexWith('20260921.1', { configSchema: SCHEMA }) as { guardrails: unknown[] };
    index.guardrails.push({
      id: 'acme.elsewhere',
      kind: 'zero-llm',
      check: 'must-cite',
      action: { 'on-violation': 'halt' },
    });
    const second = buildSignedDeploy({
      artifactVersion: '20260921.1',
      keyId: SECOND_KEY_ID,
      index: index as Record<string, unknown>,
    });
    const made = twoImages(second, { refreshes: true });
    expect((await made.deploy(made.first)).status).toBe(201);
    await made.guardrailRegistry.register({
      tenantId,
      projectId: randomUUID() as ProjectId,
      guardrail: {
        id: 'acme.elsewhere',
        kind: 'zero-llm',
        check: 'must-cite',
        action: { 'on-violation': 'halt' },
      } as never,
      enqueueTuples: () => [],
    });

    expect((await made.deploy(second)).status).toBe(409);
    expect(await pointerOf(made)).toEqual({
      guardrail: '20260920.1',
      schema: undefined,
      tool: '20260920.1',
    });
  });

  test("an old pointer or schema the rollback can't put back is warned, by name, last write first", async () => {
    // As above, but each put-back (the call that names `expected`) fails.
    const index = indexWith('20260921.1', { configSchema: SCHEMA }) as { guardrails: unknown[] };
    index.guardrails.push({
      id: 'acme.elsewhere',
      kind: 'zero-llm',
      check: 'must-cite',
      action: { 'on-violation': 'halt' },
    });
    const second = buildSignedDeploy({
      artifactVersion: '20260921.1',
      keyId: SECOND_KEY_ID,
      index: index as Record<string, unknown>,
    });
    const logger = recordingLogger();
    const made = twoImages(second, { refreshes: true, logger });
    expect((await made.deploy(made.first)).status).toBe(201);
    await made.guardrailRegistry.register({
      tenantId,
      projectId: randomUUID() as ProjectId,
      guardrail: {
        id: 'acme.elsewhere',
        kind: 'zero-llm',
        check: 'must-cite',
        action: { 'on-violation': 'halt' },
      } as never,
      enqueueTuples: () => [],
    });
    const refreshCode = made.toolRegistry.refreshCodeArtifactRef?.bind(made.toolRegistry);
    const refreshFields = made.guardrailRegistry.refreshDeployedFields?.bind(
      made.guardrailRegistry,
    );
    if (refreshCode === undefined || refreshFields === undefined) {
      throw new Error('the registries take a refresh');
    }
    const down = new Error('the registry is down');
    (made.toolRegistry as { refreshCodeArtifactRef: typeof refreshCode }).refreshCodeArtifactRef =
      async (input) => {
        if (input.expected !== undefined) throw down;
        return refreshCode(input);
      };
    (
      made.guardrailRegistry as { refreshDeployedFields: typeof refreshFields }
    ).refreshDeployedFields = async (input) => {
      if (input.expected !== undefined) throw down;
      return refreshFields(input);
    };

    expect((await made.deploy(second)).status).toBe(409);
    expect(rollbackWarns(logger)).toEqual([
      {
        message: `deploy rollback: couldn't put back the code pointer and config schema of guardrail "acme.no-fabricated-quotes", so it stays as this deploy left it`,
        fields: { primitive: 'guardrail', id: 'acme.no-fabricated-quotes', err: down },
      },
      {
        message: `deploy rollback: couldn't put back the code pointer of tool "acme.verify-citation@1.0.0", so it stays as this deploy left it`,
        fields: { primitive: 'tool', id: 'acme.verify-citation@1.0.0', err: down },
      },
    ]);
    expect(await pointerOf(made)).toEqual({
      guardrail: '20260921.1',
      schema: SCHEMA,
      tool: '20260921.1',
    });
  });

  test("a rollback leaves another deploy's later refresh in place (compare-and-set)", async () => {
    // This deploy refreshes, then is refused by a later guardrail; between
    // the two, another deploy of the tenant refreshes the same rows.
    const index = indexWith('20260921.1', { configSchema: SCHEMA }) as { guardrails: unknown[] };
    index.guardrails.push({
      id: 'acme.elsewhere',
      kind: 'zero-llm',
      check: 'must-cite',
      action: { 'on-violation': 'halt' },
    });
    const second = buildSignedDeploy({
      artifactVersion: '20260921.1',
      keyId: SECOND_KEY_ID,
      index: index as Record<string, unknown>,
    });
    const made = twoImages(second, { refreshes: true });
    expect((await made.deploy(made.first)).status).toBe(201);
    await made.guardrailRegistry.register({
      tenantId,
      projectId: randomUUID() as ProjectId,
      guardrail: {
        id: 'acme.elsewhere',
        kind: 'zero-llm',
        check: 'must-cite',
        action: { 'on-violation': 'halt' },
      } as never,
      enqueueTuples: () => [],
    });
    const third = (modulePath: string) => ({
      kind: 'oci' as const,
      imageRef: 'ghcr.io/acme/aperture@sha256:third',
      modulePath,
      artifactVersion: '20260922.1',
    });
    const THIRD_SCHEMA = { type: 'object', properties: { max: { type: 'integer' } } };
    const get = made.guardrailRegistry.get.bind(made.guardrailRegistry);
    let raced = false;
    (made.guardrailRegistry as { get: GuardrailRegistryBinding['get'] }).get = async (input) => {
      if (input.guardrailId === ('acme.elsewhere' as never) && !raced) {
        raced = true;
        await made.toolRegistry.refreshCodeArtifactRef?.({
          tenantId,
          toolId: 'acme.verify-citation' as never,
          version: '1.0.0' as never,
          codeArtifactRef: third('./tools/legal/verify-citation.js'),
        });
        await made.guardrailRegistry.refreshDeployedFields?.({
          tenantId,
          guardrailId: 'acme.no-fabricated-quotes' as never,
          codeArtifactRef: third('./guardrails/must-cite.js'),
          configSchema: THIRD_SCHEMA,
        });
      }
      return get(input);
    };

    expect((await made.deploy(second)).status).toBe(409);
    expect(raced).toBe(true);
    // The other deploy's refresh stands: this one's rollback didn't undo it.
    expect(await pointerOf(made)).toEqual({
      guardrail: '20260922.1',
      schema: THIRD_SCHEMA,
      tool: '20260922.1',
    });
  });
});

describe("POST /v1/deployments — the tenant's own image repository", () => {
  /** The fake registry, counting every call: a refused image is never read. */
  function counted(fixture: SignedDeploy) {
    const inner = makeMockImageRegistry([
      { imageRef: fixture.imageRef, digest: fixture.digest, indexBytes: fixture.indexBytes },
    ]);
    const calls: string[] = [];
    const registry = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { registry, calls };
  }

  async function deploy(
    prefix: string | undefined,
    tenancy: 'multi' | 'single' = 'multi',
  ): Promise<{ status: number; code?: string; details?: Record<string, unknown>; reads: number }> {
    const fixture = buildSignedDeploy();
    const { registry, calls } = counted(fixture);
    const { app } = makeApp({
      fixture,
      imageRegistry: registry,
      extra: {
        imagePrefixes: { of: async () => prefix },
        ...(tenancy === 'multi' && {
          tenancy,
          tenantStates: { of: async () => undefined },
          systemAccessAudit: {
            record: async () => undefined,
            begin: async () => 'a',
            finish: async () => undefined,
          },
        }),
      },
    });
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(fixture.wire),
    });
    const body = (await res.json()) as {
      error?: { code: string; details?: Record<string, unknown> };
    };
    return {
      status: res.status,
      ...(body.error !== undefined && { code: body.error.code }),
      ...(body.error?.details !== undefined && { details: body.error.details }),
      reads: calls.length,
    };
  }

  test('an image in the repository registers', async () => {
    expect((await deploy('ghcr.io/acme')).status).toBe(201);
  });

  test('an image outside it is refused before any registry read, naming only its own prefix', async () => {
    const r = await deploy('ghcr.io/other');
    expect(r).toMatchObject({ status: 409, code: 'image-not-allowed', reads: 0 });
    expect(r.details).toMatchObject({ imagePrefix: 'ghcr.io/other' });
  });

  test('on a path boundary: ghcr.io/acm never admits ghcr.io/acme', async () => {
    expect(await deploy('ghcr.io/acm')).toMatchObject({ status: 409, code: 'image-not-allowed' });
  });

  test('no prefix: refused on a runtime serving many tenants', async () => {
    expect(await deploy(undefined)).toMatchObject({
      status: 409,
      code: 'image-prefix-unset',
      reads: 0,
    });
  });

  test('a stored prefix that does not parse refuses: it fails closed', async () => {
    expect(await deploy('not a prefix/')).toMatchObject({
      status: 409,
      code: 'image-prefix-unset',
    });
  });

  test('a runtime serving one tenant never checks: any image registers, prefix or not', async () => {
    expect((await deploy(undefined, 'single')).status).toBe(201);
    expect((await deploy('ghcr.io/other', 'single')).status).toBe(201);
  });
});

// ---------------- deploying into a named project, one per client ----------------

describe('POST /v1/deployments with projectId: one project per client', () => {
  /** A pack whose ids carry its own pack id, as `kindgi init` makes one per client. */
  const clientPack = (packId: string, keyId?: SigningKeyId) =>
    buildSignedDeploy({
      ...(keyId !== undefined && { keyId }),
      artifactVersion: '20261012.1',
      publishedAt: '2026-10-12T09:00:00.000Z',
      index: {
        v: 1,
        packId,
        packVersion: '1.0.0',
        artifactVersion: '20261012.1',
        publishedAt: '2026-10-12T09:00:00.000Z',
        tools: [
          {
            id: `${packId}.woo.find-orders`,
            description: 'Find orders.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/find-orders.js',
          },
        ],
        guardrails: [],
        agents: [
          {
            id: `${packId}.store-agent`,
            version: '1.0.0',
            name: 'Store agent',
            instructions: 'help',
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
          },
        ],
        flows: [],
      },
    });

  const deploy = (app: ReturnType<typeof makeApp>['app'], wire: unknown, token = TOKEN) =>
    app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });

  test("the deploy's tools and agents go into the named project, and the record keeps it", async () => {
    const fixture = clientPack('acme-shop');
    lastToolRegisterProjectId = undefined;
    lastAgentPublishProjectId = undefined;
    const { app, deploymentRegistry } = makeApp({ fixture });
    const res = await deploy(app, { ...fixture.wire, projectId: CLIENT_A });
    expect(res.status).toBe(201);
    expect(lastToolRegisterProjectId).toBe(CLIENT_A);
    expect(lastAgentPublishProjectId).toBe(CLIENT_A);
    const body = (await res.json()) as { deploymentId: string; projectId?: string };
    expect(body.projectId).toBe(CLIENT_A);
    const stored = await deploymentRegistry.get({ tenantId, deploymentId: body.deploymentId });
    expect(stored?.projectId).toBe(CLIENT_A);
  });

  test('without projectId: tenant-wide, into the Default project, and the record names none', async () => {
    const fixture = clientPack('acme-shop');
    lastToolRegisterProjectId = undefined;
    const { app } = makeApp({ fixture });
    const res = await deploy(app, fixture.wire);
    expect(res.status).toBe(201);
    expect(lastToolRegisterProjectId).toBe(DEFAULT_PROJECT_ID);
    const body = (await res.json()) as Record<string, unknown>;
    expect('projectId' in body).toBe(false);
  });

  test('two clients, two packs, one tenant: each deploys into its own project', async () => {
    const a = clientPack('acme-shop');
    const b = clientPack('globex-shop', 'key-globex' as SigningKeyId);
    const { app, toolRegistry } = makeApp({
      fixture: a,
      extraTrust: [
        {
          keyId: 'key-globex' as SigningKeyId,
          tenantId,
          publicKey: Buffer.from(b.publicKeyRaw).toString('base64'),
        },
      ],
      extraImages: [{ imageRef: b.imageRef, digest: b.digest, indexBytes: b.indexBytes }],
    });
    lastToolRegisterProjectId = undefined;
    expect((await deploy(app, { ...a.wire, projectId: CLIENT_A })).status).toBe(201);
    expect(lastToolRegisterProjectId).toBe(CLIENT_A);
    expect((await deploy(app, { ...b.wire, projectId: CLIENT_B })).status).toBe(201);
    expect(lastToolRegisterProjectId).toBe(CLIENT_B);
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme-shop.woo.find-orders' as never }),
    ).not.toBeNull();
    expect(
      await toolRegistry.get({ tenantId, toolId: 'globex-shop.woo.find-orders' as never }),
    ).not.toBeNull();
  });

  test('a projectId that is not a project id is 400; one of no project of this tenant is 404; nothing registers', async () => {
    const fixture = clientPack('acme-shop');
    lastToolRegisterProjectId = undefined;
    const { app } = makeApp({ fixture });
    const bad = await deploy(app, { ...fixture.wire, projectId: 'client-a' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    const unknown = await deploy(app, { ...fixture.wire, projectId: randomUUID() });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'project-not-found',
    );
    expect(lastToolRegisterProjectId).toBeUndefined();
  });

  test('a key limited to another project is refused; one limited to the named project deploys', async () => {
    const fixture = clientPack('acme-shop');
    const KEY_A = 'deployments-key-client-a';
    const { app } = makeApp({
      fixture,
      extra: {
        resolveToken: async (token) =>
          token === KEY_A ? { tenantId, tokenProjectId: CLIENT_A } : resolveToken(token),
      },
    });
    const other = await deploy(app, { ...fixture.wire, projectId: CLIENT_B }, KEY_A);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe(
      'key-project-mismatch',
    );
    expect((await deploy(app, { ...fixture.wire, projectId: CLIENT_A }, KEY_A)).status).toBe(201);
  });

  test('a suspended project takes no deploy, named or the Default; another project still does', async () => {
    const suspended = new Set<string>([CLIENT_A, DEFAULT_PROJECT_ID]);
    const asked: string[] = [];
    const extra = {
      projectSuspended: async (t: TenantId, projectId: ProjectId) => {
        asked.push(`${t}/${projectId}`);
        return suspended.has(projectId);
      },
    };
    const named = clientPack('acme-shop');
    lastToolRegisterProjectId = undefined;
    const intoA = makeApp({ fixture: named, extra });
    const refused = await deploy(intoA.app, { ...named.wire, projectId: CLIENT_A });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('project-suspended');
    expect(body.error.message).toContain('nothing was deployed');
    expect(lastToolRegisterProjectId).toBeUndefined();
    expect(
      await intoA.toolRegistry.get({ tenantId, toolId: 'acme-shop.woo.find-orders' as never }),
    ).toBeNull();
    expect(asked).toEqual([`${tenantId}/${CLIENT_A}`]);

    const wide = clientPack('acme-shop');
    const tenantWide = await deploy(makeApp({ fixture: wide, extra }).app, wide.wire);
    expect(tenantWide.status).toBe(409);

    const other = clientPack('globex-shop');
    expect(
      (await deploy(makeApp({ fixture: other, extra }).app, { ...other.wire, projectId: CLIENT_B }))
        .status,
    ).toBe(201);
  });

  test("with an authorizer: admin on the named project deploys there; another project's, or tenant-wide, is refused", async () => {
    const PROJECT_ADMIN = 'deployments-client-a-admin';
    const grants: Readonly<Record<string, readonly string[]>> = {
      'client-a-admin': [`admin project:${CLIENT_A}`, `read tenant:${tenantId}`],
    };
    const decide = (principal: unknown, action: string, resource: { type: string; id: string }) => {
      const allowed = (grants[(principal as { actor: { id: string } }).actor.id] ?? []).includes(
        `${action} ${resource.type}:${resource.id}`,
      );
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not granted',
        evidence: {
          action,
          relation: '',
          resource: `${resource.type}:${resource.id}`,
          actorSubject: '',
        },
      };
    };
    const fixture = clientPack('acme-shop');
    const { app } = makeApp({
      fixture,
      extra: {
        resolveToken: async (token) =>
          token === PROJECT_ADMIN
            ? { tenantId, userId: 'client-a-admin' as never }
            : resolveToken(token),
        authz: {
          fgaApiUrl: 'http://fga.invalid',
          authzCheckBinding: {
            check: async (p, a, r) => decide(p, a, r) as never,
            checkBatch: async (p, a, rs) => rs.map((r) => decide(p, a, r)) as never,
          },
        },
      },
    });
    expect(
      (await deploy(app, { ...fixture.wire, projectId: CLIENT_B }, PROJECT_ADMIN)).status,
    ).toBe(403);
    expect((await deploy(app, fixture.wire, PROJECT_ADMIN)).status).toBe(403);
    expect(
      (await deploy(app, { ...fixture.wire, projectId: CLIENT_A }, PROJECT_ADMIN)).status,
    ).toBe(201);
  });
});

// ---------------- pack check ids under per-deployment routing ----------------

describe("POST /v1/deployments: a pack check carries its pack's id where checks are routed by id", () => {
  const withCheck = (checkId: string, builtIn = false) =>
    buildSignedDeploy({
      index: {
        v: 1,
        packId: 'acme-shop',
        packVersion: '1.0.0',
        artifactVersion: '20260920.1',
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [],
        guardrails: [
          {
            id: 'acme-shop.no-contact-details',
            name: 'no-contact-details',
            kind: 'zero-llm',
            action: { 'on-violation': 'halt' },
            severity: 'error',
            scope: { when: 'runtime-only' },
            checkModulePath: 'guardrails/no-contact-details.mjs',
            checkId,
            ...(builtIn && { checkBuiltIn: true }),
          },
        ],
        agents: [],
        flows: [],
      },
    });
  const post = (app: ReturnType<typeof makeApp>['app'], wire: unknown) =>
    app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });

  test('an unprefixed pack check is refused, naming the fix; nothing is registered', async () => {
    const fixture = withCheck('shared.checks.contact');
    const { app, guardrailRegistry } = makeApp({ fixture, extra: PER_DEPLOYMENT });
    const res = await post(app, fixture.wire);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Record<string, unknown>[] } };
    };
    expect(body.error.code).toBe('deployment-validation-failed');
    expect(body.error.details?.issues).toEqual([
      {
        primitive: 'guardrail',
        index: 0,
        id: 'acme-shop.no-contact-details',
        path: '/check',
        message:
          'check "shared.checks.contact" doesn\'t start with this pack\'s id ("acme-shop."). Name it "acme-shop.checks.<name>": this runtime sends each check call to the deployment that shipped its id, so two packs\' checks must never share one.',
      },
    ]);
    expect(
      await guardrailRegistry.get({
        tenantId,
        guardrailId: 'acme-shop.no-contact-details' as never,
      }),
    ).toBeNull();
  });

  test('a prefixed pack check deploys; so does a built-in one the guardrail merely names', async () => {
    const prefixed = withCheck('acme-shop.checks.contact');
    expect(
      (await post(makeApp({ fixture: prefixed, extra: PER_DEPLOYMENT }).app, prefixed.wire)).status,
    ).toBe(201);
    const builtIn = withCheck('must-cite', true);
    expect(
      (await post(makeApp({ fixture: builtIn, extra: PER_DEPLOYMENT }).app, builtIn.wire)).status,
    ).toBe(201);
  });

  test('with one pack service (no per-deployment routing), the build warning stays the only word', async () => {
    const fixture = withCheck('shared.checks.contact');
    expect((await post(makeApp({ fixture }).app, fixture.wire)).status).toBe(201);
  });
});

// ---------------- environment orders: builds enter at the first environment ----------------

describe('POST /v1/deployments into an environment order: a later environment takes builds by promotion only', () => {
  // staging-1 (first), staging-2, then the Default project as prod.
  const STAGING_1 = CLIENT_A;
  const STAGING_2 = CLIENT_B;
  const ORDER = [STAGING_1, STAGING_2, DEFAULT_PROJECT_ID] as const;
  const request = (
    app: ReturnType<typeof makeApp>['app'],
    fixture: SignedDeploy,
    projectId: ProjectId | undefined,
  ) =>
    app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...fixture.wire, ...(projectId !== undefined && { projectId }) }),
    });
  const deployInto = async (
    projectId: ProjectId | undefined,
    orders: readonly (readonly ProjectId[])[] = [ORDER],
  ) => {
    const fixture = buildSignedDeploy({
      artifactVersion: '20260920.1',
      index: indexWith('20260920.1'),
    });
    const made = makeApp({ fixture, extra: { environmentOrders: environmentOrders(orders) } });
    lastToolRegisterProjectId = undefined;
    return { ...made, res: await request(made.app, fixture, projectId) };
  };

  test('into the second environment: 409 environment-takes-promotions, naming the first, and nothing registered', async () => {
    const { res, deploymentRegistry, toolRegistry, guardrailRegistry } =
      await deployInto(STAGING_2);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('environment-takes-promotions');
    expect(body.error.message).toBe(
      "This project is a later environment of its environment order (position 1), and a later environment takes builds only by promotion from the one before it. Deploy into the order's first environment and promote the build from there. Nothing was deployed.",
    );
    expect(body.error.details).toEqual({ firstProjectId: STAGING_1, position: 1 });
    // Counted before any write: no deployment, no tool, no guardrail.
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
    expect(lastToolRegisterProjectId).toBeUndefined();
    expect(
      await toolRegistry.get({ tenantId, toolId: 'acme.verify-citation' as never }),
    ).toBeNull();
    expect(
      await guardrailRegistry.get({ tenantId, guardrailId: 'acme.no-fabricated-quotes' as never }),
    ).toBeNull();
  });

  test('naming no project, with the Default project last in the order: refused the same way', async () => {
    const { res, deploymentRegistry } = await deployInto(undefined);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('environment-takes-promotions');
    expect(body.error.details).toEqual({ firstProjectId: STAGING_1, position: 2 });
    expect((await deploymentRegistry.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test('into the first environment: deployed there, as before', async () => {
    const { res } = await deployInto(STAGING_1);
    expect(res.status).toBe(201);
    expect(lastToolRegisterProjectId).toBe(STAGING_1);
  });

  test('into a project in no order, and with no orders at all: deployed, as before', async () => {
    expect((await deployInto(ELSEWHERE_PROJECT_ID)).res.status).toBe(201);
    expect((await deployInto(STAGING_2, [])).res.status).toBe(201);
  });

  /** Prod (or another project) took the pack before the order; staging-1 then takes a later image. */
  async function guardrailFirstIn(home: ProjectId) {
    const orders: (readonly ProjectId[])[] = [];
    const first = buildSignedDeploy({
      artifactVersion: '20260920.1',
      index: indexWith('20260920.1'),
    });
    const second = laterImage();
    const made = makeApp({
      fixture: first,
      extra: { environmentOrders: environmentOrders(orders) },
      extraTrust: [
        {
          keyId: SECOND_KEY_ID,
          tenantId,
          publicKey: Buffer.from(second.publicKeyRaw).toString('base64'),
        },
      ],
      extraImages: [
        { imageRef: second.imageRef, digest: second.digest, indexBytes: second.indexBytes },
      ],
    });
    expect((await request(made.app, first, home)).status).toBe(201);
    orders.push(ORDER);
    return request(made.app, second, STAGING_1);
  }

  test("a guardrail live in another project of the order is the order's: kept, the deploy goes through", async () => {
    expect((await guardrailFirstIn(DEFAULT_PROJECT_ID)).status).toBe(201);
  });

  test('a guardrail live in a project outside the order is still refused (the inverse)', async () => {
    const refused = await guardrailFirstIn(ELSEWHERE_PROJECT_ID);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'guardrail-project-mismatch',
    );
  });
});

describe('POST /v1/deployments/:deploymentId/secrets on a runtime that refuses other envs', () => {
  const sync = (app: ReturnType<typeof createApp>, deploymentId: string, envName: string) =>
    app.request(`/v1/deployments/${deploymentId}/secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRETS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        envName,
        secrets: [
          { name: 'stripe.key', value: 'sk_test_x' },
          { name: 'search.key', value: 'sk_test_y' },
        ],
      }),
    });

  test('under another env: 409 env-not-served naming the served env, and nothing is written', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      servedEnv: 'prod',
      deployedInto: 'proj-a' as ProjectId,
    });
    const res = await sync(app, deploymentId, 'staging');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: 'env-not-served',
      message:
        'This runtime keeps its values under `prod` only, so the secret `stripe.key` under `staging` would never be read. Store it under `prod`',
      details: { envName: 'staging', servedEnv: 'prod' },
    });
    expect(secretsFixture.recordedSets).toEqual([]);
  });

  test('under the served env: synced as before', async () => {
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      servedEnv: 'prod',
      deployedInto: 'proj-a' as ProjectId,
    });
    const res = await sync(app, deploymentId, 'prod');
    expect(res.status).toBe(200);
    expect(secretsFixture.recordedSets.map((s) => [s.envName, s.name])).toEqual([
      ['prod', 'stripe.key'],
      ['prod', 'search.key'],
    ]);
  });
  test("keys providers registered before still name under their env: synced, reading the tenant's registrations once", async () => {
    let reads = 0;
    const { app, deploymentId, secretsFixture } = await makeSyncApp({
      servedEnv: 'prod',
      providerRegistry: {
        resolveForRuntime: async () => {
          reads += 1;
          return ['stripe.key', 'search.key'].map((name) => ({
            metadata: { id: `acme-${name}` },
            adapterId: '@kindgi/adapter-model-anthropic',
            secretRef: { envName: 'staging', name },
          }));
        },
      },
    });
    const res = await sync(app, deploymentId, 'staging');
    expect(res.status).toBe(200);
    expect(secretsFixture.recordedSets.map((s) => [s.envName, s.name])).toEqual([
      ['staging', 'stripe.key'],
      ['staging', 'search.key'],
    ]);
    expect(reads).toBe(1);
  });
});

// ------------------------------------------------------------------
// A deploy into a project, then its secrets sync: where a call reads them
// ------------------------------------------------------------------

describe('POST /v1/deployments into a project, then its secrets sync: a call reads what the sync stored', () => {
  /** A pack whose one tool, `acme.lookup@1.0.0`, declares `ACME_LOOKUP_KEY`. */
  const lookupPack = (artifactVersion: string) =>
    buildSignedDeploy({
      artifactVersion,
      index: {
        v: 1,
        packId: 'acme.aperture',
        packVersion: '1.0.0',
        artifactVersion,
        publishedAt: '2026-09-20T14:32:07.104Z',
        tools: [
          {
            id: 'acme.lookup',
            description: 'Looks things up with its own key.',
            version: '1.0.0',
            input: { type: 'object' },
            output: { type: 'object' },
            modulePath: './tools/lookup.js',
            needsSpec: { secrets: { ACME_LOOKUP_KEY: { type: 'string' } } },
          },
        ],
        guardrails: [],
      },
    });

  /** CLIENT_A's org, so a tool there looks at the project, the org, then the tenant. */
  const ORG = 'o-acme-clients' as OrgId;
  /** The scopes each role administers, as the authorizer is asked them (no inheritance here). */
  const ROLES = {
    'tenant-admin': [`admin tenant:${tenantId}`, `admin org:${ORG}`, `admin project:${CLIENT_A}`],
    'org-admin': [`admin org:${ORG}`, `admin project:${CLIENT_A}`],
    'project-admin': [`admin project:${CLIENT_A}`],
  } as const;
  type Role = keyof typeof ROLES;
  const roleToken = (role: Role) => `deployments-role-${role}`;

  /** An authorizer that grants `role` its scopes, with CLIENT_A in ORG. */
  function authorizedAs(role: Role): Partial<Parameters<typeof createApp>[0]> {
    const grants: readonly string[] = [...ROLES[role], `read tenant:${tenantId}`];
    const decide = (_p: unknown, action: string, resource: { type: string; id: string }) => {
      const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not granted',
        evidence: {
          action,
          relation: '',
          resource: `${resource.type}:${resource.id}`,
          actorSubject: '',
        },
      };
    };
    const projects = makeMockProjectBinding();
    return {
      resolveToken: async (token) =>
        token === roleToken(role)
          ? { tenantId, userId: role as never }
          : resolveTokenWithCaps(token),
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (p, a, r) => decide(p, a, r) as never,
          checkBatch: async (p, a, rs) => rs.map((r) => decide(p, a, r)) as never,
        },
      },
      projectBinding: {
        ...projects,
        get: async (t, id) => {
          const project = await projects.get(t, id);
          return project !== undefined && id === CLIENT_A ? { ...project, orgId: ORG } : project;
        },
      },
    };
  }

  /**
   * No authorizer unless `as` names a role (without one every scope counts,
   * as a tenant admin's would), no secret set anywhere yet unless `seed`
   * sets one, and stores that act as the runtime's do: the secrets store
   * reads only at the scope it's asked (`exact`), and the tool registry
   * keeps a version's first record, so publishing it again records nothing.
   */
  function setup(
    packs: readonly SignedDeploy[],
    opts: { readonly as?: Role; readonly seed?: readonly Scope[] } = {},
  ) {
    const secrets = makeFixtureSecretBinding(
      (opts.seed ?? []).map((scope) => ({
        scope,
        envName: 'prod',
        name: 'ACME_LOOKUP_KEY',
        currentVersion: 1,
      })),
    );
    const secretsBinding: SecretBinding = {
      ...secrets.binding,
      async resolve(input) {
        const set = secrets.recordedSets.findLast(
          (s) =>
            scopeKey(s.scope) === scopeKey(input.scope) &&
            s.envName === (input.envName as unknown as string) &&
            s.name === input.name,
        );
        if (set === undefined) {
          return {
            kind: 'err',
            error: { code: 'secret-not-found', message: 'not set', name: input.name },
          };
        }
        return {
          kind: 'ok',
          value: { name: input.name, versionId: 1, value: set.value, scope: set.scope },
        };
      },
    };
    const tools = makeVersionedToolRegistry();
    const recorded = new Map<string, ToolPublishScopes>();
    const toolRegistry = {
      ...tools,
      publish: async (input: Parameters<ToolRegistryBinding['publish']>[0]) => {
        const key = `${input.tool.id as unknown as string}@${input.tool.version}`;
        if (!recorded.has(key)) recorded.set(key, input.secretScopes);
        return tools.publish(input);
      },
    } as ToolRegistryBinding;
    const { app } = makeApp({
      toolRegistry,
      extraTrust: packs.map((f) => ({
        keyId: KEY_ID,
        tenantId,
        publicKey: Buffer.from(f.publicKeyRaw).toString('base64'),
      })),
      extraImages: packs.map((f) => ({
        imageRef: f.imageRef,
        digest: f.digest,
        indexBytes: f.indexBytes,
      })),
      ...(opts.as !== undefined && { omitProjectBinding: true }),
      extra: {
        secretsBinding,
        envName: 'prod' as never,
        resolveToken: resolveTokenWithCaps,
        ...(opts.as !== undefined && authorizedAs(opts.as)),
      },
    });
    const token = opts.as !== undefined ? roleToken(opts.as) : TOKEN;
    const deploy = async (f: SignedDeploy, projectId?: ProjectId) => {
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...f.wire, ...(projectId !== undefined && { projectId }) }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { deploymentId: string }).deploymentId;
    };
    // What `kindgi deploy --sync-secrets` does once the deploy lands.
    const sync = async (deploymentId: string) => {
      const res = await app.request(`/v1/deployments/${deploymentId}/secrets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRETS_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          envName: 'prod',
          secrets: [{ name: 'ACME_LOOKUP_KEY', value: 'acme-lookup-key-value' }],
        }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };
    // The scope recorded for the version's secret.
    const recordedAt = () => recorded.get('acme.lookup@1.0.0')?.ACME_LOOKUP_KEY;
    // As a call reads it: at the scope recorded for the version, and there only.
    const read = async () => {
      const at = recordedAt();
      if (at === undefined || at === null) throw new Error(`nothing recorded: ${String(at)}`);
      const resolved = await resolveAtScope(secretsBinding, {
        scope: scopeOfRecorded(tenantId, at),
        envName: 'prod' as EnvName,
        name: 'ACME_LOOKUP_KEY',
        resolveContext: { caller: 'dispatch' },
      });
      return { at, resolved };
    };
    return { deploy, sync, read, recordedAt, synced: secrets.recordedSets };
  }

  test('a first deploy into a named project, with the secret set nowhere yet', async () => {
    const pack = lookupPack('20260920.1');
    const { deploy, sync, read, synced } = setup([pack]);
    await sync(await deploy(pack, CLIENT_A));
    expect(synced.map((s) => s.scope)).toEqual([
      { kind: 'project', tenantId, projectId: CLIENT_A },
    ]);
    const { at, resolved } = await read();
    expect(resolved, JSON.stringify(resolved)).toMatchObject({
      kind: 'ok',
      value: { value: 'acme-lookup-key-value' },
    });
    expect(at).toEqual({ kind: 'project', projectId: CLIENT_A });
  });

  test('a later deploy of the same tool version, after that first one', async () => {
    const first = lookupPack('20260920.1');
    const second = lookupPack('20260920.2');
    const { deploy, sync, read } = setup([first, second]);
    await sync(await deploy(first, CLIENT_A));
    await sync(await deploy(second, CLIENT_A));
    const { resolved } = await read();
    expect(resolved, JSON.stringify(resolved)).toMatchObject({
      kind: 'ok',
      value: { value: 'acme-lookup-key-value' },
    });
  });

  test('a deploy with no project: its tools go to the Default project, and it syncs the tenant', async () => {
    const pack = lookupPack('20260920.1');
    const { deploy, sync, read, synced } = setup([pack]);
    await sync(await deploy(pack));
    expect(synced.map((s) => s.scope)).toEqual([{ kind: 'tenant', tenantId }]);
    const { at, resolved } = await read();
    expect(resolved, JSON.stringify(resolved)).toMatchObject({
      kind: 'ok',
      value: { value: 'acme-lookup-key-value' },
    });
    expect(at).toEqual({ kind: 'tenant' });
  });

  test("with an authorizer, a first deploy into a named project records it for the tenant's admin, an org's admin and the project's", async () => {
    for (const role of ['tenant-admin', 'org-admin', 'project-admin'] as const) {
      const pack = lookupPack('20260920.1');
      const { deploy, recordedAt } = setup([pack], { as: role });
      await deploy(pack, CLIENT_A);
      expect(recordedAt(), role).toEqual({ kind: 'project', projectId: CLIENT_A });
    }
  });

  test('a name already set at a broader scope the deployer administers is still recorded there', async () => {
    const pack = lookupPack('20260920.1');
    const atOrg = setup([pack], { as: 'org-admin', seed: [{ kind: 'org', tenantId, orgId: ORG }] });
    await atOrg.deploy(pack, CLIENT_A);
    expect(atOrg.recordedAt()).toEqual({ kind: 'org', orgId: ORG });
    const atTenant = setup([pack], { as: 'tenant-admin', seed: [{ kind: 'tenant', tenantId }] });
    await atTenant.deploy(pack, CLIENT_A);
    expect(atTenant.recordedAt()).toEqual({ kind: 'tenant' });
  });
});

type ToolPublishScopes = Parameters<ToolRegistryBinding['publish']>[0]['secretScopes'];

// ---------------- the pack's data blocks ----------------

describe("POST /v1/deployments — the pack's data blocks are published with it", () => {
  const REPLY = {
    id: 'acme.reply',
    version: '1.0.0',
    kind: 'prompt',
    content: { template: 'Reply to {{ name }}.' },
    modulePath: 'blocks/reply.json',
  };
  const STYLE = {
    id: 'acme.style',
    version: '1.0.0',
    kind: 'settings',
    content: { values: { tone: 'warm' } },
    modulePath: 'blocks/style.json',
  };

  /** A pack whose agent takes its prompt and settings from blocks; `blocks` absent when not given. */
  function pack(blocks?: readonly Record<string, unknown>[], artifactVersion = '20261020.1') {
    const publishedAt = '2026-10-20T21:00:00.000Z';
    return buildSignedDeploy({
      artifactVersion,
      publishedAt,
      index: {
        v: 1,
        packId: 'acme.support',
        packVersion: '1.0.0',
        artifactVersion,
        publishedAt,
        tools: [],
        guardrails: [],
        agents: [
          {
            id: 'acme.replier',
            version: '1.0.0',
            name: 'Replier',
            instructions: { prompt: 'acme.reply', version: '^1.0.0' },
            capabilities: [{ feature: 'model.text.chat' }],
            tools: [],
            settings: [{ id: 'acme.style', version: '^1.0.0' }],
          },
        ],
        flows: [],
        ...(blocks !== undefined && { blocks }),
      },
    });
  }

  function setup(
    opts: { withBlocks?: boolean; agentFails?: boolean; blocksReadOnly?: string } = {},
  ) {
    const blocks = inMemoryBlocks();
    const agents = makeInMemoryAgentRegistry();
    const failing = { agent: opts.agentFails === true };
    const pinned: unknown[] = [];
    const written: string[] = [];
    const asked: string[] = [];
    const deploy = async (f: SignedDeploy) => {
      const { app } = makeApp({
        fixture: f,
        agentRegistry: {
          ...agents,
          publish: async (input) => {
            if (failing.agent) throw new Error('agent store down');
            written.push(`agent ${input.agent.id as unknown as string}`);
            pinned.push(input.agent.pins);
            return agents.publish(input);
          },
        },
        extra: {
          ...(opts.withBlocks !== false && {
            blockRegistry: {
              ...blocks,
              ...(opts.blocksReadOnly !== undefined && {
                readOnly: { reason: opts.blocksReadOnly },
              }),
              publish: async (input) => {
                const outcome = await blocks.publish(input);
                written.push(`block ${input.block.id}@${input.block.version} ${outcome.kind}`);
                return outcome;
              },
            },
          }),
          referenceScope: {
            reachable: async ({ ref }) => {
              asked.push(`${ref.kind}:${ref.id}`);
              return true;
            },
          },
        },
      });
      const res = await app.request('/v1/deployments', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(f.wire),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const held = (blockId: string, version: string) =>
      blocks.getVersion({ tenantId, blockId, version });
    return { blocks, deploy, held, pinned, written, asked, failing };
  }

  test('a read-only block registry refuses the deploy before anything is written', async () => {
    const reason =
      "Under kindgi dev, the pack is the source of data blocks: change the block in the pack's files.";
    const { deploy, held, written } = setup({ blocksReadOnly: reason });
    const res = await deploy(pack([REPLY, STYLE]));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'registry-read-only', message: reason });
    expect(written).toEqual([]);
    expect(await held('acme.reply', '1.0.0')).toBeNull();
  });

  test("its new blocks are published into the deploy's project first, and its agent pins them", async () => {
    const { deploy, held, pinned, written, asked } = setup();
    const res = await deploy(pack([REPLY, STYLE]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(written).toEqual([
      'block acme.reply@1.0.0 ok',
      'block acme.style@1.0.0 ok',
      'agent acme.replier',
    ]);
    expect(await held('acme.reply', '1.0.0')).toMatchObject({
      kind: 'prompt',
      content: { template: 'Reply to {{ name }}.' },
      projectId: DEFAULT_PROJECT_ID,
    });
    // Its file in the pack isn't part of the block.
    expect(await held('acme.reply', '1.0.0')).not.toHaveProperty('modulePath');
    expect(pinned).toEqual([
      expect.objectContaining({
        prompts: { 'acme.reply': '1.0.0' },
        settings: { 'acme.style': '1.0.0' },
      }),
    ]);
    // What the deploy brings needn't be reachable from elsewhere.
    expect(asked.filter((a) => a.startsWith('block:'))).toEqual([]);
  });

  test('a version it holds with the same content is kept, a settings version keeping its schema included', async () => {
    const { blocks, deploy, held, written } = setup();
    await blocks.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      block: {
        id: 'acme.style',
        version: '0.9.0',
        kind: 'settings',
        content: { values: { tone: 'brief' }, schema: { type: 'object' } },
      },
    });
    expect((await deploy(pack([REPLY, STYLE]))).status).toBe(201);
    // Stored with the schema it keeps from 0.9.0; the pack's file gives none.
    expect(await held('acme.style', '1.0.0')).toMatchObject({
      content: { values: { tone: 'warm' }, schema: { type: 'object' } },
    });
    written.length = 0;
    const again = await deploy(pack([REPLY, STYLE], '20261020.2'));
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(written.filter((w) => w.startsWith('block '))).toEqual([
      'block acme.reply@1.0.0 already-registered',
      'block acme.style@1.0.0 already-registered',
    ]);
  });

  test('a version it holds with other content is refused before anything is written: give it a new version', async () => {
    const { blocks, deploy, written } = setup();
    await blocks.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      block: { id: 'acme.reply', version: '1.0.0', kind: 'prompt', content: { template: 'Hi.' } },
    });
    const res = await deploy(pack([REPLY, STYLE]));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'block-already-registered',
      details: { primitive: 'block', id: 'acme.reply@1.0.0' },
    });
    expect(res.body.error.message).toBe(
      "The block acme.reply@1.0.0 wasn't published: version 1.0.0 is already published with other content; a version never changes, so give the pack's block a new version; nothing was deployed",
    );
    expect(written).toEqual([]);
  });

  test('an unregistered version is refused, naming how to reinstate it', async () => {
    const { blocks, deploy, written } = setup();
    await blocks.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      block: { id: 'acme.style', version: '1.0.0', kind: 'settings', content: STYLE.content },
    });
    await blocks.unregister({ tenantId, blockId: 'acme.style', version: '1.0.0' });
    const res = await deploy(pack([REPLY, STYLE]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('block-already-registered');
    expect(res.body.error.message).toBe(
      "The block acme.style@1.0.0 wasn't published: version 1.0.0 is unregistered (by hand, or by a deploy that failed after publishing it): reinstate it (`kindgi blocks reinstate acme.style --block-version=1.0.0`), or give the pack's block a new version; nothing was deployed",
    );
    expect(written).toEqual([]);
  });

  test("a block that doesn't hold up, or a version of another kind: deployment-validation-failed, at its place in blocks", async () => {
    const { blocks, deploy, written } = setup();
    await blocks.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      block: { id: 'acme.style', version: '0.9.0', kind: 'prompt', content: { template: 'x' } },
    });
    const broken = { ...REPLY, content: { template: 'Reply to {{ name ' } };
    const invalid = await deploy(pack([broken, STYLE]));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('deployment-validation-failed');
    expect(invalid.body.error.details.issues).toEqual([
      expect.objectContaining({
        primitive: 'block',
        index: 0,
        id: 'acme.reply',
        path: '/content/template',
      }),
    ]);

    const otherKind = await deploy(pack([REPLY, STYLE], '20261020.2'));
    expect(otherKind.status).toBe(400);
    expect(otherKind.body.error.details.issues).toEqual([
      expect.objectContaining({ primitive: 'block', index: 1, id: 'acme.style', path: '/kind' }),
    ]);
    expect(written).toEqual([]);
  });

  test('a block whose versions live in another project is refused, even unchanged; nothing stays published', async () => {
    const { blocks, deploy, written } = setup();
    await blocks.publish({
      tenantId,
      projectId: ELSEWHERE_PROJECT_ID,
      block: { id: 'acme.style', version: '1.0.0', kind: 'settings', content: STYLE.content },
    });
    const res = await deploy(pack([REPLY, STYLE]));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'block-project-mismatch',
      details: { primitive: 'block', id: 'acme.style@1.0.0' },
    });
    expect(written).toEqual([
      'block acme.reply@1.0.0 ok',
      'block acme.style@1.0.0 project-mismatch',
    ]);
    // The one it published is rolled back.
    expect(await blocks.get({ tenantId, blockId: 'acme.reply' })).toBeNull();
  });

  test('a write that fails after them rolls its new blocks back', async () => {
    const { blocks, deploy, held } = setup({ agentFails: true });
    await blocks.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      block: { id: 'acme.style', version: '1.0.0', kind: 'settings', content: STYLE.content },
    });
    expect((await deploy(pack([REPLY, STYLE]))).status).toBe(500);
    expect(await held('acme.reply', '1.0.0')).toHaveProperty('unregisteredAt');
    // The one it kept was never the deploy's to roll back.
    expect(await held('acme.style', '1.0.0')).not.toHaveProperty('unregisteredAt');
  });

  test('its retry is refused, naming each block it rolled back and the command that reinstates it; reinstated, the pack deploys', async () => {
    const { blocks, deploy, held, pinned, written, failing } = setup({ agentFails: true });
    const f = pack([REPLY, STYLE]);
    expect((await deploy(f)).status).toBe(500);
    failing.agent = false;
    written.length = 0;

    // The registry doesn't record who unregistered a version: the deploy never reinstates one.
    const retry = await deploy(f);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatchObject({
      code: 'block-already-registered',
      details: { primitive: 'block', id: 'acme.reply@1.0.0' },
    });
    expect(retry.body.error.message).toBe(
      "The block acme.reply@1.0.0 wasn't published: version 1.0.0 is unregistered, and so is acme.style@1.0.0 (by hand, or by a deploy that failed after publishing them): reinstate each (`kindgi blocks reinstate acme.reply --block-version=1.0.0`, `kindgi blocks reinstate acme.style --block-version=1.0.0`), or give the pack's blocks new versions; nothing was deployed",
    );
    expect(written).toEqual([]);

    for (const blockId of ['acme.reply', 'acme.style']) {
      await blocks.reinstateVersion({ tenantId, blockId, version: '1.0.0' });
    }
    const reinstated = await deploy(f);
    expect(reinstated.status, JSON.stringify(reinstated.body)).toBe(201);
    expect(written).toEqual([
      'block acme.reply@1.0.0 already-registered',
      'block acme.style@1.0.0 already-registered',
      'agent acme.replier',
    ]);
    expect(pinned).toEqual([
      expect.objectContaining({
        prompts: { 'acme.reply': '1.0.0' },
        settings: { 'acme.style': '1.0.0' },
      }),
    ]);
    expect(await held('acme.reply', '1.0.0')).not.toHaveProperty('unregisteredAt');
  });

  /** Publish a version of the prompt block straight to the runtime, as `kindgi blocks publish` does. */
  async function publishReply(blocks: ReturnType<typeof inMemoryBlocks>, version: string) {
    await blocks.publish({
      tenantId,
      projectId: DEFAULT_PROJECT_ID,
      block: { id: 'acme.reply', version, kind: 'prompt', content: { template: 'Hello.' } },
    });
  }

  test("an agent pins the pack's own version of a block it brings, not a newer one in range", async () => {
    const { blocks, deploy, held, pinned } = setup();
    await publishReply(blocks, '1.0.0');
    await publishReply(blocks, '1.5.0');
    const res = await deploy(pack([{ ...REPLY, version: '1.2.0' }, STYLE]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await held('acme.reply', '1.2.0')).not.toBeNull();
    expect(pinned).toEqual([
      expect.objectContaining({
        prompts: { 'acme.reply': '1.2.0' },
        settings: { 'acme.style': '1.0.0' },
      }),
    ]);
  });

  test("a block the pack doesn't bring pins the newest published version in range, as before", async () => {
    const { blocks, deploy, pinned } = setup();
    await publishReply(blocks, '1.0.0');
    await publishReply(blocks, '1.5.0');
    const res = await deploy(pack([STYLE]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pinned).toEqual([
      expect.objectContaining({
        prompts: { 'acme.reply': '1.5.0' },
        settings: { 'acme.style': '1.0.0' },
      }),
    ]);
  });

  test("a range that doesn't take the pack's version is refused, naming both, before anything is written", async () => {
    const { blocks, deploy, held, written } = setup();
    // The runtime holds a version the range takes; the pack's files are the agent, so it isn't used.
    await publishReply(blocks, '1.0.0');
    const res = await deploy(pack([{ ...REPLY, version: '2.0.0' }, STYLE]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(res.body.error.message).toContain(
      "use tool, agent or block versions that aren't published",
    );
    expect(JSON.stringify(res.body.error.details)).toContain(
      'prompt block \\"acme.reply\\": the pack brings version 2.0.0, which \\"^1.0.0\\" doesn\'t take; change the agent\'s range or the block\'s version',
    );
    expect(written).toEqual([]);
    expect(await held('acme.reply', '2.0.0')).toBeNull();
  });

  test("an index without blocks (a CLI from before them) pins what's published, and refuses what isn't", async () => {
    const { deploy, written } = setup();
    const res = await deploy(pack());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(JSON.stringify(res.body.error.details)).toContain(
      'prompt block \\"acme.reply\\" has no published version; publish the block first',
    );
    expect(written).toEqual([]);
  });

  test('a runtime with no block registry takes no blocks', async () => {
    const { deploy, written } = setup({ withBlocks: false });
    const res = await deploy(pack([REPLY, STYLE]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('deployment-validation-failed');
    expect(res.body.error.details.issues).toEqual([
      {
        primitive: 'block',
        index: 0,
        id: 'acme.reply',
        path: '',
        message: 'this runtime serves no data blocks',
      },
      {
        primitive: 'block',
        index: 1,
        id: 'acme.style',
        path: '',
        message: 'this runtime serves no data blocks',
      },
    ]);
    expect(written).toEqual([]);
  });

  test('the runtime says so in /v1/openapi.json: info["x-kindgi-capabilities"] lists deploy-publishes-pack-blocks', async () => {
    const { app } = makeApp({});
    const doc = (await (await app.request('/v1/openapi.json')).json()) as {
      info: Record<string, unknown>;
    };
    expect(doc.info['x-kindgi-capabilities']).toContain('deploy-publishes-pack-blocks');
    expect(doc.info.version).toBe('0.1.0');
  });
});
