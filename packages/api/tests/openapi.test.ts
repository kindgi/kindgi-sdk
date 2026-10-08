// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type {
  ComplianceClassifierFile,
  ComplianceEvidenceGenerator,
  LoadedClassifier,
} from '@kindgi/compliance';
import { createInMemorySigningKeyBinding, generateEd25519KeyPair } from '@kindgi/crypto';
import {
  makeInMemoryOrgBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import { createStubAppBindings, createStubBinding } from '@kindgi/testing';
import type { SigningKeyId, TenantId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  AdapterRegistryBinding,
  AgentRegistryBinding,
  AgentReleaseBindings,
  BlobStorageBinding,
  BlockRegistryBinding,
  CapabilityRegistryBinding,
  CostBinding,
  DeploymentBinding,
  EnvBinding,
  EvalCaseStoreBinding,
  EvalRunBinding,
  EvalSuiteRegistryBinding,
  ExchangeCodeFn,
  FlowRegistryBinding,
  GuardrailRegistryBinding,
  HitlBinding,
  IdentityDirectoryBinding,
  IdentityProviderBinding,
  ImageRegistryBinding,
  JudgmentRegistryBinding,
  MCPEndpointRegistryBinding,
  MemoryBinding,
  PolicyRegistryBinding,
  ProviderRegistryBinding,
  PublicRunTokenConfig,
  RetentionBinding,
  ReviewerBinding,
  ReviewerRegistryBinding,
  RunHandlerBinding,
  SecretBinding,
  ServiceAccountBinding,
  SessionStoreBinding,
  SigningKeyBinding as SigningKeyRegistryBinding,
  SupervisorBinding,
  TokenAdmin,
  TokenResolver,
  ToolRegistryBinding,
  TriggerRegistryBinding,
  WebhookEndpointBinding,
} from '../src/index.js';
import { OPERATIONS, generateOpenApiDocument, honoToOpenapiPath } from '../src/index.js';
import { RunEventSchema } from '../src/openapi/schemas.js';

// Compliance routes mount when a classifier + generator are wired. The drift
// test only needs them mounted, so the classifier is a minimal literal and the
// generator a stub (never invoked while collecting routes).
const classifierFile: ComplianceClassifierFile = {
  version: 1,
  default: { retention: { days: 90 }, signed: false, exportable: false },
  byKind: {
    'authz-decision': { retention: { days: 90 }, signed: false, exportable: true },
    'run-outcome': { retention: { days: 90 }, signed: true, exportable: true },
  },
};
const complianceClassifier: LoadedClassifier = {
  file: classifierFile,
  resolve: (kind) => classifierFile.byKind[kind] ?? classifierFile.default,
};
const complianceGenerator = createStubBinding<ComplianceEvidenceGenerator>('complianceGenerator', {
  recordFromRun: true,
  exportSigned: true,
  describe: true,
});
const noopResolveToken: TokenResolver = async () => ({ tenantId: 't' as TenantId });
const noopRunHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};
const noopTokenAdmin: TokenAdmin = {
  mint: async () => ({
    record: { tokenId: 'x' as never, role: 'member', capabilities: [], createdAt: new Date() },
    token: 'y',
  }),
  list: async () => [],
  get: async () => undefined,
  revoke: async () => ({ kind: 'ok' }),
};
const noopReviewerBinding: ReviewerBinding = {
  resolveReviewer: async () => null,
};
const noopHitlBinding: HitlBinding = {
  getApproval: async () => ({
    kind: 'err',
    error: { code: 'approval-not-found', message: 'noop' },
  }),
  listApprovals: async () => ({ kind: 'ok', value: { approvals: [] } }),
  submitReview: async () => ({
    kind: 'err',
    error: { code: 'approval-not-found', message: 'noop' },
  }),
  loadReviewDecision: async () => ({ kind: 'ok', value: null }),
};
const noopReviewerRegistry: ReviewerRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ userId, role, tenantId, displayName }) => ({
    kind: 'ok',
    reviewer: {
      id: 'r-noop' as never,
      tenantId,
      userId,
      role,
      ...(displayName !== undefined && { displayName }),
      createdAt: '2026-01-01T00:00:00.000Z' as never,
    },
  }),
  unregister: async () => ({ unregistered: false }),
};
const noopAgentRegistry: AgentRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  getVersion: async () => null,
  headExists: async () => false,
  listVersions: async () => ({ data: [] }),
  publish: async ({ agent }) => ({ kind: 'ok', agentId: agent.id, version: agent.version }),
  unregister: async () => ({ unregistered: false }),
  reinstateVersion: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
};
const noopFlowRegistry: FlowRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  getVersion: async () => null,
  headExists: async () => false,
  listVersions: async () => ({ data: [] }),
  publish: async ({ flow }) => ({ kind: 'ok', flowId: flow.id, version: flow.version }),
  unregister: async () => ({ unregistered: false }),
  reinstateVersion: async ({ flowId, version }) => ({ kind: 'not-found', flowId, version }),
};
const noopToolRegistry: ToolRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  getVersion: async () => null,
  headExists: async () => false,
  listVersions: async () => ({ data: [] }),
  resolve: async ({ toolId }) => ({ kind: 'not-found', toolId }),
  publish: async ({ tool }) => ({
    kind: 'ok',
    toolId: tool.id,
    version: tool.version as never,
  }),
  unregister: async () => ({ unregistered: false }),
  reinstateVersion: async ({ toolId, version }) => ({ kind: 'not-found', toolId, version }),
};
const noopGuardrailRegistry: GuardrailRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ guardrail }) => ({ kind: 'ok', guardrailId: guardrail.id }),
  unregister: async () => ({ unregistered: false }),
};
const noopMemory: MemoryBinding = {
  listFacts: async () => ({ data: [] }),
  getFact: async () => null,
  writeFact: async () => ({
    kind: 'error',
    code: 'persistence-error',
    message: 'noop',
  }),
  supersedeFact: async () => ({ kind: 'not-found' }),
  deleteFact: async () => ({ kind: 'not-found' }),
  verifyFact: async () => ({ kind: 'not-found' }),
  listRevisions: async () => null,
  retrieve: async () => ({ kind: 'ok', results: [] }),
};
const noopBlobStorage: BlobStorageBinding = {
  put: async () => ({
    kind: 'err',
    error: { code: 'blob-storage-error', message: 'noop' },
  }),
  get: async () => ({
    kind: 'err',
    error: { code: 'blob-not-found', message: 'noop', blobId: 'noop' },
  }),
  head: async () => null,
  list: async () => ({ kind: 'ok', value: { data: [] } }),
  delete: async () => ({ kind: 'ok', value: { deleted: false } }),
  putByKey: async () => ({
    kind: 'err',
    error: { code: 'blob-storage-error', message: 'noop' },
  }),
  getByKey: async () => ({
    kind: 'err',
    error: { code: 'blob-not-found', message: 'noop', blobId: 'noop' },
  }),
  headByKey: async () => null,
  deleteByKey: async () => ({ kind: 'ok', value: { deleted: false } }),
  listByPrefix: async () => ({ kind: 'ok', value: { contents: [], isTruncated: false } }),
  initiateMultipartUpload: async () => ({ kind: 'ok', value: { uploadId: 'noop' } }),
  uploadPart: async () => ({ kind: 'ok', value: { etag: 'noop' } }),
  completeMultipartUpload: async () => ({
    kind: 'err',
    error: { code: 'blob-storage-error', message: 'noop' },
  }),
  abortMultipartUpload: async () => ({ kind: 'ok', value: undefined }),
  listParts: async () => ({ kind: 'ok', value: { parts: [] } }),
};

