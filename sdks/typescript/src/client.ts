// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type AdaptersClient, makeAdaptersClient } from './resources/adapters.js';
import { type AgentsClient, makeAgentsClient } from './resources/agents.js';
import { type ApprovalsClient, makeApprovalsClient } from './resources/approvals.js';
import { type ArtifactsClient, makeArtifactsClient } from './resources/artifacts.js';
import { type AuditResourceClient, makeAuditClient } from './resources/audit.js';
import { type AuthClient, makeAuthClient } from './resources/auth.js';
import { type BlocksClient, makeBlocksClient } from './resources/blocks.js';
import { type CapabilitiesClient, makeCapabilitiesClient } from './resources/capabilities.js';
import { type ComplianceClient, makeComplianceClient } from './resources/compliance.js';
import { type ConversationsClient, makeConversationsClient } from './resources/conversations.js';
import { type CostClient, makeCostClient } from './resources/cost.js';
import { type DeploymentsClient, makeDeploymentsClient } from './resources/deployments.js';
import { type EnvClient, makeEnvClient } from './resources/env.js';
import { type EvalRunsClient, makeEvalRunsClient } from './resources/eval-runs.js';
import { type EvalSuitesClient, makeEvalSuitesClient } from './resources/eval-suites.js';
import { type EventsClient, makeEventsClient } from './resources/events.js';
import {
  type ExportSigningKeysClient,
  makeExportSigningKeysClient,
} from './resources/export-signing-keys.js';
import { type FlowsClient, makeFlowsClient } from './resources/flows.js';
import { type GatePoliciesClient, makeGatePoliciesClient } from './resources/gate-policies.js';
import { type GuardrailsClient, makeGuardrailsClient } from './resources/guardrails.js';
import { type IdentityClient, makeIdentityClient } from './resources/identity.js';
import {
  type ImprovementPassesClient,
  makeImprovementPassesClient,
} from './resources/improvement-passes.js';
import { type JudgeClassesClient, makeJudgeClassesClient } from './resources/judge-classes.js';
import { type JudgmentsClient, makeJudgmentsClient } from './resources/judgments.js';
import { type McpClient, makeMcpClient } from './resources/mcp.js';
import { type MemoryClient, makeMemoryClient } from './resources/memory.js';
import { type ObservationsClient, makeObservationsClient } from './resources/observations.js';
import { type OrgsClient, makeOrgsClient } from './resources/orgs.js';
import { type PacksClient, makePacksClient } from './resources/packs.js';
import { type PoliciesClient, makePoliciesClient } from './resources/policies.js';
import { type ProjectsClient, makeProjectsClient } from './resources/projects.js';
import { type ProposalsClient, makeProposalsClient } from './resources/proposals.js';
import { type ProvenanceClient, makeProvenanceClient } from './resources/provenance.js';
import { type ProvidersClient, makeProvidersClient } from './resources/providers.js';
import { type RetentionClient, makeRetentionClient } from './resources/retention.js';
import { type RunsClient, makeRunsClient } from './resources/runs.js';
import { type SchedulesClient, makeSchedulesClient } from './resources/schedules.js';
import { type SecretsClient, makeSecretsClient } from './resources/secrets.js';
import {
  type ServiceAccountsClient,
  makeServiceAccountsClient,
} from './resources/service-accounts.js';
import { type SigningKeysClient, makeSigningKeysClient } from './resources/signing-keys.js';
import { type SupervisorClient, makeSupervisorClient } from './resources/supervisor.js';
import { type TeamsClient, makeTeamsClient } from './resources/teams.js';
import { type TenantClient, makeTenantClient } from './resources/tenant.js';
import { type TokensClient, makeTokensClient } from './resources/tokens.js';
import { type ToolsClient, makeToolsClient } from './resources/tools.js';
import { type UsersClient, makeUsersClient } from './resources/users.js';
import {
  type WebhookEndpointsClient,
  makeWebhookEndpointsClient,
} from './resources/webhook-endpoints.js';
import { type WebhooksClient, makeWebhooksClient } from './resources/webhooks.js';
import { createTransport } from './transport.js';
import type { ClientOptions } from './types.js';

/**
 * The top-level client. One instance per `(apiUrl, auth)` pair;
 * resource clients are stateless — hold onto the `KindgiClient` for
 * the lifetime of the app, not per call.
 *
 * `createClient` returns per-resource clients accessed via
 * dot-navigation.
 */
