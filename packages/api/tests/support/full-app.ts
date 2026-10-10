// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The app with every route mounted: a no-op for every binding, so a test
 * can reach each operation (the OpenAPI drift test, and the sweep that
 * every refusal is recorded). `fullAppInput()` returns fresh in-memory
 * hierarchy bindings each call; override what a test needs.
 */

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
import type { EnvName, SigningKeyId, TenantId } from '@kindgi/types';
import type {
  AdapterRegistryBinding,
  AgentRegistryBinding,
  AgentReleaseBindings,
  BlobStorageBinding,
  BlockRegistryBinding,
  CapabilityRegistryBinding,
  CostBinding,
  CreateAppInput,
  DeploymentBinding,
  EnvBinding,
  EvalCaseStoreBinding,
  EvalRunBinding,
  EvalSuiteRegistryBinding,
  FlowRegistryBinding,
  GuardrailRegistryBinding,
  HitlBinding,
  IdentityDirectoryBinding,
  IdentityProviderBinding,
  ImageRegistryBinding,
  JudgingQueueBinding,
  JudgmentRegistryBinding,
  MCPEndpointRegistryBinding,
  MemoryBinding,
  MemoryErasureBinding,
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
} from '../../src/index.js';
import { createStubAppBindings, createStubBinding } from '../../src/testing/index.js';

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
  describe: true,
});
export const noopResolveToken: TokenResolver = async () => ({ tenantId: 't' as TenantId });
export const noopRunHandler: RunHandlerBinding = {
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
  findWebhook: async () => null,
  fireWebhook: async ({ triggerId }) => ({
    kind: 'err',
    error: { code: 'trigger-not-found', message: 'noop', triggerId },
  }),
  recordWebhookRefusal: async () => {},
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

const noopJudgingQueue: JudgingQueueBinding = {
  createRule: async () => ({
    kind: 'err',
    error: { code: 'judging-rule-not-found', message: 'noop' },
  }),
  updateRule: async () => ({
    kind: 'err',
    error: { code: 'judging-rule-not-found', message: 'noop' },
  }),
  unregisterRule: async () => ({ unregistered: false }),
  getRule: async () => null,
  listRules: async () => ({ data: [], hasMore: false }),
  ruleVersions: async () => ({ data: [], hasMore: false }),
  listQueue: async () => ({ data: [], hasMore: false, total: 0 }),
  dismiss: async () => ({
    kind: 'err',
    error: { code: 'judging-item-not-found', message: 'noop' },
  }),
  reopen: async () => ({ kind: 'err', error: { code: 'judging-item-not-found', message: 'noop' } }),
  results: async () => ({
    kind: 'err',
    error: { code: 'judging-rule-not-found', message: 'noop' },
  }),
  preview: async () => ({ considered: 0, matched: 0, failed: 0 }),
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

const noopMemoryErasures: MemoryErasureBinding = {
  create: async () => ({
    kind: 'refused',
    refusal: { code: 'legal-hold', message: 'noop' },
  }),
  get: async () => undefined,
  list: async () => ({ data: [] }),
  exportLedger: async () => [],
  resume: async () => undefined,
  replay: async () => ({ replayed: [], restored: [], unmatched: [] }),
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
  // Cookie sessions need a store that resolves its own tokens.
  resolveToken: async () => null,
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
  createProposal: async () => ({ kind: 'ok', proposal: {} as never }),
  recordProposal: async () => ({ kind: 'not-found' }),
  queryObservations: async () => ({ kind: 'ok', page: { data: [] } }),
};

/** `createApp`'s input with every route mounted. */
export function fullAppInput(): CreateAppInput {
  const teamPair = makeInMemoryTeamBinding();
  const projectTrio = makeInMemoryProjectBinding();
  return {
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
    memoryErasures: noopMemoryErasures,
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
    judgingQueue: noopJudgingQueue,
    evalCaseStore: noopEvalCaseStore,
    sessionStore: noopSessionStore,
    session: { cookie: { allowedOrigins: ['https://console.example.com'] }, tokenSignIn: true },
    identityProvider: noopIdentityProvider,
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
    webhookReceiver: { envName: 'test' as EnvName },
    publicUrl: 'https://kindgi.acme.example',
  };
}