const noopCapabilityRegistry: CapabilityRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
};

const noopProviderRegistry: ProviderRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ metadata }) => ({ kind: 'ok', providerId: metadata.id }),
  unregister: async () => ({ unregistered: false }),
  capabilitiesFor: async () => null,
  resolveForRuntime: async () => [],
};

const noopMCPEndpointRegistry: MCPEndpointRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ endpoint }) => ({ kind: 'ok', endpointId: endpoint.endpointId }),
  unregister: async () => ({ unregistered: false }),
};

const noopAdapterRegistry: AdapterRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  test: async () => null,
};

function publicRunTokensConfig(): PublicRunTokenConfig {
  const pair = generateEd25519KeyPair();
  const keyId = 'public-run-tokens' as SigningKeyId;
  return {
    signingKey: createInMemorySigningKeyBinding([
      { keyId, algorithm: 'ed25519', publicKey: pair.publicKey, privateKey: pair.privateKey },
    ]),
    keyId,
  };
}

const noopWebhookEndpoints: WebhookEndpointBinding = {
  create: async () => ({ kind: 'url-refused', reason: 'noop' }),
  list: async () => ({ data: [] }),
  get: async () => null,
  update: async () => ({ kind: 'not-found' }),
  unregister: async () => ({ unregistered: false }),
  listDeliveries: async () => ({ kind: 'not-found' }),
  redeliver: async () => ({ kind: 'not-found' }),
  sendTest: async () => ({ kind: 'not-found' }),
};