export interface KindgiClient {
  // Substrate & execution
  readonly agents: AgentsClient;
  readonly flows: FlowsClient;
  readonly tools: ToolsClient;
  readonly guardrails: GuardrailsClient;
  readonly runs: RunsClient;
  readonly schedules: SchedulesClient;
  readonly conversations: ConversationsClient;
  // Data
  readonly memory: MemoryClient;
  readonly provenance: ProvenanceClient;
  // Governance & oversight
  readonly supervisor: SupervisorClient;
  /** Improvement proposals: new content for a data block, evaluated, then promoted for a scope. */
  readonly proposals: ProposalsClient;
  /** Improvement passes, started with `proposals.improve`. */
  readonly improvementPasses: ImprovementPassesClient;
  readonly observations: ObservationsClient;
  readonly approvals: ApprovalsClient;
  // Platform & configuration
  readonly tenant: TenantClient;
  readonly cost: CostClient;
  readonly capabilities: CapabilitiesClient;
  readonly adapters: AdaptersClient;
  readonly providers: ProvidersClient;
  readonly policies: PoliciesClient;
  /** Gate policies: what a promotion must show before a version goes live (evals step 4b). */
  readonly gatePolicies: GatePoliciesClient;
  readonly retention: RetentionClient;
  readonly projects: ProjectsClient;
  readonly env: EnvClient;
  readonly secrets: SecretsClient;
  readonly deployments: DeploymentsClient;
  readonly compliance: ComplianceClient;
  readonly audit: AuditResourceClient;
  readonly evalSuites: EvalSuitesClient;
  /** Data blocks: versioned prompts and settings an agent version pins. */
  readonly blocks: BlocksClient;
  readonly evalRuns: EvalRunsClient;
  readonly judgments: JudgmentsClient;
  readonly judgeClasses: JudgeClassesClient;
  // Identity
  readonly users: UsersClient;
  readonly identity: IdentityClient;
  readonly auth: AuthClient;
  readonly teams: TeamsClient;
  readonly orgs: OrgsClient;
  readonly signingKeys: SigningKeysClient;
  /** The keys this deployment signs its exports with (audit bundles, provenance, compliance evidence). */
  readonly exportSigningKeys: ExportSigningKeysClient;
  readonly tokens: TokensClient;
  /** Non-human principals with their own grants; they act through API keys. */
  readonly serviceAccounts: ServiceAccountsClient;
  // Interop
  readonly mcp: McpClient;
  readonly events: EventsClient;
  readonly artifacts: ArtifactsClient;
  readonly webhookEndpoints: WebhookEndpointsClient;
  /** Inbound webhook triggers: a signed request starts a flow run. */
  readonly webhooks: WebhooksClient;
  // Packs
  readonly packs: PacksClient;
}

/**
 * Construct a client. This wires the resource clients over a shared
 * transport; it does not open connections or validate the auth config.
 *
 * @example
 * ```ts
 * import { createClient } from '@kindgi/client';
 *
 * const client = createClient({
 *   apiUrl: 'https://api.example.com',
 *   auth: { kind: 'apiToken', token: process.env.KINDGI_API_TOKEN! },
 * });
 * ```
 */
export function createClient(options: ClientOptions): KindgiClient {
  const transport = createTransport(options);
  return {
    agents: makeAgentsClient(transport),
    flows: makeFlowsClient(transport),
    tools: makeToolsClient(transport),
    guardrails: makeGuardrailsClient(transport),
    runs: makeRunsClient(transport),
    schedules: makeSchedulesClient(transport),
    conversations: makeConversationsClient(transport),
    memory: makeMemoryClient(transport),
    provenance: makeProvenanceClient(transport),
    supervisor: makeSupervisorClient(transport),
    proposals: makeProposalsClient(transport),
    improvementPasses: makeImprovementPassesClient(transport),
    observations: makeObservationsClient(transport),
    approvals: makeApprovalsClient(transport),
    tenant: makeTenantClient(transport),
    cost: makeCostClient(transport),
    capabilities: makeCapabilitiesClient(transport),
    adapters: makeAdaptersClient(transport),
    providers: makeProvidersClient(transport),
    policies: makePoliciesClient(transport),
    gatePolicies: makeGatePoliciesClient(transport),
    retention: makeRetentionClient(transport),
    projects: makeProjectsClient(transport),
    env: makeEnvClient(transport),
    secrets: makeSecretsClient(transport),
    deployments: makeDeploymentsClient(transport),
    compliance: makeComplianceClient(transport),
    audit: makeAuditClient(transport),
    evalSuites: makeEvalSuitesClient(transport),
    blocks: makeBlocksClient(transport),
    evalRuns: makeEvalRunsClient(transport),
    judgments: makeJudgmentsClient(transport),
    judgeClasses: makeJudgeClassesClient(transport),
    users: makeUsersClient(transport),
    identity: makeIdentityClient(transport),
    auth: makeAuthClient(transport),
    teams: makeTeamsClient(transport),
    orgs: makeOrgsClient(transport),
    signingKeys: makeSigningKeysClient(transport),
    exportSigningKeys: makeExportSigningKeysClient(transport),
    tokens: makeTokensClient(transport),
    serviceAccounts: makeServiceAccountsClient(transport),
    mcp: makeMcpClient(transport),
    events: makeEventsClient(transport),
    artifacts: makeArtifactsClient(transport),
    webhookEndpoints: makeWebhookEndpointsClient(transport),
    webhooks: makeWebhooksClient(transport),
    packs: makePacksClient(transport),
  };
}