const noopTriggerRegistry: TriggerRegistryBinding = {
  register: async () => ({
    kind: 'err',
    error: { code: 'trigger-register-failed', message: 'noop' },
  }),
  update: async ({ triggerId }) => ({
    kind: 'err',
    error: { code: 'trigger-update-failed', message: 'noop', triggerId },
  }),
  list: async () => ({ data: [] }),
  get: async () => null,
  pause: async ({ triggerId }) => ({
    kind: 'err',
    error: { code: 'trigger-lifecycle-failed', message: 'noop', triggerId },
  }),
  resume: async ({ triggerId }) => ({
    kind: 'err',
    error: { code: 'trigger-lifecycle-failed', message: 'noop', triggerId },
  }),
  unregister: async ({ triggerId }) => ({ triggerId, unregistered: false }),
  fetchActiveByWebhookId: async () => null,
};

const noopPolicyRegistry: PolicyRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  getVersion: async () => null,
  headExists: async () => false,
  listVersions: async () => ({ data: [] }),
  publish: async ({ policy }) => ({ kind: 'ok', policyId: policy.id, version: policy.version }),
  unregister: async () => ({ unregistered: false }),
  reinstateVersion: async ({ policyId, version }) => ({ kind: 'not-found', policyId, version }),
};

const noopEvalSuiteRegistry: EvalSuiteRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  getVersion: async () => null,
  headExists: async () => false,
  listVersions: async () => ({ data: [] }),
  publish: async ({ suite }) => ({ kind: 'ok', suiteId: suite.id, version: suite.version }),
  unregister: async () => ({ unregistered: false }),
  reinstateVersion: async ({ suiteId, version }) => ({ kind: 'not-found', suiteId, version }),
};

const noopBlockRegistry: BlockRegistryBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  getVersion: async () => null,
  listVersions: async () => ({ data: [] }),
  publish: async ({ block }) => ({ kind: 'ok', blockId: block.id, version: block.version }),
  unregister: async () => ({ unregistered: false }),
  reinstateVersion: async ({ blockId, version }) => ({ kind: 'not-found', blockId, version }),
};

const noopEvalCaseStore: EvalCaseStoreBinding = {
  putCases: async () => undefined,
  listCases: async () => ({ data: [], hasMore: false }),
};

const noopJudgmentRegistry: JudgmentRegistryBinding = {
  createClass: async () => ({ kind: 'name-taken' }),
  listClasses: async () => ({ data: [], hasMore: false }),
  getClass: async () => null,
  updateClass: async () => null,
  unregisterClass: async () => ({ unregistered: false }),
  record: async () => {
    throw new Error('noop');
  },
  list: async () => ({ data: [], hasMore: false }),
  get: async () => null,
  unregister: async () => ({ unregistered: false }),
};

const noopEvalRunBinding: EvalRunBinding = {
  start: async () => ({ kind: 'suite-not-found', suiteId: 'noop' }),
  get: async () => null,
  list: async () => ({ data: [] }),
  cancel: async () => ({ kind: 'not-found' }),
};

const noopRetention: RetentionBinding = {
  scheduled: async () => ({ data: [], domainsMissingAdapter: [], unpolicedDomains: [] }),
  sweep: async () => ({ perDomain: [], totalPurged: 0 }),
};

const noopAgentReleases: AgentReleaseBindings = {
  live: { resolve: async () => null, list: async () => [] },
  promotions: {
    promote: async () => ({
      kind: 'err',
      error: { code: 'agent-version-not-found', message: 'noop' },
    }),
    rollback: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'noop' } }),
    unpin: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'noop' } }),
    list: async () => ({ data: [] }),
    get: async () => null,
  },
  gatePolicies: {
    publish: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'noop' } }),
    get: async () => null,
    getVersion: async () => null,
    listVersions: async () => [],
    list: async () => ({ data: [] }),
    unregister: async () => ({
      kind: 'err',
      error: { code: 'gate-policy-not-found', message: 'noop' },
    }),
    reinstate: async () => ({
      kind: 'err',
      error: { code: 'gate-policy-not-found', message: 'noop' },
    }),
    resolve: async () => null,
  },
};

const noopCost: CostBinding = {
  listRecords: async () => ({ data: [] }),
  getRecord: async () => null,
  aggregate: async ({ from, to }) => ({
    groups: [],
    totalUsd: 0,
    totalRecords: 0,
    tokens: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    timeRange: {
      from: from.toISOString() as never,
      to: to.toISOString() as never,
    },
  }),
};

const noopSessionStore: SessionStoreBinding = {
  create: async ({ expiresAt }) => ({
    sessionId: 'ses-noop' as never,
    expiresAt,
  }),
  get: async () => null,
  list: async () => ({ data: [] }),
  revoke: async () => ({ revoked: false }),
  revokeAllForUser: async () => ({ revokedCount: 0 }),
};

const noopIdentityProvider: IdentityProviderBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
  unregister: async () => ({ unregistered: false }),
  signInUrls: async () => undefined,
  update: async () => ({ kind: 'not-found' }),
};

const noopIdentityDirectory: IdentityDirectoryBinding = {
  getUser: async () => null,
  listUsers: async () => ({ data: [] }),
  listSessions: async () => ({ data: [] }),
  revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
  createUser: async () => ({ kind: 'email-taken', userId: 'noop-user' as never }),
  unregisterUser: async () => ({ kind: 'not-found' }),
};

const serviceAccountNotFound = {
  kind: 'err',
  error: { code: 'service-account-not-found', message: 'noop' },
} as const;
const noopServiceAccounts: ServiceAccountBinding = {
  create: async () => serviceAccountNotFound,
  get: async () => null,
  list: async () => ({ data: [] }),
  grant: async () => serviceAccountNotFound,
  ungrant: async () => serviceAccountNotFound,
  unregister: async () => serviceAccountNotFound,
};

const noopExchangeCode: ExchangeCodeFn = async () => ({
  userId: 'noop-user',
  accessToken: 'noop',
  expiresAt: new Date(Date.now() + 60_000),
  scopes: [],
});

const noopDeploymentRegistry: DeploymentBinding = {
  register: async () => ({
    kind: 'error',
    code: 'persistence-error',
    message: 'noop',
  }),
  get: async () => null,
  getByImageDigest: async () => null,
  list: async () => ({ data: [] }),
};

const noopSigningKeyRegistry: SigningKeyRegistryBinding = {
  isTrusted: async () => ({ kind: 'ok', value: false }),
  verify: async () => ({ kind: 'ok', value: { valid: false } }),
  listTrusted: async () => ({ data: [] }),
  getTrusted: async () => null,
  addTrusted: async () => ({
    kind: 'error',
    code: 'signing-key-store-error',
    message: 'noop',
  }),
  revokeTrusted: async () => ({ revoked: false }),
};

const noopImageRegistry: ImageRegistryBinding = {
  head: async ({ imageRef }) => ({
    kind: 'err',
    error: { code: 'image-not-found', message: 'noop', imageRef },
  }),
  extractFile: async ({ imageRef, path }) => ({
    kind: 'err',
    error: { code: 'image-file-not-found', message: 'noop', imageRef, path },
  }),
  push: async () => ({
    kind: 'err',
    error: { code: 'image-push-failed', message: 'noop' },
  }),
};

const noopEnvBinding: EnvBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  resolve: async ({ name }) => ({
    kind: 'err',
    error: { code: 'env-not-found', message: 'noop', name },
  }),
  set: async ({ scope, envName, name, value }) => ({
    kind: 'ok',
    record: {
      scope,
      envName,
      name,
      value,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  }),
  delete: async () => ({ deleted: false }),
};

const noopSecretsBinding: SecretBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  resolve: async ({ name }) => ({
    kind: 'err',
    error: { code: 'secret-not-found', message: 'noop', name },
  }),
  getVersion: async () => null,
  listVersions: async () => ({ data: [] }),
  set: async ({ scope, envName, name }) => ({
    kind: 'ok',
    record: {
      scope,
      envName,
      name,
      currentVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    versionId: 1,
  }),
  rotate: async ({ name }) => ({
    kind: 'err',
    error: { code: 'secret-not-found', message: 'noop', name },
  }),
  revoke: async ({ name }) => ({
    kind: 'err',
    error: { code: 'secret-not-found', message: 'noop', name },
  }),
};

const noopSupervisor: SupervisorBinding = {
  listProposals: async () => ({ data: [] }),
  getProposal: async () => null,
  draftProposal: async () => ({
    kind: 'ok',
    proposal: {} as never,
  }),
  dryRunProposal: async ({ proposalId }) => ({ kind: 'not-found', proposalId }),
  submitReview: async ({ proposalId }) => ({ kind: 'not-found', proposalId }),
  applyProposal: async ({ proposalId }) => ({ kind: 'not-found', proposalId }),
  rollbackProposal: async ({ proposalId }) => ({ kind: 'not-found', proposalId }),
  withdrawProposal: async ({ proposalId }) => ({ kind: 'not-found', proposalId }),
  queryObservations: async () => ({ kind: 'ok', page: { data: [] } }),
};

interface HonoRouteRecord {
  readonly method: string;
  readonly path: string;
  readonly basePath?: string;
}

function collectMountedRoutes(): HonoRouteRecord[] {
  const teamPair = makeInMemoryTeamBinding();
  const projectTrio = makeInMemoryProjectBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: noopResolveToken,
    runHandler: noopRunHandler,
    tokenAdmin: noopTokenAdmin,
    serviceAccountBinding: noopServiceAccounts,
    reviewerBinding: noopReviewerBinding,
    hitlBinding: noopHitlBinding,
    reviewerRegistry: noopReviewerRegistry,
    enableObservations: true,
    agentRegistry: noopAgentRegistry,
    agentReleases: noopAgentReleases,
    flowRegistry: noopFlowRegistry,
    toolRegistry: noopToolRegistry,
    guardrailRegistry: noopGuardrailRegistry,
    memory: noopMemory,
    supervisor: noopSupervisor,
    blobStorage: noopBlobStorage,
    capabilityRegistry: noopCapabilityRegistry,
    providerRegistry: noopProviderRegistry,
    mcpEndpointRegistry: noopMCPEndpointRegistry,
    cost: noopCost,
    adapterRegistry: noopAdapterRegistry,
    triggerRegistry: noopTriggerRegistry,
    webhookEndpoints: noopWebhookEndpoints,
    publicRunTokens: publicRunTokensConfig(),
    policyRegistry: noopPolicyRegistry,
    retention: noopRetention,
    evalSuiteRegistry: noopEvalSuiteRegistry,
    blockRegistry: noopBlockRegistry,
    evalRunBinding: noopEvalRunBinding,
    judgmentRegistry: noopJudgmentRegistry,
    evalCaseStore: noopEvalCaseStore,
    sessionStore: noopSessionStore,
    session: { cookie: { allowedOrigins: ['https://console.example.com'] }, tokenSignIn: true },
    identityProvider: noopIdentityProvider,
    exchangeCode: noopExchangeCode,
    identityDirectory: noopIdentityDirectory,
    deploymentRegistry: noopDeploymentRegistry,
    signingKeyRegistry: noopSigningKeyRegistry,
    imageRegistry: noopImageRegistry,
    auditEvents: createInMemoryAuditEventBinding(),
    complianceClassifier,
    complianceGenerator,
    // Platform hierarchy.
    orgBinding: makeInMemoryOrgBinding(),
    teamBinding: teamPair.teams,
    teamMembershipBinding: teamPair.memberships,
    projectBinding: projectTrio.projects,
    projectMembershipBinding: projectTrio.memberships,
    teamProjectGrantBinding: projectTrio.grants,
    envBinding: noopEnvBinding,
    secretsBinding: noopSecretsBinding,
  });
  return (app.routes as unknown as HonoRouteRecord[]).filter((r) => r.method !== 'ALL');
}

describe('OpenAPI — operations registry ↔ mounted routes drift', () => {
  test('every mounted route has an OPERATIONS entry', () => {
    const mounted = collectMountedRoutes();
    const registered = new Set(OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.honoPath}`));
    const missing: string[] = [];
    for (const r of mounted) {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      if (!registered.has(key)) missing.push(key);
    }
    expect(
      missing,
      `Routes mounted on the Hono app but missing from OPERATIONS: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('every OPERATIONS entry maps to a mounted route', () => {
    const mounted = new Set(
      collectMountedRoutes().map((r) => `${r.method.toUpperCase()} ${r.path}`),
    );
    const dangling: string[] = [];
    for (const op of OPERATIONS) {
      const key = `${op.method.toUpperCase()} ${op.honoPath}`;
      if (!mounted.has(key)) dangling.push(key);
    }
    expect(dangling, `OPERATIONS entries with no mounted route: ${dangling.join(', ')}`).toEqual(
      [],
    );
  });

  test('openapiPath is a correct rewrite of honoPath', () => {
    for (const op of OPERATIONS) {
      expect(op.openapiPath).toBe(honoToOpenapiPath(op.honoPath));
    }
  });

  test('operationIds are unique', () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('OpenAPI — generated document', () => {
  test('is a valid OpenAPI 3.1 top-level shape', () => {
    const doc = generateOpenApiDocument() as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
      tags: Array<{ name: string }>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(0);
    expect(doc.components.securitySchemes.bearerAuth).toBeTruthy();
    expect(doc.tags.length).toBeGreaterThan(0);
  });

  test('each operation declares the security its variant names', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { operationId: string; security: unknown[] }>>;
    };
    for (const op of OPERATIONS) {
      const path = doc.paths[op.openapiPath];
      expect(path, `path ${op.openapiPath} missing`).toBeTruthy();
      const method = path?.[op.method];
      expect(method, `${op.method} ${op.openapiPath} missing`).toBeTruthy();
      if (op.security === 'public') {
        expect(method?.security).toEqual([]);
      } else if (op.security === 'bearer-or-public-run') {
        expect(method?.security).toEqual([{ bearerAuth: [] }, { publicRunToken: [] }]);
      } else {
        expect(method?.security).toEqual([{ bearerAuth: [] }]);
      }
    }
  });

  test('SSE stream endpoint advertises text/event-stream', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
      >;
    };
    const stream = doc.paths['/v1/runs/{runId}/stream']?.get;
    expect(stream).toBeTruthy();
    expect(stream?.responses['200']?.content).toHaveProperty('text/event-stream');
  });

  test('every $ref target exists under components.schemas', () => {
    const doc = generateOpenApiDocument() as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, unknown>;
    };
    const known = new Set(Object.keys(doc.components.schemas));
    const refs: string[] = [];
    collectRefs(doc.paths, refs);
    for (const ref of refs) {
      const name = ref.replace('#/components/schemas/', '');
      expect(known.has(name), `dangling $ref: ${ref}`).toBe(true);
    }
  });
});

describe('OpenAPI — RunEvent schema mirrors @kindgi/specs/run-event.schema.json', () => {
  test('kind enum + required fields match the file spec', async () => {
    const specPath = createRequire(import.meta.url).resolve('@kindgi/specs/run-event.schema.json');
    const specRaw = await readFile(specPath, 'utf8');
    const spec = JSON.parse(specRaw) as {
      required: string[];
      properties: { kind: { enum: string[] } };
    };
    const inlined = RunEventSchema as {
      required: string[];
      properties: { kind: { enum: string[] } };
    };
    expect(inlined.required.sort()).toEqual(spec.required.slice().sort());
    expect(inlined.properties.kind.enum.slice().sort()).toEqual(
      spec.properties.kind.enum.slice().sort(),
    );
  });
});

describe('OpenAPI — public route is reachable without auth', () => {
  test('GET /v1/openapi.json is public and returns 200', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: noopResolveToken,
      runHandler: noopRunHandler,
    });
    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/runs');
  });
});

function collectRefs(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') out.push(value);
    else collectRefs(value, out);
  }
}
