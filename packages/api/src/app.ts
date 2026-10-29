// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Logger, noopLogger } from '@kindgi/log';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';

import type { ConversationBinding, RunSnapshotBinding } from '@kindgi/agents';
import type { AuditEventBinding } from '@kindgi/audit-events';
import type { AuthzCheckBinding } from '@kindgi/authz';
import type { AdapterFactoryRegistry } from '@kindgi/capabilities';
import type { ComplianceEvidenceGenerator, LoadedClassifier } from '@kindgi/compliance';
import type { ExportSigningBinding } from '@kindgi/crypto';
import type { TenantHierarchyBinding } from '@kindgi/platform';
import type {
  OrgBinding,
  ProjectBinding,
  ProjectMembershipBinding,
  TeamBinding,
  TeamMembershipBinding,
  TeamProjectGrantBinding,
} from '@kindgi/platform';
import type { KernelBinding } from '@kindgi/runtime';

import type { BlobStorageBinding } from '@kindgi/blob-binding';
import type { MemoryQueryBinding } from '@kindgi/memory';
import { type PolicyRegistryBinding, RETENTION_DOMAINS } from '@kindgi/policy-contract';
import type { AdapterRegistryBinding } from './adapter-binding.js';
import type { AgentRegistryBinding } from './agent-binding.js';
import type { BlockRegistryBinding } from './block-binding.js';
import type { CapabilityRegistryBinding } from './capability-binding.js';
import type { ConnectionBinding } from './connection-binding.js';
import type { CostBinding } from './cost-binding.js';
import type { CursorSealer } from './cursor-seal.js';
import type { DeploymentBinding } from './deployment-binding.js';
import type { DeploymentValuesDeps } from './deployment-values.js';
import type { EnvBinding } from './env-binding.js';
import type { EnvironmentOrderBinding } from './environment-orders-binding.js';
import type { WireErrorBody } from './errors.js';
import type { EvalCaseStoreBinding } from './eval-case-binding.js';
import type { EvalRunBinding } from './eval-run-binding.js';
import type { EvalSuiteRegistryBinding } from './eval-suite-binding.js';
import type { EventBusBinding } from './event-bus-binding.js';
import type { FlowRegistryBinding } from './flow-binding.js';
import type { GuardrailRegistryBinding } from './guardrail-binding.js';
import type { RunHandlerBinding } from './handler-binding.js';
import type { HitlBinding } from './hitl-binding.js';
import type { IdentityDirectoryBinding } from './identity-directory-binding.js';
import type { IdentityProviderBinding } from './identity-provider-binding.js';
import type { ImageRegistryBinding } from './image-registry-binding.js';
import type { ImprovementPassBinding } from './improvement-pass-binding.js';
import type { ItemProjectsBinding } from './item-projects-binding.js';
import { itemRightsOf, itemServingOf } from './item-rights.js';
import type { JudgingQueueBinding } from './judging-queue-binding.js';
import type { JudgmentRegistryBinding } from './judgment-binding.js';
import type { AgentReleaseBindings } from './live-version-binding.js';
import type { MCPClientProbeBinding, MCPEndpointRegistryBinding } from './mcp-endpoint-binding.js';
import type { MemoryBinding } from './memory-binding.js';
import type { MemoryErasureBinding } from './memory-erasure-binding.js';
import {
  type SessionCookieOptions,
  type TokenResolver,
  bearerAuthMiddleware,
  sessionCookieOf,
} from './middleware/auth.js';
import { type Authorizer, createAuthorizer } from './middleware/authorize.js';
import { mapThrownError } from './middleware/error-mapper.js';
import {
  type IdempotencyStore,
  createInMemoryIdempotencyStore,
  idempotencyMiddleware,
} from './middleware/idempotency.js';
import { refuseOtherProjectForKey } from './middleware/key-project.js';
import { noStoreMiddleware } from './middleware/no-store.js';
import { principalMiddleware } from './middleware/principal.js';
import { PROJECT_REF_ROUTES, refuseBadProjectId } from './middleware/project-ref.js';
import { publicRunCorsMiddleware, publicRunRouteMatcher } from './middleware/public-run-routes.js';
import {
  type OwnBodyLimit,
  readBodyOnce,
  refuseDeepJson,
  requestBodyLimit,
} from './middleware/request-body.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { loggablePath, requestLogMiddleware } from './middleware/request-log.js';
import { sealedCursors } from './middleware/sealed-cursors.js';
import { sigv4Middleware } from './middleware/sigv4.js';
import {
  type SystemAccessAuditBinding,
  type SystemTenantDirectory,
  systemPrincipalFence,
} from './middleware/system.js';
import {
  type TenantLimitsOptions,
  createTenantLimiter,
  tenantApiRequestLimit,
  tenantS3RequestLimit,
} from './middleware/tenant-limits.js';
import { tenantScopeMiddleware } from './middleware/tenant-scope.js';
import { type TenantStateBinding, tenantStateGate } from './middleware/tenant-state.js';
import type { MyAccessBinding } from './my-access-binding.js';
import { type GenerateOptions, generateOpenApiDocument } from './openapi/generate.js';
import type { PersonCapabilitiesBinding } from './person-capabilities-binding.js';
import type { PersonGrantsBinding } from './person-grants-binding.js';
import type { ProjectAccessBinding } from './project-access-binding.js';
import type { ProvenanceBinding } from './provenance-binding.js';
import type { ProviderRegistryBinding } from './provider-binding.js';
import { providerKeysOf, usersOfSecret } from './provider-keys.js';
import {
  type PublicRunTokenConfig,
  mintPublicRunToken,
  resolvePublicRunTokenConfig,
} from './public-run-token.js';
import { type RateLimitStore, nearestForwardedClient } from './rate-limit-store.js';
import type { ReferenceScopeBinding } from './reference-scope.js';
import type { RetentionBinding, RetentionLimits } from './retention-binding.js';
import type { ReviewerBinding, ReviewerRegistryBinding } from './reviewer-binding.js';
import {
  type RotationStatusStore,
  createInMemoryRotationStatusStore,
} from './rotation-status-store.js';
import { adaptersRouter } from './routes/adapters.js';
import { agentsRouter } from './routes/agents.js';
import { approvalsRouter } from './routes/approvals.js';
import {
  DEFAULT_ARTIFACT_MAX_BYTES,
  artifactUploadLimit,
  artifactsRouter,
} from './routes/artifacts.js';
import { auditRouter } from './routes/audit.js';
import { authRouter, logoutHandler } from './routes/auth.js';
import { blocksRouter } from './routes/blocks.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { complianceRouter } from './routes/compliance.js';
import {
  connectionAppsRouter,
  connectionEntriesRouter,
  connectionNoticesRouter,
  connectionsRouter,
} from './routes/connections.js';
import { conversationsRouter } from './routes/conversations.js';
import { costRouter } from './routes/cost.js';
import { deploymentsRouter } from './routes/deployments.js';
import { envRouter } from './routes/env.js';
import { environmentOrdersRouter } from './routes/environment-orders.js';
import { environmentsRouter } from './routes/environments.js';
import { evalRunsRouters } from './routes/eval-runs.js';
import { evalSuitesRouter } from './routes/eval-suites.js';
import { eventTriggersRouter } from './routes/event-triggers.js';
import { exportSigningKeysRouter } from './routes/export-signing-keys.js';
import { flowsRouter } from './routes/flows.js';
import { gatePoliciesRouter } from './routes/gate-policies.js';
import { guardrailsRouter } from './routes/guardrails.js';
import { hooksRouter } from './routes/hooks.js';
import { identityRouter } from './routes/identity.js';
import { improvementPassesRouter, mountImproveRoute } from './routes/improvement-passes.js';
import { judgedSuitesRouter } from './routes/judged-suites.js';
import { judgingRouter } from './routes/judging.js';
import { judgeClassesRouter, judgmentsRouter } from './routes/judgments.js';
import { type LicenseStatusBinding, licenseRouter } from './routes/license.js';
import { mailTriggersRouter } from './routes/mail-triggers.js';
import { mcpRouter } from './routes/mcp.js';
import { memoryErasuresRouter } from './routes/memory-erasures.js';
import { memoryRouter } from './routes/memory.js';
import { observationsRouter } from './routes/observations.js';
import { orgsRouter } from './routes/orgs.js';
import { policiesRouter } from './routes/policies.js';
import { projectAccessRouter } from './routes/project-access.js';
import {
  type ProductionGateOptions,
  projectProductionRouter,
} from './routes/project-production.js';
import { projectsRouter } from './routes/projects.js';
import { proposalsRouter } from './routes/proposals.js';
import { provenanceRouter } from './routes/provenance.js';
import { providersRouter } from './routes/providers.js';
import { publicRunTokensRouter } from './routes/public-run-tokens.js';
import { retentionRouter } from './routes/retention.js';
import { reviewersRouter } from './routes/reviewers.js';
import { type RunsRouterOptions, runsRouter } from './routes/runs.js';
import { s3Router } from './routes/s3.js';
import { schedulesRouter } from './routes/schedules.js';
import { authSettingsRouter, secondFactorIdentityRouter } from './routes/second-factor.js';
import { secretsRouter } from './routes/secrets.js';
import { serviceAccountsRouter } from './routes/service-accounts.js';
import {
  type ConsoleLink,
  type SignInLegalLinks,
  type SignInOptionsRateLimit,
  checkConsoleLinks,
  checkSignInLegal,
  signInOptionsRouter,
} from './routes/sign-in-options.js';
import { signingKeysRouter } from './routes/signing-keys.js';
import { siteEnrollRouter, siteSignInRouter } from './routes/site-auth.js';
import { sitesRouter } from './routes/sites.js';
import {
  type SystemDeploymentsOptions,
  systemDeploymentsRouter,
} from './routes/system-deployments.js';
import { type SystemKeysBinding, systemKeysRouter } from './routes/system-keys.js';
import {
  type SystemTenantSettingsBinding,
  systemTenantSettingsRouter,
} from './routes/system-tenant-settings.js';
import {
  type SystemTenantsBinding,
  systemTenantsRouter,
  systemWhoamiRouter,
} from './routes/system-tenants.js';
import { systemUsageRouter } from './routes/system-usage.js';
import { projectTeamGrantsRouter, teamProjectGrantsRouter } from './routes/team-grants.js';
import { teamsRouter } from './routes/teams.js';
import { type EgressAddresses, tenantRouter } from './routes/tenant.js';
import { tokenSignInRouter } from './routes/token-sign-in.js';
import { tokensRouter } from './routes/tokens.js';
import { toolsRouter } from './routes/tools.js';
import type { TriggerOwnerNotices } from './routes/trigger-owners.js';
import { usageRouter } from './routes/usage.js';
import { waitTokensRouter } from './routes/wait-tokens.js';
import { webhookEndpointsRouter } from './routes/webhook-endpoints.js';
import { webhooksRouter } from './routes/webhooks.js';
import type { S3CredentialBinding } from './s3-credential-binding.js';
import type { SecondFactorBinding } from './second-factor-binding.js';
import { type SecretBinding, observeSecretWrites } from './secrets-binding.js';
import { type ServedEnvRule, secretReferencesOf } from './served-env.js';
import type { ServiceAccountBinding } from './service-account-binding.js';
import type { SessionStoreBinding } from './session-store-binding.js';
import type { SigningKeyBinding as SigningKeyRegistryBinding } from './signing-key-binding.js';
import type { SiteBinding } from './site-binding.js';
import type { SupervisorBinding } from './supervisor-binding.js';
import { ONE_TENANT_SYSTEM_SCOPES } from './system.js';
import type { TenantHostAccess } from './tenant-host-access.js';
import type { TokenAdmin } from './token-admin.js';
import type { ToolRegistryBinding } from './tool-binding.js';
import { TRIGGER_KINDS, type TriggerKind, type TriggerRegistryBinding } from './trigger-binding.js';
import type { AppEnv } from './types.js';
import type { UsageBinding } from './usage.js';
import type { WaitTokenBinding } from './wait-token-binding.js';
import type { WebhookEndpointBinding } from './webhook-endpoint-binding.js';

/**
 * Assemble the platform HTTP app. Caller-injectable dependencies:
 *
 * - `resolveToken`: `(token) → Promise<{ tenantId, … } | null>`. Caller
 *   plugs in the actual token store — this package doesn't own auth
 *   persistence.
 * - `runHandler`: bridge from `POST /v1/runs` requests into the
 *   agent/flow invocation stack. See `RunHandlerBinding` for shape.
 *
 * The returned app is a plain Hono instance; callers mount it on a
 * server (e.g. `@hono/node-server`) or invoke `.request(...)` directly
 * for tests.
 */
export interface CreateAppInput {
  /**
   * Where the app's records go (`@kindgi/log`): the access line, logged
   * 500s, and what routes log, each with the request's ids. Default:
   * `noopLogger`, so an embedding app stays quiet unless it passes one.
   *
   * An audit record whose append fails, where the request goes on
   * without it, is logged here at `warn`: a secret or env write's, and a
   * secret read refused for its scope, under subsystem `audit`; a
   * sign-in's or sign-out's under `http`. An app without a logger won't
   * see that a record was dropped. A check the authorization model can't
   * answer, a bug in a route, is logged at `error` (subsystem `authz`).
   */
  readonly logger?: Logger;
  readonly resolveToken: TokenResolver;
  readonly runHandler: RunHandlerBinding;
  /**
   * Conversation store binding — openConversation / getConversation /
   * listConversations / listConversationsPage / closeConversation /
   * deleteConversation / appendMessage / readMessages. Every
   * conversation-touching route (conversations, approvals audit
   * bundle, provenance signed export) routes through this binding.
   * The Kindgi runtime supplies an implementation. Required.
   */
  readonly conversationBinding: ConversationBinding;
  /**
   * Run-snapshot store binding — write / read on the run reconstruction
   * envelope. Not called by this package's routes; required so the host
   * can assemble a complete `InvokeAgentBindings` (`@kindgi/agents`)
   * when it constructs the agent-runtime handler. The Kindgi runtime
   * supplies an implementation.
   */
  readonly runSnapshotBinding: RunSnapshotBinding;
  /**
   * Kernel binding (`@kindgi/runtime`) for run lifecycle + scheduler /
   * waitpoint / retention / trigger-registry / event-bus sub-bindings.
   * The Kindgi runtime supplies one (or pass a bespoke implementation).
   *
   * Required — @kindgi/api holds no reference to the kernel
   * itself, so the caller owns the construction.
   */
  readonly kernelBinding: KernelBinding;

  /**
   * Tenant-hierarchy CRUD binding — atomic entity writes + FGA
   * parent/owner tuple emission. Used by the always-mounted
   * `/v1/tenant` route and by `/v1/orgs`, `/v1/teams`, `/v1/projects`
   * when the corresponding platform bindings are supplied. The Kindgi
   * runtime supplies an implementation.
   *
   * Required — same rationale as `kernelBinding`.
   */
  readonly tenantHierarchyBinding: TenantHierarchyBinding;

  /**
   * Memory data-access binding — listFacts / searchByKeyword /
   * searchBySemantic / appendLog / readLog. Every agent-runtime memory
   * read and log write routes through this binding. This package's
   * routes don't call it (conversation transcripts are read through
   * `conversationBinding`). The Kindgi runtime supplies an
   * implementation (or pass a bespoke one).
   *
   * Required — same rationale as `kernelBinding` / `provenanceBinding`.
   */
  readonly memoryBinding: MemoryQueryBinding;

  /**
   * Provenance data-access binding — list summaries + full-DAG reads
   * over stored provenance records. Used by the always-mounted
   * `/v1/provenance` routes. The Kindgi runtime supplies an
   * implementation (or pass a bespoke one).
   *
   * Required — @kindgi/api never touches the provenance schema or
   * domain functions directly, so the caller owns the default
   * construction.
   */
  readonly provenanceBinding: ProvenanceBinding;
  /**
   * Optional authz enforcement config. When present, route handlers get
   * an `Authorizer` (`authorize()` / `can()` / `check()` /
   * `filterByCan()`) backed by `authzCheckBinding`. `principalMiddleware`
   * runs on `/v1/*` either way. When absent (e.g. dev deployments),
   * routes still work but authz is not enforced — bearer + capability
   * gates are the only checks.
   */
  readonly authz?: {
    readonly fgaApiUrl: string;
    /**
     * PDP binding (`@kindgi/authz`) — `check(principal, action,
     * resource, ctx?)` + `checkBatch(...)`. The Kindgi runtime supplies
     * one (or pass a bespoke implementation).
     */
    readonly authzCheckBinding: AuthzCheckBinding;
  };
  /**
   * What a project's flows, agents, triggers and runs may reference
   * (`reference-scope.ts`). When present, a write that names an item its
   * project doesn't reach is refused with `reference-out-of-scope` (400).
   * Absent: references are taken as they are.
   */
  readonly referenceScope?: ReferenceScopeBinding;
  /**
   * Optional unified audit substrate. When present:
   *   - `GET /v1/audit/authz` is mounted (admin@tenant only) as a
   *     view filtered to `kind='authz-decision'`. Those events are
   *     written by the authz check binding (wired to this same sink),
   *     correlated with the request's `x-request-id` — the `Authorizer`
   *     passes it as `correlationId` on every `check()`.
   *   - `/v1/compliance/*` is mounted as a view filtered to
   *     classifier-marked exportable kinds (needs
   *     `complianceClassifier` too).
   *   - Every secret and env write through `/v1/secrets` and `/v1/env` is
   *     recorded at the route (`secret-set`, `secret-rotated`,
   *     `secret-revoked`, `env-set`, `env-deleted`, …): the caller as
   *     `actor`, the request as `correlationId`, never a value.
   * Absent = no durable audit trail; every subsystem's audit
   * writes become no-ops.
   *
   * One write surface — authz decisions and compliance evidence share
   * this single binding.
   */
  readonly auditEvents?: AuditEventBinding;
  /**
   * Optional classification lens over `auditEvents`. Drives which
   * audit-event kinds appear in the `/v1/compliance/*` view and (at
   * export time) which get an Ed25519 signature. Absent =
   * `/v1/compliance/*` is not mounted.
   */
  readonly complianceClassifier?: LoadedClassifier;
  /**
   * Optional compliance-evidence generator. Required when
   * `auditEvents` + `complianceClassifier` are provided (i.e., when
   * `/v1/compliance/*` mounts). The Kindgi runtime supplies the
   * generator (or pass a bespoke implementation). The public interface
   * has recordFromRun / describe; implementations may add
   * more (e.g. subscriptions), which @kindgi/api doesn't use.
   */
  readonly complianceGenerator?: ComplianceEvidenceGenerator;
  /**
   * Optional. When omitted, a per-app in-memory store is used —
   * appropriate for dev + tests, NOT for production (retries after a
   * process restart won't dedupe). Prod deployments pass a persistent
   * store (Postgres, Redis, etc.).
   */
  readonly idempotencyStore?: IdempotencyStore;
  /**
   * Optional. Seals every list's page cursors (`createAeadCursorSealer`
   * with the runtime's pagination key): a cursor then shows nothing of the
   * row it points after, and opens only for the tenant, caller, list and
   * filters it was handed out for, for a day. Absent: cursors are the
   * bindings' own, readable positions.
   */
  readonly cursorSealer?: CursorSealer;
  /**
   * Optional. When present, mounts the API-key routes: `POST /v1/tokens`
   * (mint), `GET /v1/tokens` (list), `GET /v1/tokens/:tokenId` and
   * `POST /v1/tokens/:tokenId/revoke`. Omit if the deployment manages
   * keys out-of-band (e.g. via a separate admin console). Each request on
   * a session token sign-in opened reads its key here, so token sign-in
   * (`session.tokenSignIn`) needs it.
   */
  readonly tokenAdmin?: TokenAdmin;
  /**
   * Optional. When present, mounts `/v1/service-accounts` (tenant admins):
   * create with grants, list, get, grant, ungrant, unregister. Keys for an
   * account are minted at `POST /v1/tokens` with `for`.
   */
  readonly serviceAccountBinding?: ServiceAccountBinding;
  /**
   * Optional. A person's grants under `/v1/identity/users/:userId`:
   * `GET grants` (tenant admins, or the person) and `POST grant|ungrant`
   * (tenant admin; tenant admins only). Without it they answer
   * `501 person-grants-unsupported`. Needs `identityDirectory`.
   */
  readonly personGrants?: PersonGrantsBinding;
  /**
   * Optional. The capabilities a person holds (`env:write`, `secrets:*`,
   * `signing-keys:write`, …), which their sign-in sessions carry: for the
   * writes that need one, and for the keys they mint (`POST /v1/tokens`
   * grants only what the minter holds). Read on each session request.
   * Without it a session carries none, and only API keys hold capabilities.
   */
  readonly personCapabilities?: PersonCapabilitiesBinding;
  /**
   * Optional. What the caller holds, for `GET /v1/identity/me/permissions`:
   * its projects with their roles, its orgs and teams, and what each
   * project role allows, from the authorization model. Without it, that
   * route answers `501 permissions-unsupported`.
   */
  readonly myAccess?: MyAccessBinding;
  /**
   * Optional. When present, mounts the HITL surface:
   *   - `GET /v1/approvals` (list, role-scoped)
   *   - `GET /v1/approvals/:approvalId`
   *   - `POST /v1/approvals/:approvalId/complete`
   *
   * Requires a `ReviewerBinding` because `hitl.submitReview` needs the
   * reviewer's id (not their user id). Deployments plug in the
   * `UserId → ReviewerId` lookup here.
   *
   * Also requires `hitlBinding` — the data-access surface. The Kindgi
   * runtime supplies one (or pass a bespoke implementation); the api
   * package holds no reference to the HITL domain functions.
   */
  readonly reviewerBinding?: ReviewerBinding;
  /**
   * Required alongside `reviewerBinding`. The approvals data-access
   * binding (`getApproval` / `listApprovals` / `submitReview` /
   * `loadReviewDecision`) — `@kindgi/api` never touches the HITL
   * domain functions or their storage directly. The Kindgi runtime
   * supplies an implementation.
   */
  readonly hitlBinding?: HitlBinding;
  /**
   * Runs paused until another system answers (a pack tool that declares
   * `pauses`): the token's link (`POST /v1/wait-tokens/{token}/complete`,
   * no bearer), `POST /v1/runs/{runId}/resume` with a `pause:` waitpoint
   * id, and a suspended run's `waitingFor.tokens`. Absent: the link
   * answers `404 wait-token-not-found`, and the resume route `422
   * run-resume-not-supported`. The Kindgi runtime supplies one. The link
   * limits requests per client, telling clients apart and counting where
   * `webhookReceiver` says (its defaults when it's absent).
   */
  readonly waitTokens?: WaitTokenBinding;
  /**
   * Optional. When present, mounts the reviewer roster sub-resource
   * at `/v1/approvals/reviewers` — list / get / register / unregister.
   * Caller-plugged, same pattern as `agentRegistry`. Distinct from
   * `reviewerBinding` (which resolves a token's `UserId` to a
   * `ReviewerId` for decision routing) so a deployment can wire the
   * two independently.
   */
  readonly reviewerRegistry?: ReviewerRegistryBinding;
  /**
   * Optional. When `true` AND `supervisor` is wired, mounts
   * `GET /v1/observations` (supervisor readback). Both are needed —
   * the flag is the deploy-time opt-in, the binding is the query seam.
   * Without a `supervisor`
   * binding this flag is a no-op.
   */
  readonly enableObservations?: boolean;
  /**
   * Optional. When present, mounts the agents catalog surface
   * (`/v1/agents` list/get/publish, `/v1/agents/:agentId/versions/*`).
   * Same caller-plugged pattern as `TokenAdmin` — the API package does
   * NOT own registry persistence. Deployments plug in any
   * implementation, e.g. one over `@kindgi/agents`' in-memory
   * `AgentRegistry`.
   */
  readonly agentRegistry?: AgentRegistryBinding;
  /**
   * Optional. When present, mounts the flows catalog surface
   * (`/v1/flows` list/get/publish, `/v1/flows/:flowId/versions/*`).
   * Caller-plugged pattern mirrors `agentRegistry` 1:1. Publish
   * validates the wire body via `@kindgi/flow.loadFlow` — a flow
   * published through the API is byte-identical to one constructed
   * in-process. Enables non-agent workflows (webhook processors, ETL
   * jobs, ingest pipelines) via HTTP.
   */
  readonly flowRegistry?: FlowRegistryBinding;
  /**
   * Optional. When present, mounts the tools catalog surface
   * (`/v1/tools` list/get/register/unregister). Caller-plugged
   * pattern mirrors `agentRegistry`. Registration here is metadata-only
   * — handler code is bundled with the runtime or shipped in a signed
   * deployment (`POST /v1/deployments`).
   */
  readonly toolRegistry?: ToolRegistryBinding;
  /**
   * Optional post-write hook fired after a successful tool publish /
   * unregister / reinstate. The caller wires this to invalidate any
   * in-process runtime cache that mirrors the persisted registry
   * (e.g. the runtime's tool bridge, invalidated per tenant).
   * Without it, a re-published tool's schema / description edits
   * are silently ignored until the server process restarts.
   */
  readonly onToolWrite?: import('./routes/tools.js').ToolWriteHook;
  /**
   * Optional. When present, mounts the guardrails catalog surface
   * (`/v1/guardrails` list/get/register/unregister). Caller-plugged
   * pattern mirrors `agentRegistry`. Registration here is metadata-only
   * — the check implementation is bundled with the runtime or shipped
   * in a signed deployment.
   */
  readonly guardrailRegistry?: GuardrailRegistryBinding;
  /**
   * Optional post-write hook fired after a successful guardrail
   * register / unregister. Caller wires this to invalidate any
   * in-process runtime cache that mirrors the persisted registry
   * (e.g. the runtime's guardrail bridge, invalidated per tenant).
   * Without it, a newly-registered guardrail is stored but doesn't
   * reach agent turns until the server process restarts. Same
   * cache-invalidation concern as `onToolWrite` / `onProviderWrite`.
   */
  readonly onGuardrailWrite?: import('./routes/guardrails.js').GuardrailWriteHook;
  /**
   * Checks a guardrail being registered (`POST /v1/guardrails`) against
   * the `configSchema` of the check it names; a problem refuses it with
   * `422 guardrail-config-invalid`. A runtime passes it with the pack
   * checks' schemas from their deployments. Absent: no check.
   */
  readonly checkGuardrailConfig?: import('./routes/guardrails.js').GuardrailConfigCheck;
  /**
   * Optional. When present, mounts the retention surface
   * (`/v1/retention/scheduled`, `/v1/retention/sweep`,
   * `/v1/retention/sweep/:domain`). Caller-plugged; the Kindgi runtime
   * supplies an implementation over its per-domain retention sweeps.
   */
  readonly retention?: RetentionBinding;
  /**
   * Optional. When present, mounts the memory surface
   * (`/v1/memory/facts` list/get/write/supersede, `/v1/memory/retrieve`).
   * Caller-plugged pattern mirrors the other registry bindings — the
   * API package doesn't hardwire an embedding provider or a retrieval
   * policy registry. Deployments plug in a binding that wraps
   * the memory subsystem runtime + their embedding registry.
   */
  readonly memory?: MemoryBinding;
  /**
   * Optional. When present, mounts erasing a person's words
   * (`/v1/memory/erasures`: create, get, list, export, replay), for a
   * tenant admin only. The Kindgi runtime supplies an implementation over
   * its erasure jobs and ledger.
   */
  readonly memoryErasures?: MemoryErasureBinding;
  /**
   * Optional. When present, mounts the supervisor proposals surface
   * (`/v1/proposals` list/get/draft, plus lifecycle actions
   * dry-run / submit-review / apply / rollback / withdraw). Every
   * route requires an `X-Supervisor-Id` request header — the API
   * package doesn't own the supervisor registry, so the binding
   * receives that scope explicitly.
   *
   * The binding wraps the supervisor runtime primitives +
   * the deployment's `AgentRegistry` + `HITL` wiring + eval dataset
   * registry. See `supervisor-binding.ts` for the full contract.
   */
  readonly supervisor?: SupervisorBinding;
  /**
   * Optional. Improvement passes (`POST /v1/proposals/improve`,
   * `/v1/improvement-passes`): the runtime's search for better settings
   * values, written as an improvement proposal. Without it, both answer
   * `501 improve-unsupported`. Mounted with `/v1/proposals`.
   */
  readonly improvementPasses?: ImprovementPassBinding;
  /**
   * Optional. The key the deployment signs its exports with: an
   * approval's audit bundle (`POST /v1/approvals/:approvalId/audit-bundle`),
   * a run's provenance (`POST /v1/provenance/:runId/export`) and
   * compliance evidence (`POST /v1/compliance/evidence/export`). Its
   * public keys are `GET /v1/export-signing-keys`. Each signed export is
   * recorded as an `export-signed` audit event when `auditEvents` is
   * given.
   *
   * Without it (and without `signingKey`), the three exports answer
   * `404 signing-not-configured`; the read routes stay mounted. The API
   * doesn't own key material: a deployment plugs a file key
   * (`createEd25519ExportSigner` in `@kindgi/crypto`) or a KMS-backed
   * binding.
   */
  readonly exportSigning?: ExportSigningBinding;
  /**
   * Optional. Where the deployment's license key stands, worked out on
   * each read: `GET /v1/license`. The deployment's own token reads all of
   * it; where the deployment serves one tenant (`soleTenant`), that
   * tenant's admins read the countdown the console warns with, from 30
   * days before the key expires; anyone else is refused. Without it the
   * route isn't mounted (404), as on a deployment that doesn't report it.
   */
  readonly license?: LicenseStatusBinding;
  /**
   * Optional. How many tenants the runtime serves (default `single`). With
   * `multi`, a tenant's key is never minted holding `kindgi:system`: the
   * operator acts through system keys, which act in no tenant.
   */
  readonly tenancy?: 'single' | 'multi';
  /**
   * Optional. The operator's system keys (`kgi_sy_…`), outside every
   * tenant: `/v1/system/keys`, for the full system capability only.
   * Without it the routes aren't mounted (404). Serving one tenant, they
   * mint keys holding `system:license` alone, for the license renewal, and
   * the deployment's own token reaches them through its resolution's
   * `systemKeysOperator`.
   */
  readonly systemKeys?: SystemKeysBinding;
  /**
   * Optional. Each deployment's own pack service (per-deployment routing):
   * `GET /v1/system/deployments` for whatever runs those services, and,
   * under each tenant, its deployments' endpoint, problem and pack
   * suspension. Only a system principal reaches them, so on a runtime
   * serving one tenant nothing does (its server refuses per-deployment
   * routing there). Mounted only with `systemTenantDirectory` too;
   * without them the routes aren't mounted (404).
   */
  readonly systemDeployments?: SystemDeploymentsOptions;
  /**
   * The record of every request a system principal makes (its key,
   * scope, route and target tenant). Required with `tenancy: 'multi'`;
   * optional otherwise, where the system keys are its only system
   * principals.
   */
  readonly systemAccessAudit?: SystemAccessAuditBinding;
  /**
   * Optional. The tenants a system route can name, and each one's state:
   * what `withSystemTenantContext` checks before a system route acts in a
   * tenant. The tenant routes below need it.
   */
  readonly systemTenantDirectory?: SystemTenantDirectory;
  /**
   * Optional. A tenant's "production allowed" switch and its limits, set by
   * the control plane: `PUT /v1/system/tenants/:tenantId/production-allowed`
   * (`system:tenants:production`) and `…/limits` (`system:tenants:limits`).
   * Mounted only with `systemTenantDirectory` too.
   */
  readonly systemTenantSettings?: SystemTenantSettingsBinding;
  /**
   * Optional. The runtime's tenants, for the operator: `/v1/system/tenants`
   * (create, list, read, close, suspend, the image prefix, the admins'
   * contacts). Mounted only with `systemTenantDirectory` too.
   */
  readonly systemTenants?: SystemTenantsBinding;
  /**
   * Each tenant's state, for freezing a closing or suspended tenant's
   * writes (`tenantStateGate`), on every way in: keys, sessions, SigV4.
   * A closing tenant's webhook deliveries are refused too, and a suspended
   * one's are skipped.
   * Required with `tenancy: 'multi'`; a runtime serving one tenant has none.
   */
  readonly tenantStates?: TenantStateBinding;
  /**
   * Whether a project is suspended (`PUT
   * /v1/system/tenants/{tenantId}/projects/{projectId}/suspended`): a
   * deploy into it, an eval run started in it and an improvement pass for
   * one of its agents are refused `409 project-suspended`, and a webhook
   * delivery to one of its triggers is skipped. Absent: no check.
   */
  readonly projectSuspended?: (
    tenantId: import('@kindgi/types').TenantId,
    projectId: import('@kindgi/types').ProjectId,
  ) => Promise<boolean>;
  /**
   * Each tenant's image repository (`PUT /v1/system/tenants/{id}/image-prefix`),
   * which `POST /v1/deployments` checks before any registry read. With
   * `tenancy: 'multi'` only, where it's required and a tenant without one
   * can't deploy; a runtime serving one tenant ignores it.
   */
  readonly imagePrefixes?: {
    of(tenantId: import('@kindgi/types').TenantId): Promise<string | undefined>;
  };
  /**
   * Optional. Enforce each tenant's own limits (`TenantSummary.limits`,
   * set through `PUT /v1/system/tenants/:tenantId/limits`): API requests a
   * minute on every authenticated request a tenant makes, `/v1` and `/s3`
   * counted together, and webhook deliveries a minute across its triggers.
   * Past either, `429 rate-limit-exceeded` with `Retry-After`; on `/s3`,
   * S3's own `503 SlowDown` with `Retry-After`, which S3 clients retry. A
   * tenant without a limit isn't limited. Without this option, nothing is.
   */
  readonly tenantLimits?: TenantLimitsOptions;
  /**
   * Optional. Usage, aggregated: a tenant's own on `GET /v1/usage` (the
   * projects the caller may read), and the operator's across tenants on
   * `GET /v1/system/usage` (`system:usage:read`). Without it neither route
   * is mounted (404).
   */
  readonly usage?: UsageBinding;
  /**
   * Optional. Issue and accept public run tokens (`kgi_pt_…`):
   * short-lived, read-only tokens a browser uses to follow specific runs
   * (`GET /v1/runs/:runId/progress` and its stream: status and steps, no data). When
   * present, `POST /v1/runs` returns a `publicAccessToken`,
   * `POST /v1/tokens/public` mints them, and `allowedOrigins` get CORS
   * on those two read routes. Checked at startup: the key must be an
   * Ed25519 key in `signingKey`. Use a key for this purpose alone.
   */
  readonly publicRunTokens?: PublicRunTokenConfig;
  /**
   * Optional. When present, mounts the artifacts surface
   * (`/v1/artifacts` list / multipart upload; `/v1/artifacts/:blobId`
   * GET stream / HEAD / DELETE). Caller-plugged pattern mirrors the
   * other registry bindings — the API package doesn't own storage.
   * Deployments plug in a `BlobStorageBinding` implementation, e.g.
   * filesystem-backed for development or object-store-backed in
   * production.
   */
  readonly blobStorage?: BlobStorageBinding;
  /**
   * The most bytes one artifact upload may carry (`POST /v1/artifacts`);
   * more is `413 artifact-too-large`. Also the most one request to the
   * S3-compatible routes may carry (`/s3/*`: an object, or a part of a
   * multipart upload); more is S3's `400 EntityTooLarge`. Default 100 MiB.
   */
  readonly artifactMaxBytes?: number;
  /**
   * Optional. When present, mounts the read-only capabilities catalog
   * surface (`/v1/capabilities` list, `/v1/capabilities/:capabilityId`
   * get). Capabilities are framework-declared (`FEATURES` enum in
   * `@kindgi/capabilities` + `@kindgi/specs/capability.schema.json`) and
   * deployment-extended at boot time via the binding — tenants do NOT
   * author capabilities via HTTP.
   */
  readonly capabilityRegistry?: CapabilityRegistryBinding;
  /**
   * Optional. When present, mounts the model-providers catalog surface
   * (`/v1/providers` list, `/v1/providers/:providerId` get, `POST
   * /v1/providers` register, `POST /v1/providers/:providerId/unregister`,
   * `GET /v1/providers/:providerId/capabilities` sub-resource). Full
   * CRUD — tenants register their own providers. `ProviderMetadata` is
   * the wire shape; secrets never cross the wire (they stay inside the
   * binding).
   */
  readonly providerRegistry?: ProviderRegistryBinding;
  /**
   * Optional post-write hook fired after a successful provider
   * register / unregister. The caller wires this to invalidate any
   * in-process runtime cache that mirrors the persisted registry
   * (e.g. the runtime's provider bridge, invalidated per tenant).
   * Without it, a provider registered after boot is stored but the
   * runtime keeps serving its boot-time snapshot — routing continues
   * to pick whatever was seeded at boot even after the operator
   * registered another provider.
   */
  readonly onProviderWrite?: import('./routes/providers.js').ProviderWriteHook;
  /**
   * Optional. When present, mounts the MCP-endpoint registry surface at
   * `/v1/mcp/endpoints/*` — `GET /v1/mcp/endpoints` (list, cursor-paginated,
   * optional `?transport=` filter), `GET /v1/mcp/endpoints/:endpointId`,
   * `POST /v1/mcp/endpoints` (register), `POST /v1/mcp/endpoints/:endpointId/unregister`.
   * Full CRUD — tenants declare the remote MCP servers they want the
   * runtime to consume. `MCPEndpoint` is the wire shape; its `secretRef`
   * names a secret in the deployment's store, never the credential.
   * The runtime can discover each endpoint's tools at boot and register
   * them into the tool registry under the same tenant.
   */
  readonly mcpEndpointRegistry?: MCPEndpointRegistryBinding;
  /**
   * How far tenant configuration may reach into the server's host
   * (`KINDGI_TENANT_HOST_ACCESS`, see `tenant-host-access.ts`): under
   * `deployed` and `isolated`, registering a stdio MCP endpoint answers
   * `403 host-access-denied`. Default `deployed`; the runtime passes
   * `local` only for a development server.
   */
  readonly tenantHostAccess?: TenantHostAccess;
  /**
   * Optional. Backs the MCP resources + prompts routes, which mount with
   * `mcpEndpointRegistry`:
   * `GET /v1/mcp/endpoints/:endpointId/resources`,
   * `GET /v1/mcp/endpoints/:endpointId/resources/:uri`,
   * `GET /v1/mcp/endpoints/:endpointId/prompts`,
   * `POST /v1/mcp/endpoints/:endpointId/prompts/:name`.
   *
   * A typical implementation opens a fresh MCP client against the
   * endpoint per request, runs the operation, and closes. When absent,
   * the resources + prompts routes 404 with `mcp-endpoint-not-found`.
   */
  readonly mcpClientProbe?: MCPClientProbeBinding;
  /**
   * Optional. When present, mounts the cost readback surface at
   * `/v1/cost/*` — `GET /v1/cost/records` (paginated list with
   * `runId` / `agentId` / `conversationId` / `category` / `providerId` /
   * time-window filters), `GET /v1/cost/records/:recordId` (single),
   * `GET /v1/cost/aggregate` (multi-dimensional rollup over a required
   * time window; default "last 30 days"). Read-only over HTTP —
   * records are written by the runtime's agent / tool / sandbox
   * instrumentation, not through this surface.
   *
   * Budgets are NOT part of this surface.
   */
  readonly cost?: CostBinding;
  /**
   * Optional. When present, mounts the unified adapters catalog surface
   * at `/v1/adapters/*` — `GET /v1/adapters` (paginated list with
   * optional `kind` / `status` filters), `GET /v1/adapters/:adapterId`
   * (single), `POST /v1/adapters/:adapterId/test` (kind-specific smoke
   * probe). Read-only + test-only over HTTP; adapter lifecycle
   * (register / unregister / reconfigure) is a deployment concern
   * — the runtime learns about adapters at `CreateAppInput` time.
   *
   * Deployments implement the binding by aggregating their wired
   * adapters (they know which ones are active because they wire them).
   * See `AdapterRegistryBinding` for the full contract.
   */
  readonly adapterRegistry?: AdapterRegistryBinding;
  /**
   * Optional. In-process factory registry that maps `adapter_id` →
   * factory function + optional `prepare()` for adapter warmup /
   * download. Backs `POST /v1/adapters/:adapterId/prepare` (mounted
   * with `adapterRegistry`) — an SSE endpoint that iterates
   * `entry.prepare()` and streams `PrepareEvent`s to the caller.
   *
   * The runtime builds this at boot alongside the adapter registry so
   * registry entries and in-process factories stay coherent.
   * Deployments without in-process adapter factories (e.g. a custom
   * runHandler) can leave this undefined — the `prepare` route then
   * answers `400 bad-input` for every adapter id.
   */
  readonly adapterFactories?: AdapterFactoryRegistry;
  /**
   * Optional. When present, mounts the trigger admin surfaces at
   * `/v1/schedules/*`, `/v1/event-triggers/*`, and `/v1/webhooks/*`.
   * Kernel runtime primitives (cron/event/webhook schedulers) do the
   * firing; this binding satisfies the CRUD surface over the stored
   * triggers.
   *
   * The Kindgi runtime supplies an implementation. Deployments that
   * want bespoke persistence substitute their own binding.
   */
  readonly triggerRegistry?: TriggerRegistryBinding;
  /**
   * The trigger kinds whose admin surface mounts with `triggerRegistry`:
   * `cron` → `/v1/schedules`, `event` → `/v1/event-triggers`, `webhook` →
   * `/v1/webhooks`, `mail` → `/v1/mail-triggers`. Absent: all four. A
   * runtime that fires only some kinds lists those, so nobody registers a
   * trigger that would never fire.
   */
  readonly triggerKinds?: readonly TriggerKind[];
  /**
   * Optional. Tells a person when a project admin changes, pauses,
   * resumes, fires, deletes or takes over a schedule, webhook or mail
   * trigger they own (the runtime emails them). Called once the change is made,
   * never awaited; a failure is logged. Absent: the change is only
   * audited (`trigger-changed-for-owner`).
   */
  readonly triggerOwnerNotices?: TriggerOwnerNotices;
  /**
   * Optional. When present, mounts the outbound webhook surface at
   * `/v1/webhook-endpoints/*`: endpoints the platform sends signed
   * events to (`run.finished`), their delivery log, redelivery and a test
   * event. The runtime supplies storage, secrets and the sender; see
   * `WebhookEndpointBinding`.
   */
  readonly webhookEndpoints?: WebhookEndpointBinding;
  /**
   * Optional. When present, mounts connections: tools acting with a
   * member's own account at another app, or the company's.
   * `/v1/connection-entries` (the apps this server knows),
   * `/v1/connection-apps/*` (the tenant's registrations, an admin's),
   * `/v1/connections/*` (connections and connect requests), and, outside
   * the bearer chain, `/v1/connection-notices/*` (removals the app
   * reports, rate-limited as `webhookReceiver` says). Needs `envName`: a
   * connection is made under the env this runtime serves. See
   * `ConnectionBinding`.
   */
  readonly connections?: ConnectionBinding;
  /**
   * Optional. When present, mounts the tenant policies catalog surface
   * (`/v1/policies` list/get/publish, `/v1/policies/:policyId/versions/*`).
   * Full versioned CRUD — mirrors `flows` 1:1. Registry-only:
   * enforcement is out of scope. Runtime consumers (e.g. the kernel
   * router for `model-routing`, an adapter-allowlist check for
   * `adapter-allowlist`, retention sweepers for `retention`) read
   * policies from this store and apply them at their own boundary.
   * `policyKind` is enumerated + extensible — new kinds require a spec +
   * validator update in tandem.
   */
  readonly policyRegistry?: PolicyRegistryBinding;
  /**
   * The most a retention policy may keep a domain's tombstoned rows, per
   * domain, in whole seconds (`RetentionLimits`): publishing or
   * reinstating a policy that keeps a limited domain's rows longer, or
   * holds them, is `400 retention-over-limit`. What the runtime's sweep
   * does with the limit is the runtime's (it caps the domain, and applies
   * the limit where no policy covers it). Absent: no limit, any grace.
   */
  readonly retentionLimits?: RetentionLimits;
  /**
   * Optional. When present, mounts the evaluation-suite catalog surface
   * (`/v1/eval-suites` list/get/publish, `/v1/eval-suites/:suiteId/versions/*`).
   * Full versioned CRUD — mirrors `policies` 1:1. Registry-only:
   * eval-run execution + per-kind grader dispatch (eval-judge adapter
   * for `accuracy` / `pairwise` / `regression`, HITL bridge for
   * `human-review`, sandbox handler for `custom`) is out of scope
   * here (see `evalRunBinding`). `evalKind` is enumerated + extensible
   * — new kinds require a spec + validator update in tandem.
   */
  readonly evalSuiteRegistry?: EvalSuiteRegistryBinding;
  /**
   * Data blocks (`/v1/blocks`): versioned prompts and settings that agent
   * versions pin. Mounted when supplied. Authorized through each block's
   * project; the binding writes no authorization tuples.
   */
  readonly blockRegistry?: BlockRegistryBinding;
  /**
   * Optional. When present alongside `evalSuiteRegistry`, mounts the
   * evaluation-run data-plane surface: `POST /v1/eval-suites/:suiteId/runs`
   * (start), `GET /v1/eval-runs` (list, cursor-paginated),
   * `GET /v1/eval-runs/:runId` (get), `POST /v1/eval-runs/:runId/cancel`,
   * `GET /v1/eval-runs/:runId/events` (SSE). Caller-plugged binding —
   * the API package doesn't own eval-run persistence. The reference
   * `createInProcessEvalRunBinding` (`packages/api/src/eval-run-dispatcher.ts`)
   * implements the pattern end-to-end for the `accuracy` kind; a suite
   * of a kind with no registered dispatcher answers
   * `422 dispatcher-not-registered`.
   */
  readonly evalRunBinding?: EvalRunBinding;
  /**
   * Optional. Mounts judgments, yes or no with an optional reason about
   * one item of a run's output (`/v1/judgments`), and the judge classes
   * they're recorded under, each with a weight (`/v1/judge-classes`).
   * Caller-plugged: the API package doesn't own their storage.
   */
  readonly judgmentRegistry?: JudgmentRegistryBinding;
  /**
   * Optional. A project's judging rules and the queue they fill, under
   * `/v1/projects/:projectId/judging-rules` and `…/judging-queue`: which
   * runs need a person's judgment. Without it, those routes aren't
   * mounted.
   */
  readonly judgingQueue?: JudgingQueueBinding;
  /**
   * Optional. With `evalSuiteRegistry` and `judgmentRegistry`, mounts test
   * sets built from judgments: `POST /v1/eval-suites/:suiteId/versions/from-judgments`
   * and `GET /v1/eval-suites/:suiteId/versions/:version/cases`.
   */
  readonly evalCaseStore?: EvalCaseStoreBinding;
  /**
   * Optional. Live versions of agents per scope, and their promotions
   * (`/v1/agents/{id}/live`, `/live-versions`, `/promotions`,
   * `/live/rollback`, `/live/unpin`). Absent → a run takes the latest
   * version, as before.
   */
  readonly agentReleases?: AgentReleaseBindings;
  /**
   * Optional. Push-based pub/sub binding used by SSE endpoints to
   * deliver run events without polling. When present, `GET
   * /v1/runs/:runId/stream` subscribes on channel
   * `kernel:run:<runId>` and delivers push-mode; when absent, the
   * route falls back to a 200 ms journal poll — wire shape identical
   * either way, so callers can't tell.
   *
   * The Kindgi runtime supplies an implementation. Wire the same bus
   * into the kernel behind `CreateAppInput.runHandler` so the kernel
   * publishes on each journal write; without that, the subscription
   * receives nothing (the kernel never posts).
   *
   * See `packages/api/src/event-bus-binding.ts` for the contract.
   */
  readonly eventBus?: EventBusBinding;
  /**
   * Optional. When present alongside `blobStorage`, mounts the
   * AWS S3-compat wire surface at `/s3/*`. SigV4-authenticated
   * per request against the credentials this binding resolves. Requests
   * for buckets the credential is not authorized for return
   * `403 AccessDenied`. Storage flows through the same
   * `BlobStorageBinding` as the bespoke `/v1/artifacts/*` surface —
   * cross-surface interop is a first-class guardrail. Includes the
   * S3 multipart-upload operations (initiate / upload part / complete /
   * list parts / abort). A request's body is at most `artifactMaxBytes`.
   */
  readonly s3Credentials?: S3CredentialBinding;
  /**
   * Optional. When present, mounts the session persistence surface.
   * Combined with `identityProvider` (below), this activates the
   * `/v1/auth/*` route family. The static
   * bearer-token flow remains available on the same routes byte-
   * shape-identical; the middleware detects `kgi_sk_*` prefixed
   * tokens and routes them through this store.
   *
   * Caller-plugged — the API package does NOT own session persistence.
   * The Kindgi runtime supplies a durable implementation; deployments
   * can also plug in their own (Redis, SQLite, memory, etc.).
   */
  readonly sessionStore?: SessionStoreBinding;
  /**
   * Optional. When present, tunes session-token lifecycle enforcement
   * in the auth middleware. Absent → sensible defaults (absolute TTL
   * from the stored session's `expiresAt`; inactivity timeout disabled).
   * Only applies to `kgi_sk_*` session tokens; static bearer tokens are
   * unaffected.
   */
  readonly session?: SessionConfig;
  /**
   * Optional. When present alongside `sessionStore`, mounts the
   * identity-provider catalog, refresh and logout at `/v1/auth/*`. Sign-in
   * itself runs in the deployment (its browser flow), which reads the
   * catalog.
   *
   * Deployments register their OIDC and SAML providers at boot (or via
   * `POST /v1/auth/providers`); the framework does NOT bake in a
   * provider list.
   */
  readonly identityProvider?: IdentityProviderBinding;
  /**
   * Who may add, change and remove the tenant's identity providers:
   * `tenant` (default) its admins; `operator` only the deployment's own
   * token (`kindgi:system`), for a deployment whose operator manages
   * sign-in. Changes answer `403 identity-providers-operator-managed`
   * otherwise; reads and sign-in are unchanged.
   */
  readonly identityProviderChanges?: 'tenant' | 'operator';
  /**
   * Optional. A person's second factor and the tenant's setting that
   * requires one at sign-in: mounts `/v1/identity/me/second-factor*` (the
   * person's own, from a session), `/v1/identity/users/:userId/second-factor*`
   * (tenant admins) and `/v1/auth/settings` (tenant admins). With it, token
   * sign-in is refused in a tenant that requires one (`403
   * second-factor-required`). Holding sessions to the setting is the
   * session store's (`resolveToken`).
   */
  readonly secondFactor?: SecondFactorBinding;
  /**
   * The deployment's public base URL (e.g. `https://kindgi.acme.example`):
   * what a webhook trigger's `receiveUrl` is made from. Never taken from a
   * request's `Host`, which the caller writes. Absent: webhook trigger
   * records carry no `receiveUrl`, and the CLI says how to set one.
   */
  readonly publicUrl?: string;
  /**
   * Mounts the inbound receiver, `POST /v1/hooks/{tenantId}/{webhookId}`
   * (outside the bearer chain), when `triggerRegistry` serves webhook
   * triggers (with `findWebhook`, `fireWebhook` and
   * `recordWebhookRefusal`) and `secretsBinding` is set: a signed request
   * starts the trigger's flow as its owner. `envName` is the env this
   * deployment serves, where each trigger's signing secret is read.
   */
  readonly webhookReceiver?: {
    readonly envName: import('@kindgi/types').EnvName;
    /**
     * Who the client is (for the per-client refusal limit and the audit
     * record, and the wait token link's per-client limit); `undefined`
     * when clients can't be told apart, which turns the per-client limits
     * off.
     */
    readonly clientAddress?: (request: Request) => string | undefined;
    /** Where the counts live, the wait token link's too; default this process's memory. */
    readonly rateLimitStore?: RateLimitStore;
  };
  /**
   * Sites that sign their own people in to one project (`SiteBinding`).
   * Mounts `/v1/projects/{projectId}/sites` (tenant admins) and, outside
   * the bearer chain, `POST /v1/auth/sites/enroll` and
   * `POST /v1/auth/site-sign-in`. Absent: none of them is mounted. A
   * deployment wires it only with authorization enforced (`authz`) and a
   * session store with `revokeByProvider`: `createApp` throws without
   * either. `clientAddress` defaults to the nearest X-Forwarded-For hop.
   */
  readonly sites?: {
    readonly binding: SiteBinding;
    /**
     * Who the client is, for the binding's limit on failures per address.
     * The default, the nearest `X-Forwarded-For` hop, fits only behind a
     * proxy that writes that header: without one every client shares one
     * bucket, and the header is the caller's to set. A runtime exposed
     * directly passes its own (the socket's address, or the address past
     * its trusted proxies).
     */
    readonly clientAddress?: (request: Request) => string | undefined;
  };
  /**
   * The rate limit on `GET /v1/auth/sign-in-options` (unauthenticated):
   * lookups with an email per client per window, and how to tell clients
   * apart. A read without an email (the same for everyone) isn't counted.
   * Default: 30 a minute, per nearest (rightmost) `X-Forwarded-For` hop.
   */
  readonly signInOptionsRateLimit?: SignInOptionsRateLimit;
  /**
   * The emailed sign-in link, when the deployment offers it (it serves the
   * link itself): sign-in options say so, with the captcha's site key.
   */
  readonly signInEmailLink?: {
    readonly captchaSiteKey?: string;
    /** Whether the link is offered for an email's domain. Absent: every domain. */
    readonly allowedFor?: (emailDomain: string) => Promise<boolean>;
  };
  /**
   * The deployment's terms and privacy policy, which a sign-in page links
   * (sign-in options' `legal`): each an absolute https URL with no username
   * or password, each on its own; anything else, and createApp throws. The
   * answer carries each as a browser reads it. Absent, or neither set: the
   * answer has no `legal`.
   */
  readonly signInLegal?: SignInLegalLinks;
  /**
   * The deployment's own links (its help desk, status page, data
   * processing terms), which the console shows on every page, the sign-in
   * page too (sign-in options' `links`), in this order. At most 8; each
   * label 1 to 40 characters once trimmed, with no control or format
   * character, and no other link's once trimmed; each URL an absolute
   * https URL with no username or password. Anything else, and createApp
   * throws. Absent or empty: the answer has no `links`.
   */
  readonly consoleLinks?: readonly ConsoleLink[];
  /**
   * Optional. Signed-deployment ledger — the audit anchor for every
   * `POST /v1/deployments` landing. Caller-plugged per the pattern
   * (e.g. in-memory for tests, a durable store in production). Mount
   * happens only when this + `signingKeyRegistry` + `imageRegistry` are
   * ALL wired.
   */
  readonly deploymentRegistry?: DeploymentBinding;
  /**
   * Optional. Tenant-scoped signing-key trust registry.
   * Higher-level than `SigningKeyBinding` (which is
   * KMS-shaped): answers "for tenant T, is this public key allowed to
   * sign deploys?" and performs signature verification against the
   * registered trust list. Aliased on import to avoid the local name
   * collision with the crypto binding.
   */
  readonly signingKeyRegistry?: SigningKeyRegistryBinding;
  /**
   * Optional. OCI image registry client — Docker
   * Registry HTTP API v2 seam. The deploy route calls `head` + one
   * `extractFile('/app/index.json')` to verify pullability + integrity;
   * `push` is for build tooling, not the API routes. Caller-plugged
   * so deployments route different tenants at different registries.
   */
  readonly imageRegistry?: ImageRegistryBinding;
  /**
   * Optional. When present, mounts the tenant-scoped identity
   * directory surface (`/v1/identity/users` list/get,
   * `/v1/identity/users/:userId/sessions` list-active,
   * `/v1/identity/users/:userId/revoke-sessions` admin op,
   * `/v1/identity/whoami` self) — part of the admin control plane.
   * Registry-only over HTTP; deployments plug in an
   * LDAP / SCIM / bespoke user store behind
   * `IdentityDirectoryBinding`. `whoami` returns the fuller
   * `UserRecord` shape when the binding is wired and the token
   * carries a `userId`; otherwise it falls back to the minimal
   * `{ tenantId, ... }` shape.
   */
  readonly identityDirectory?: IdentityDirectoryBinding;
  /**
   * Optional. Overrides the default `info` + `servers` in the emitted
   * OpenAPI document (`GET /v1/openapi.json`) and — via the `docs`
   * sub-config — opts the deployment into an interactive Scalar-rendered
   * API reference UI. Deployments typically set `servers[0].url` to their
   * public base URL.
   */
  readonly openapi?: OpenApiConfig;
  // ---------- platform hierarchy ----------
  /**
   * Optional. When present, mounts the `/v1/orgs` resource surface
   * (list/create/get/patch/delete) of the multi-tenant hierarchy.
   * Caller-plugged: the reference in-memory implementation is
   * `makeInMemoryOrgBinding` in `@kindgi/platform`; the Kindgi runtime
   * supplies a durable one.
   */
  readonly orgBinding?: OrgBinding;
  /**
   * Optional. When present, mounts the `/v1/teams` resource surface —
   * team CRUD plus `/v1/teams/:teamId/memberships` sub-resource. Both
   * `teamBinding` AND `teamMembershipBinding` MUST be supplied together
   * (otherwise `/v1/teams` is not mounted) — the reference
   * in-memory adapter returns them as a combined `{teams, memberships}`
   * factory, and durable implementations mirror that shape.
   */
  readonly teamBinding?: TeamBinding;
  readonly teamMembershipBinding?: TeamMembershipBinding;
  /**
   * Optional. When present, mounts the `/v1/projects` resource surface —
   * project CRUD (including `/v1/projects/default`) plus
   * `/v1/projects/:projectId/memberships` sub-resource. Both
   * `projectBinding` AND `projectMembershipBinding` MUST be supplied
   * together — same combined-factory pattern as teams.
   */
  readonly projectBinding?: ProjectBinding;
  readonly projectMembershipBinding?: ProjectMembershipBinding;
  /**
   * Optional. The team↔project grant binding. With `projectBinding` and
   * `teamBinding`, it mounts `/v1/projects/:projectId/team-grants` and
   * `/v1/teams/:teamId/project-grants`. With an authorizer, writes go
   * through the tenant-hierarchy binding (row and tuple together).
   */
  readonly teamProjectGrantBinding?: TeamProjectGrantBinding;
  /**
   * Optional. Who has access to a project and how
   * (`GET /v1/projects/:projectId/access`), read from the authorization
   * store. Without it, that route answers `501 project-access-unsupported`.
   */
  readonly projectAccess?: ProjectAccessBinding;
  /**
   * Optional. The production gate (`PUT /v1/projects/:projectId/production`):
   * `gate` checks the tenant's `productionAllowed` before a project goes
   * into production (`KINDGI_PRODUCTION_GATE=on`), and `next` names where a
   * tenant that isn't allowed goes (`KINDGI_PRODUCTION_NEXT_URL`; the
   * refusal's `details.next`). Absent: no gate.
   */
  readonly production?: ProductionGateOptions;
  /**
   * Optional. The addresses this deployment's calls to other sites come
   * from (`KINDGI_EGRESS_SERVER_ADDRESSES`,
   * `KINDGI_EGRESS_DEPLOYMENT_ADDRESSES`), for a site that admits only
   * known addresses: `GET /v1/tenant`'s `egress`, the same for every
   * tenant. Each entry is an IPv4 or IPv6 address; another value throws
   * here. Absent, or both lists empty: no `egress`.
   */
  readonly egress?: EgressAddresses;
  /**
   * Optional. Non-sensitive per-env values. When present alongside or
   * separately from `secretsBinding`, mounts the `/v1/tenant/config`
   * sub-routes at tenant scope. The base `GET /v1/tenant` route is
   * always mounted; the `/config` surface is gated on at least one of
   * `envBinding` / `secretsBinding` being present.
   */
  readonly envBinding?: EnvBinding;
  /**
   * What a deployment's values check reads that only the runtime knows
   * (`deployment-values.ts`): where a model provider's key is for a run in
   * a project, and the pack service's own env. The check reads env values
   * through `envBinding` and the providers through `providerRegistry`.
   * Each one absent isn't checked.
   */
  readonly deploymentValues?: Pick<DeploymentValuesDeps, 'modelKeyLookup' | 'packEnv'>;
  /**
   * Optional. Sensitive per-env values. Same mount rule as
   * `envBinding` — either binding present is enough to mount
   * `/v1/tenant/config`. Writes to `/v1/tenant/config` with
   * `sensitive: true` (or `kind: 'secret'`) route to this binding; the
   * routes 400 when a secret write is attempted but this binding is
   * absent.
   *
   * When present, ALSO mounts `/v1/secrets/*` — the dedicated
   * secrets HTTP surface. Same for `envBinding` and `/v1/env/*`.
   * Either one mounts `GET /v1/environments`, the env names the two
   * hold (`listEnvNames`).
   */
  readonly secretsBinding?: SecretBinding;
  /**
   * Optional. The order a tenant runs a project through on its way to live
   * — its "environments". When present, mounts `/v1/environment-orders`,
   * and a later environment of an order refuses deploys, API publishes and
   * derived agent versions (`409 environment-takes-promotions`,
   * `environment-entry.ts`): it takes builds by promotion only.
   * The host application supplies it; `@kindgi/api` never constructs one.
   */
  readonly environmentOrders?: EnvironmentOrderBinding;
  /**
   * Optional. Which projects serve each agent, flow, eval suite, tool,
   * guardrail and block. An item more than one project serves is governed
   * by rights on those projects (`item-rights.ts`), not by the project it
   * was first published in. Without `authz` there are no rights to ask,
   * but it still decides which version `?projectId=` answers on a single
   * read. Absent: every item has one project, and every check is the
   * item's own. The host application supplies it.
   */
  readonly itemProjects?: ItemProjectsBinding;
  /**
   * The env this deployment serves (`KINDGI_ENV`): where the secrets a
   * tool's code declares are looked for when the tool is published, to
   * record where they're read (`secret-scope.ts`). Absent: the webhook
   * receiver's; with neither, each is recorded at the broadest scope its
   * registrant administers, without a lookup.
   */
  readonly envName?: import('@kindgi/types').EnvName;
  /**
   * This runtime is the only reader of its stores and keeps every value
   * under the env it serves (`envName`). A secret or
   * env value set under another env, and a provider, MCP endpoint or webhook
   * endpoint that names its secret under another, answers `409
   * env-not-served` (`served-env.ts`). whoami's `servedEnv` says so, for
   * clients to default to it. Needs `envName` (or the webhook receiver's).
   * Absent or false: any env, as before.
   */
  readonly refuseOtherEnvs?: boolean;
  /**
   * Optional. Backs the async-rotation wire (`POST /v1/secrets/:name/rotate`
   * → 202 Accepted; poll via `GET /v1/secrets/:name/rotations/:rotationId`;
   * subscribe via `GET /v1/secrets/:name/rotations/:rotationId/events`).
   * When `secretsBinding` is present AND this is absent, a per-app
   * in-memory reference store is used — appropriate for dev + tests
   * only; multi-pod production deployments MUST plug in a durable
   * adapter (rotations can take minutes to hours; the row must
   * survive process restarts and reach pods handling later polls /
   * subscribes).
   */
  readonly rotationStatusStore?: RotationStatusStore;
}

/**
 * OpenAPI configuration. Extends `GenerateOptions` (info + servers) with
 * an optional `docs` sub-config that opts the deployment into mounting
 * an interactive Scalar-rendered API reference UI alongside the JSON
 * spec at `/v1/openapi.json`.
 *
 * `docs` is opt-in (default off). Deployments that want the docs UI set
 * `docs: true` (mounts at `/docs`) or `docs: { path: '/reference' }` for
 * a custom mount path.
 */
export interface OpenApiConfig extends GenerateOptions {
  /**
   * When set, mounts a Scalar-rendered interactive API reference UI
   * that reads from `GET /v1/openapi.json`. Pass `true` for defaults
   * (mounted at `/docs`, default theme, page title from the OpenAPI
   * `info.title`) or an object to customize the mount path / title /
   * theme. Absent = docs UI not mounted.
   */
  readonly docs?: boolean | ScalarDocsConfig;
}

/**
 * Session lifecycle configuration. All fields optional; defaults keep
 * the baseline behavior (absolute TTL from the stored session's
 * `expiresAt`, inactivity enforcement disabled). Only applies to
 * `kgi_sk_*` session tokens; static bearer tokens are unaffected.
 * Milliseconds throughout — compared against `Date.now()` on the hot
 * path.
 */
export interface SessionConfig {
  /**
   * Recommended default for deployment-issued sessions. The framework
   * itself uses the provider's `expiresAt` verbatim on OAuth callback;
   * this default surfaces only when a downstream helper opts into it.
   * 24h = `24 * 60 * 60 * 1000`.
   */
  readonly ttl?: number;
  /**
   * Inactivity timeout — requests whose session `lastActiveAt` is older
   * than `Date.now() - inactivityTimeout` receive `401 session-inactive`.
   * Absent → inactivity enforcement disabled. Recommended: 4 hours.
   */
  readonly inactivityTimeout?: number;
  /**
   * How often the middleware calls `sessionStore.touch()` to bump
   * `lastActiveAt`. Defaults to 60_000 ms. Higher values ⇒ fewer writes
   * but coarser inactivity enforcement.
   */
  readonly touchThrottle?: number;
  /**
   * Browser sessions in a cookie: the middleware reads the session token
   * from it when a request has no `Authorization` header, and refuses a
   * cookie-authenticated unsafe request whose `Origin` isn't allowed
   * (403 `csrf-origin-mismatch`). Absent → session tokens come only in
   * the `Authorization` header.
   */
  readonly cookie?: SessionCookieOptions;
  /**
   * Whether a person may sign in to the console with an API token
   * (`POST /v1/auth/token-sign-in`): a person's full key is exchanged once
   * for a browser session in `cookie`. Needs `cookie`, a session store and
   * `tokenAdmin`: each request on such a session reads its key, so the
   * session ends when the key is revoked. Absent or `false`, or without
   * those: the route answers 403 `token-sign-in-off`, and
   * `GET /v1/auth/sign-in-options` says it's off.
   */
  readonly tokenSignIn?: boolean;
}

/**
 * Optional overrides for the Scalar-rendered docs UI. All fields are
 * optional; sensible defaults are applied.
 */
export interface ScalarDocsConfig {
  /** Mount path. Default: `/docs`. */
  readonly path?: string;
  /** Browser tab title. Default: `Kindgi API`. */
  readonly title?: string;
  /**
   * Scalar theme name — string-typed so it stays open to whatever
   * themes Scalar ships without a version-lock. Default: Scalar's
   * built-in default theme.
   */
  readonly theme?: string;
}

/** A token sign-in's session lifetime when `SessionConfig.ttl` is unset: 12 hours. */
const DEFAULT_TOKEN_SIGN_IN_TTL_MS = 12 * 60 * 60 * 1000;

export function createApp(input: CreateAppInput): Hono<AppEnv> {
  // A frozen tenant stays frozen whatever way it comes in: the gate needs to know.
  if (input.tenancy === 'multi' && input.tenantStates === undefined) {
    throw new Error(
      "createApp: a runtime serving many tenants needs tenantStates, so a closing or suspended tenant's writes are refused",
    );
  }
  // Each tenant deploys only its own images there: the check needs to know them.
  if (
    input.tenancy === 'multi' &&
    input.deploymentRegistry !== undefined &&
    input.imagePrefixes === undefined
  ) {
    throw new Error(
      'createApp: a runtime serving many tenants needs imagePrefixes, so a tenant deploys only images in its own repository',
    );
  }
  // The operator's requests are on record wherever the operator acts in no
  // tenant: the access procedure and the processing terms rely on it.
  if (input.tenancy === 'multi' && input.systemAccessAudit === undefined) {
    throw new Error(
      "createApp: a runtime serving many tenants needs systemAccessAudit, the record of every request the operator's system keys make",
    );
  }
  // A limit that isn't one would refuse every policy, or none.
  for (const [domain, limit] of Object.entries(input.retentionLimits ?? {})) {
    if (domain === '*' || !(RETENTION_DOMAINS as readonly string[]).includes(domain)) {
      throw new Error(
        `createApp: retentionLimits names "${domain}", which isn't a retention domain (one of ${RETENTION_DOMAINS.filter((d) => d !== '*').join(', ')})`,
      );
    }
    if (!Number.isSafeInteger(limit?.seconds) || (limit?.seconds ?? 0) < 1) {
      throw new Error(
        `createApp: retentionLimits.${domain}.seconds must be a whole number of seconds, 1 or more (got ${String(limit?.seconds)})`,
      );
    }
  }
  // Every secret route and reader goes through one binding, whose writes
  // the webhook receiver hears: it keeps a trigger's signing key for a few
  // seconds, and drops it at once when its secret is written here.
  const observedSecrets =
    input.secretsBinding === undefined ? undefined : observeSecretWrites(input.secretsBinding);
  const secretsBinding = observedSecrets?.binding;
  // A cookie session's value is the token the store minted. A store that
  // can't resolve its own tokens would put the session id there instead,
  // and the id is no secret (whoami and the audit trail show it).
  if (
    input.session?.cookie !== undefined &&
    input.sessionStore !== undefined &&
    input.sessionStore.resolveToken === undefined
  ) {
    throw new Error(
      'Cookie sessions need a session store that resolves its own tokens (`resolveToken`): without it, the session id would be the credential.',
    );
  }
  const app = new Hono<AppEnv>();

  const runBinding = input.kernelBinding.run;
  const exportSigning = input.exportSigning;
  const exportOptions = {
    ...(exportSigning !== undefined && { exportSigning }),
    ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
  };

  // ---------- global middleware ----------
  app.use('*', requestIdMiddleware());
  // The request's trace context and logger, and its access line.
  app.use('*', requestLogMiddleware(input.logger ?? noopLogger));
  // An upload is read under its own limit, once the caller is known
  // (`readBodyOnce`); every other body under the API's, before anything.
  const ownBodyLimits: readonly OwnBodyLimit[] = [
    {
      method: 'POST',
      path: '/v1/artifacts',
      limit: artifactUploadLimit(input.artifactMaxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES),
    },
  ];
  app.use('*', requestBodyLimit(ownBodyLimits));
  // No `/v1` answer is kept by a browser or a proxy (data and errors alike).
  app.use('/v1/*', noStoreMiddleware());
  // A thrown exception: a 500 wire error with its message and request id, logged.
  app.onError(mapThrownError);

  // Public run tokens: checked once at startup; CORS for the two routes
  // they can call, ahead of authentication so preflights pass.
  const publicRunTokens = input.publicRunTokens;
  const publicRunTokenLimits =
    publicRunTokens !== undefined ? resolvePublicRunTokenConfig(publicRunTokens) : undefined;
  const mintPublicRunTokenFor = (
    tenantId: import('@kindgi/types').TenantId,
    runIds: readonly import('@kindgi/types').RunId[],
    ttlSeconds: number,
  ) =>
    mintPublicRunToken({
      signingKey: (publicRunTokens as PublicRunTokenConfig).signingKey,
      keyId: (publicRunTokens as PublicRunTokenConfig).keyId,
      tenantId,
      runIds,
      ttlSeconds,
    });
  if (publicRunTokens?.allowedOrigins !== undefined && publicRunTokens.allowedOrigins.length > 0) {
    app.use('/v1/*', publicRunCorsMiddleware(publicRunTokens.allowedOrigins));
  }

  // ---------- public routes ----------
  app.get('/health', (c) => c.json({ ok: true }));
  // The spec document is public (per API-ROUTE-CONVENTIONS.md §2.2) so
  // it's mounted before the /v1/* auth chain rather than inside it.
  const openApiDoc = generateOpenApiDocument(input.openapi ?? {});
  app.get('/v1/openapi.json', (c) => c.json(openApiDoc));

  // Optional Scalar-rendered interactive API reference UI. Opt-in via
  // `openapi.docs`; when absent the docs path is unmounted (404). Also
  // public — the reference reads the (already-public) `/v1/openapi.json`
  // in the browser, so it doesn't need to sit inside the bearer chain.
  if (input.openapi?.docs !== undefined && input.openapi.docs !== false) {
    const docsConfig: ScalarDocsConfig = input.openapi.docs === true ? {} : input.openapi.docs;
    const docsPath = docsConfig.path ?? '/docs';
    app.get(
      docsPath,
      Scalar({
        url: '/v1/openapi.json',
        pageTitle: docsConfig.title ?? 'Kindgi API',
        ...(docsConfig.theme !== undefined && {
          theme: docsConfig.theme as never,
        }),
      }),
    );
  }

  // ---------- authenticated `/v1/*` routes ----------
  const v1 = new Hono<AppEnv>();
  const sessionCfg = input.session;
  const inactivityTimeoutMs = sessionCfg?.inactivityTimeout;
  v1.use(
    '*',
    bearerAuthMiddleware(input.resolveToken, {
      ...(publicRunTokens !== undefined && {
        publicRunTokens: {
          signingKey: publicRunTokens.signingKey,
          isAllowed: publicRunRouteMatcher(),
        },
      }),
      ...(input.sessionStore !== undefined && { sessionStore: input.sessionStore }),
      ...(input.personCapabilities !== undefined && {
        personCapabilities: input.personCapabilities,
      }),
      ...(input.tokenAdmin !== undefined && { apiKeys: input.tokenAdmin }),
      ...(inactivityTimeoutMs !== undefined && { inactivityTimeoutMs }),
      ...(sessionCfg?.touchThrottle !== undefined && {
        touchThrottleMs: sessionCfg.touchThrottle,
      }),
      ...(sessionCfg?.cookie !== undefined && { sessionCookie: sessionCfg.cookie }),
    }),
  );
  // Principal construction — runs after bearer so it can read the
  // resolved tenantId/userId/sessionId. If `authz` is not configured,
  // still populate the principal (cheap, and lets `can`/`check` work
  // as inspection helpers even when authorize() enforcement is off).
  v1.use('*', principalMiddleware());
  // From here on, the request's records carry its tenant.
  v1.use('*', async (c, next) => {
    const tenantId = c.get('tenantId');
    if (tenantId !== undefined) c.set('log', c.get('log').child({ tenantId }));
    await next();
  });
  // And its work is the tenant's: a schema it compiles again counts
  // against the tenant's compile budget.
  v1.use('*', tenantScopeMiddleware());
  const authorizer: Authorizer | undefined =
    input.authz !== undefined ? createAuthorizer(input.authz.authzCheckBinding) : undefined;
  // Rights on an item more than one project serves (`item-rights.ts`).
  const itemRights = itemRightsOf(authorizer, input.itemProjects, input.environmentOrders);
  // With no authorizer, which projects serve an item still decides what
  // `?projectId=` answers on its single read.
  const itemServing =
    input.itemProjects !== undefined ? itemServingOf(input.itemProjects) : undefined;
  // A system principal acts in no tenant: it reaches /v1/system/* (and the
  // deployment's license), nothing else, and each of its requests is recorded.
  v1.use(
    '*',
    systemPrincipalFence({
      ...(input.systemAccessAudit !== undefined && { audit: input.systemAccessAudit }),
      ...(authorizer !== undefined && { authorizer }),
      ...(input.tenancy !== undefined && { tenancy: input.tenancy }),
    }),
  );
  // A closing or suspended tenant reads, exports and deletes; nothing else.
  v1.use('*', tenantStateGate(input.tenantStates));
  // A write's body is read once, as the bytes it came with, before
  // anything parses it: the checks below, idempotency and the route all
  // read that copy. An upload is read under its own size limit, any
  // other body under the API's.
  v1.use('*', readBodyOnce(ownBodyLimits));
  // A JSON body nested past the bounds is refused before anything walks
  // it. An upload's body isn't JSON, and neither check reads it as JSON.
  v1.use('*', refuseDeepJson(ownBodyLimits));
  // A key limited to a project names no other one.
  v1.use('*', refuseOtherProjectForKey(authorizer, ownBodyLimits));
  // Page cursors are sealed at the edge, for every list.
  if (input.cursorSealer !== undefined) v1.use('*', sealedCursors(input.cursorSealer));

  const tenantHierarchyBinding: TenantHierarchyBinding = input.tenantHierarchyBinding;
  // Each tenant's own limits, when the runtime sets them.
  const tenantLimiter =
    input.tenantLimits !== undefined
      ? createTenantLimiter(tenantHierarchyBinding, input.tenantLimits)
      : undefined;
  if (tenantLimiter !== undefined) v1.use('*', tenantApiRequestLimit(tenantLimiter));
  v1.use('*', idempotencyMiddleware(input.idempotencyStore ?? createInMemoryIdempotencyStore()));
  // A `projectId` in a write's body that the route can't use is refused
  // before any binding sees it: a 400 if it isn't a UUID, a 404 if it
  // names no project (T247).
  const projectRef = refuseBadProjectId(input.projectBinding);
  for (const path of PROJECT_REF_ROUTES) v1.use(path, projectRef);
  v1.route(
    '/runs',
    runsRouter(
      input.runHandler,
      runBinding,
      {
        ...(input.eventBus !== undefined && { eventBus: input.eventBus }),
        ...(input.hitlBinding !== undefined && { hitl: input.hitlBinding }),
        ...(input.connections !== undefined && { connections: input.connections }),
        ...(input.waitTokens !== undefined && { waitTokens: input.waitTokens }),
        ...(input.referenceScope !== undefined && { referenceScope: input.referenceScope }),
        ...(itemRights !== undefined && { itemRights }),
        ...(input.agentRegistry !== undefined &&
          input.flowRegistry !== undefined && {
            targetExists: async (tenantId, target) =>
              target.kind === 'agent'
                ? (await input.agentRegistry?.get({ tenantId, agentId: target.id as never })) !==
                  null
                : (await input.flowRegistry?.get({ tenantId, flowId: target.id as never })) !==
                  null,
          }),
        // Who a turn runs as, for the participant rule (`participantRefusal`).
        ...participantLookups(input),
        ...(publicRunTokenLimits !== undefined && {
          publicRunTokens: {
            mint: (tenantId, runIds) =>
              mintPublicRunTokenFor(tenantId, runIds, publicRunTokenLimits.defaultTtlSeconds),
          },
        }),
      },
      authorizer,
    ),
  );
  v1.route(
    '/conversations',
    conversationsRouter(
      input.conversationBinding,
      runBinding,
      input.projectBinding,
      authorizer,
      input.referenceScope,
      input.agentRegistry,
      itemRights,
    ),
  );
  if (publicRunTokenLimits !== undefined) {
    v1.route(
      '/tokens/public',
      publicRunTokensRouter(
        runBinding,
        { mint: mintPublicRunTokenFor, ...publicRunTokenLimits },
        authorizer,
      ),
    );
  }
  if (input.tokenAdmin !== undefined) {
    v1.route(
      '/tokens',
      tokensRouter(input.tokenAdmin, authorizer, {
        ...(input.tenancy !== undefined && { tenancy: input.tenancy }),
      }),
    );
  }
  if (input.serviceAccountBinding !== undefined) {
    v1.route('/service-accounts', serviceAccountsRouter(input.serviceAccountBinding, authorizer));
  }
  // Mount the reviewer roster sub-resource BEFORE the approvals router
  // so `/v1/approvals/reviewers/*` resolves here rather than being
  // captured by the `:approvalId` param on the approvals router.
  if (input.reviewerRegistry !== undefined) {
    v1.route(
      '/approvals/reviewers',
      reviewersRouter(input.reviewerRegistry, authorizer, input.reviewerBinding),
    );
  }
  if (input.reviewerBinding !== undefined && input.hitlBinding !== undefined) {
    v1.route(
      '/approvals',
      approvalsRouter(
        input.conversationBinding,
        input.reviewerBinding,
        input.hitlBinding,
        runBinding,
        {
          ...exportOptions,
          // Inline resume after approval-complete drives
          // completeToken. Passing the runHandler here means the route
          // calls `runHandler.resumeRun(...)` synchronously in the same
          // request so the reviewer's response reflects the resumed run's
          // new state (running / completed / re-suspended).
          runHandler: input.runHandler,
        },
        authorizer,
      ),
    );
  }
  if (input.enableObservations === true && input.supervisor !== undefined) {
    v1.route('/observations', observationsRouter(input.supervisor, authorizer, itemRights));
  }
  if (input.agentRegistry !== undefined) {
    v1.route(
      '/agents',
      agentsRouter(
        input.agentRegistry,
        authorizer,
        input.toolRegistry,
        input.blockRegistry,
        input.agentReleases,
        {
          ...(input.evalRunBinding !== undefined && { evalRuns: input.evalRunBinding }),
          ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
        },
        {
          ...(input.memory?.semanticSearch !== undefined && {
            semanticSearch: input.memory.semanticSearch,
          }),
          ...(input.memory?.agentRemember !== undefined && {
            remember: input.memory.agentRemember,
          }),
          ...(input.memory?.conversationRecall !== undefined && {
            conversationRecall: input.memory.conversationRecall,
          }),
        },
        input.referenceScope,
        input.environmentOrders,
        itemRights,
        itemServing,
      ),
    );
  }
  if (input.agentReleases?.gatePolicies !== undefined) {
    v1.route('/gate-policies', gatePoliciesRouter(input.agentReleases.gatePolicies, authorizer));
  }
  if (input.flowRegistry !== undefined) {
    v1.route(
      '/flows',
      flowsRouter(
        input.flowRegistry,
        authorizer,
        input.toolRegistry !== undefined && input.agentRegistry !== undefined
          ? {
              tools: input.toolRegistry,
              agents: input.agentRegistry,
              ...(input.agentReleases !== undefined && { live: input.agentReleases.live }),
            }
          : undefined,
        input.referenceScope,
        input.environmentOrders,
        itemRights,
        itemServing,
      ),
    );
  }
  // A model provider's key is used by its provider only: the routes that
  // write a tool, an endpoint or a provider check names against it.
  const providerKeys = providerKeysOf(input.providerRegistry);
  const receiveUrl =
    input.publicUrl === undefined
      ? undefined
      : (tenantId: import('@kindgi/types').TenantId, webhookId: string) =>
          `${input.publicUrl?.replace(/\/+$/, '')}/v1/hooks/${tenantId}/${webhookId}`;
  const secretUsers = (tenantId: import('@kindgi/types').TenantId, name: string) =>
    usersOfSecret(
      {
        ...(input.toolRegistry !== undefined && { tools: input.toolRegistry }),
        ...(input.mcpEndpointRegistry !== undefined && { mcpEndpoints: input.mcpEndpointRegistry }),
        ...(input.webhookEndpoints !== undefined && { webhookEndpoints: input.webhookEndpoints }),
        ...(input.triggerRegistry !== undefined && { triggers: input.triggerRegistry }),
      },
      tenantId,
      name,
    );
  // The env this deployment serves: where a tool's declared secrets are read.
  const servedEnv = input.envName ?? input.webhookReceiver?.envName;
  if (input.refuseOtherEnvs === true && servedEnv === undefined) {
    throw new Error(
      'createApp: `refuseOtherEnvs` needs `envName`, the env this runtime serves (KINDGI_ENV)',
    );
  }
  const servedEnvRule: ServedEnvRule | undefined =
    input.refuseOtherEnvs === true && servedEnv !== undefined
      ? {
          envName: servedEnv,
          references: secretReferencesOf({
            ...(input.providerRegistry !== undefined && { providers: input.providerRegistry }),
            ...(input.mcpEndpointRegistry !== undefined && {
              mcpEndpoints: input.mcpEndpointRegistry,
            }),
            ...(input.webhookEndpoints !== undefined && {
              webhookEndpoints: input.webhookEndpoints,
            }),
          }),
        }
      : undefined;
  if (input.toolRegistry !== undefined) {
    v1.route(
      '/tools',
      toolsRouter(input.toolRegistry, authorizer, input.onToolWrite, {
        providerKeys,
        ...(input.secretsBinding !== undefined && { secrets: input.secretsBinding }),
        ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
        ...(servedEnv !== undefined && { envName: servedEnv }),
        ...(input.environmentOrders !== undefined && {
          environmentOrders: input.environmentOrders,
        }),
        ...(itemRights !== undefined && { itemRights }),
        ...(itemServing !== undefined && { itemServing }),
      }),
    );
  }
  if (input.guardrailRegistry !== undefined) {
    v1.route(
      '/guardrails',
      guardrailsRouter(
        input.guardrailRegistry,
        authorizer,
        input.onGuardrailWrite,
        input.checkGuardrailConfig,
        input.referenceScope,
        input.environmentOrders,
        itemRights,
      ),
    );
  }
  if (input.retention !== undefined) {
    v1.route('/retention', retentionRouter(input.retention, authorizer));
  }
  // Before `/memory`, so its routes answer first.
  if (input.memoryErasures !== undefined) {
    v1.route('/memory/erasures', memoryErasuresRouter(input.memoryErasures, authorizer));
  }
  if (input.memory !== undefined) {
    v1.route(
      '/memory',
      memoryRouter(input.memory, {
        ...(authorizer !== undefined && { authorizer }),
        ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
      }),
    );
  }
  if (
    input.supervisor !== undefined &&
    input.agentRegistry !== undefined &&
    input.blockRegistry !== undefined &&
    input.evalRunBinding !== undefined &&
    input.agentReleases !== undefined
  ) {
    const improveDeps = {
      ...(input.improvementPasses !== undefined && { passes: input.improvementPasses }),
      agents: input.agentRegistry,
      blocks: input.blockRegistry,
      releases: input.agentReleases,
      ...(input.referenceScope !== undefined && { referenceScope: input.referenceScope }),
      ...(input.projectSuspended !== undefined && { projectSuspended: input.projectSuspended }),
      ...(input.judgmentRegistry !== undefined && { judgeClasses: input.judgmentRegistry }),
      ...(input.evalSuiteRegistry !== undefined && { suites: input.evalSuiteRegistry }),
    };
    v1.route(
      '/proposals',
      proposalsRouter(
        input.supervisor,
        {
          agents: input.agentRegistry,
          blocks: input.blockRegistry,
          evalRuns: input.evalRunBinding,
          releases: input.agentReleases,
          ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
          ...(input.referenceScope !== undefined && { referenceScope: input.referenceScope }),
          ...(input.environmentOrders !== undefined && { orders: input.environmentOrders }),
          // A drafter's promotion needs a separate approver when the tenant has
          // a second person who could approve it — one who can read the
          // approval's resource, so the count matches who the decide route lets in.
          ...(input.reviewerRegistry !== undefined && { reviewers: input.reviewerRegistry }),
          ...(input.authz !== undefined && { authz: input.authz.authzCheckBinding }),
        },
        authorizer,
        (r) => mountImproveRoute(r, improveDeps, authorizer, itemRights),
        itemRights,
      ),
    );
    v1.route(
      '/improvement-passes',
      improvementPassesRouter(input.improvementPasses, authorizer, itemRights),
    );
  }
  v1.route('/export-signing-keys', exportSigningKeysRouter(exportSigning));
  if (input.license !== undefined) {
    v1.route('/license', licenseRouter(input.license, authorizer));
  }
  if (input.systemKeys !== undefined) {
    v1.route(
      '/system/keys',
      systemKeysRouter(input.systemKeys, authorizer, {
        // Serving one tenant, a system key is the license renewal's alone.
        ...(input.tenancy !== 'multi' && { mintable: ONE_TENANT_SYSTEM_SCOPES }),
      }),
    );
  }
  if (input.systemDeployments !== undefined && input.systemTenantDirectory !== undefined) {
    // Each deployment's pack service gets the env its pack declares, from
    // the env store at the deployment's scopes (`pack-env.ts`).
    const packEnv =
      input.deploymentRegistry !== undefined &&
      input.envBinding !== undefined &&
      servedEnv !== undefined
        ? {
            deployments: input.deploymentRegistry,
            stores: {
              env: input.envBinding,
              ...(secretsBinding !== undefined && { secrets: secretsBinding }),
              ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
            },
            envName: servedEnv,
            ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
            ...(input.logger !== undefined && { log: input.logger }),
          }
        : undefined;
    v1.route(
      '/system',
      systemDeploymentsRouter({
        ...input.systemDeployments,
        directory: input.systemTenantDirectory,
        ...(authorizer !== undefined && { authorizer }),
        ...(packEnv !== undefined && { packEnv }),
      }),
    );
  }
  if (input.systemTenants !== undefined && input.systemTenantDirectory !== undefined) {
    v1.route(
      '/system/tenants',
      systemTenantsRouter({
        tenants: input.systemTenants,
        directory: input.systemTenantDirectory,
        ...(authorizer !== undefined && { authorizer }),
        ...(tenantHierarchyBinding.renameTenant !== undefined && {
          renameTenant: tenantHierarchyBinding.renameTenant.bind(tenantHierarchyBinding),
        }),
      }),
    );
  }
  // A system key's own id, scopes and expiry: the fence lets only a system principal here.
  v1.route('/system/whoami', systemWhoamiRouter());
  if (input.systemTenantSettings !== undefined && input.systemTenantDirectory !== undefined) {
    v1.route(
      '/system/tenants',
      systemTenantSettingsRouter({
        settings: input.systemTenantSettings,
        directory: input.systemTenantDirectory,
        ...(authorizer !== undefined && { authorizer }),
      }),
    );
  }
  if (input.usage !== undefined) {
    v1.route(
      '/system/usage',
      systemUsageRouter({
        usage: input.usage,
        ...(authorizer !== undefined && { authorizer }),
      }),
    );
    v1.route(
      '/usage',
      usageRouter({
        usage: input.usage,
        ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
        ...(authorizer !== undefined && { authorizer }),
      }),
    );
  }
  v1.route(
    '/provenance',
    provenanceRouter(
      input.provenanceBinding,
      {
        conversationBinding: input.conversationBinding,
        runBinding,
        ...exportOptions,
      },
      authorizer,
    ),
  );
  if (
    input.auditEvents !== undefined &&
    input.complianceClassifier !== undefined &&
    input.complianceGenerator !== undefined
  ) {
    v1.route(
      '/compliance',
      complianceRouter(
        {
          auditEvents: input.auditEvents,
          classifier: input.complianceClassifier,
          ...(exportSigning !== undefined && { exportSigning }),
        },
        authorizer,
      ),
    );
  }
  if (input.blobStorage !== undefined) {
    v1.route(
      '/artifacts',
      artifactsRouter(input.blobStorage, {
        runBinding,
        ...(input.projectBinding !== undefined && { projectBinding: input.projectBinding }),
        ...(authorizer !== undefined && { authorizer }),
      }),
    );
  }
  if (input.capabilityRegistry !== undefined) {
    v1.route('/capabilities', capabilitiesRouter(input.capabilityRegistry, authorizer));
  }
  if (input.providerRegistry !== undefined) {
    v1.route(
      '/providers',
      providersRouter(
        input.providerRegistry,
        input.onProviderWrite,
        input.adapterFactories,
        authorizer,
        { secretUsers, ...(servedEnvRule !== undefined && { servedEnv: servedEnvRule }) },
      ),
    );
  }
  if (input.mcpEndpointRegistry !== undefined) {
    v1.route(
      '/mcp',
      mcpRouter(input.mcpEndpointRegistry, input.mcpClientProbe, authorizer, {
        hostAccess: input.tenantHostAccess ?? 'deployed',
        providerKeys,
        ...(input.secretsBinding !== undefined && { secrets: input.secretsBinding }),
        ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
        ...(servedEnvRule !== undefined && { servedEnv: servedEnvRule }),
      }),
    );
  }
  // Identity mounts unconditionally so `/v1/identity/whoami` is always
  // reachable. `/users/*` routes register only when an
  // `identityDirectory` binding is provided (deployments without a
  // directory adapter still get whoami).
  v1.route(
    '/identity',
    identityRouter({
      ...(input.identityDirectory !== undefined && { directory: input.identityDirectory }),
      ...(input.sessionStore !== undefined && { sessionStore: input.sessionStore }),
      ...(input.reviewerBinding !== undefined && { reviewerBinding: input.reviewerBinding }),
      ...(authorizer !== undefined && { authorizer }),
      ...(input.personGrants !== undefined && { personGrants: input.personGrants }),
      ...(input.myAccess !== undefined && { myAccess: input.myAccess }),
      ...(input.envBinding !== undefined && { tenantConfig: input.envBinding }),
      ...(servedEnv !== undefined && {
        servedEnv: { envName: servedEnv, refusesOtherEnvs: servedEnvRule !== undefined },
      }),
    }),
  );
  if (input.secondFactor !== undefined) {
    const secondFactor = {
      binding: input.secondFactor,
      ...(authorizer !== undefined && { authorizer }),
      ...(input.identityDirectory !== undefined && { directory: input.identityDirectory }),
      ...(input.sessionStore !== undefined && { sessionStore: input.sessionStore }),
    };
    v1.route('/identity', secondFactorIdentityRouter(secondFactor));
    v1.route('/auth/settings', authSettingsRouter(secondFactor));
  }
  if (input.cost !== undefined) {
    v1.route('/cost', costRouter(input.cost, authorizer, input.projectBinding));
  }
  if (input.adapterRegistry !== undefined) {
    v1.route(
      '/adapters',
      adaptersRouter(input.adapterRegistry, input.adapterFactories, authorizer),
    );
  }
  // Trigger admin surfaces. Four sibling routers over the same
  // `TriggerRegistryBinding` — each pins its own kind. The inbound
  // webhook receiver is outside the bearer chain (`/v1/hooks`, below).
  if (input.triggerRegistry !== undefined) {
    const kinds = new Set<TriggerKind>(input.triggerKinds ?? TRIGGER_KINDS);
    // Where a trigger's `toolsAllowedUnattended` is checked against what
    // its target calls (`routes/trigger-tools.ts`).
    const targetTools = {
      ...(input.agentRegistry !== undefined && { agents: input.agentRegistry }),
      ...(input.flowRegistry !== undefined && { flows: input.flowRegistry }),
    };
    if (kinds.has('cron')) {
      v1.route(
        '/schedules',
        schedulesRouter(
          input.triggerRegistry,
          authorizer,
          input.projectBinding,
          {
            ...(input.identityDirectory !== undefined && { directory: input.identityDirectory }),
            ...(input.serviceAccountBinding !== undefined && {
              serviceAccounts: input.serviceAccountBinding,
            }),
          },
          input.referenceScope,
          input.auditEvents,
          itemRights,
          targetTools,
          input.triggerOwnerNotices,
        ),
      );
    }
    if (kinds.has('event')) {
      v1.route(
        '/event-triggers',
        eventTriggersRouter(input.triggerRegistry, authorizer, itemRights),
      );
    }
    if (kinds.has('webhook')) {
      v1.route(
        '/webhooks',
        webhooksRouter(input.triggerRegistry, {
          ...(authorizer !== undefined && { authorizer }),
          ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
          ...(input.secretsBinding !== undefined && { secrets: input.secretsBinding }),
          ...(input.webhookReceiver !== undefined && { envName: input.webhookReceiver.envName }),
          ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
          names: {
            ...(input.identityDirectory !== undefined && { directory: input.identityDirectory }),
            ...(input.serviceAccountBinding !== undefined && {
              serviceAccounts: input.serviceAccountBinding,
            }),
          },
          providerKeys,
          ...(itemRights !== undefined && { itemRights }),
          ...(receiveUrl !== undefined && { receiveUrl }),
          targetTools,
          ...(input.referenceScope !== undefined && { referenceScope: input.referenceScope }),
          ...(input.triggerOwnerNotices !== undefined && {
            ownerNotices: input.triggerOwnerNotices,
          }),
        }),
      );
    }
    if (kinds.has('mail')) {
      v1.route(
        '/mail-triggers',
        mailTriggersRouter(input.triggerRegistry, {
          ...(authorizer !== undefined && { authorizer }),
          ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
          names: {
            ...(input.identityDirectory !== undefined && { directory: input.identityDirectory }),
            ...(input.serviceAccountBinding !== undefined && {
              serviceAccounts: input.serviceAccountBinding,
            }),
          },
          ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
          ...(input.referenceScope !== undefined && { referenceScope: input.referenceScope }),
          ...(itemRights !== undefined && { itemRights }),
          targetTools,
          ...(input.triggerOwnerNotices !== undefined && {
            ownerNotices: input.triggerOwnerNotices,
          }),
        }),
      );
    }
  }
  if (input.webhookEndpoints !== undefined) {
    v1.route(
      '/webhook-endpoints',
      webhookEndpointsRouter(input.webhookEndpoints, authorizer, {
        providerKeys,
        ...(servedEnvRule !== undefined && { servedEnv: servedEnvRule }),
      }),
    );
  }
  if (input.connections !== undefined) {
    if (servedEnv === undefined) {
      throw new Error(
        'createApp: `connections` needs `envName`, the env this runtime serves (KINDGI_ENV): a connection is made under it',
      );
    }
    v1.route('/connection-entries', connectionEntriesRouter(input.connections));
    v1.route(
      '/connection-apps',
      connectionAppsRouter(input.connections, authorizer, {
        providerKeys,
        ...(servedEnvRule !== undefined && { servedEnv: servedEnvRule }),
      }),
    );
    v1.route(
      '/connections',
      connectionsRouter(input.connections, authorizer, {
        envName: servedEnv,
        ...(input.reviewerBinding !== undefined &&
          input.hitlBinding !== undefined && { reviewers: input.reviewerBinding }),
      }),
    );
  }
  if (input.policyRegistry !== undefined) {
    v1.route(
      '/policies',
      policiesRouter(input.policyRegistry, authorizer, {
        ...(input.retentionLimits !== undefined && { retentionLimits: input.retentionLimits }),
      }),
    );
  }
  if (input.evalSuiteRegistry !== undefined) {
    v1.route(
      '/eval-suites',
      evalSuitesRouter(input.evalSuiteRegistry, authorizer, itemRights, itemServing),
    );
  }
  if (input.blockRegistry !== undefined) {
    v1.route(
      '/blocks',
      blocksRouter(
        input.blockRegistry,
        authorizer,
        input.environmentOrders,
        itemRights,
        itemServing,
      ),
    );
  }
  if (input.judgmentRegistry !== undefined) {
    v1.route(
      '/judgments',
      judgmentsRouter(
        input.judgmentRegistry,
        runBinding,
        authorizer,
        input.conversationBinding,
        input.flowRegistry,
        input.reviewerBinding,
        input.agentRegistry,
      ),
    );
    v1.route('/judge-classes', judgeClassesRouter(input.judgmentRegistry, authorizer));
  }
  if (input.judgingQueue !== undefined) {
    v1.route(
      '/projects',
      judgingRouter(input.judgingQueue, {
        ...(authorizer !== undefined && { authorizer }),
        ...(input.judgmentRegistry !== undefined && { judgments: input.judgmentRegistry }),
        ...(input.reviewerBinding !== undefined && { reviewers: input.reviewerBinding }),
        ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
      }),
    );
  }
  if (
    input.evalSuiteRegistry !== undefined &&
    input.judgmentRegistry !== undefined &&
    input.evalCaseStore !== undefined
  ) {
    v1.route(
      '/eval-suites',
      judgedSuitesRouter(
        input.evalSuiteRegistry,
        input.judgmentRegistry,
        input.evalCaseStore,
        authorizer,
        itemRights,
      ),
    );
  }
  // ---------- platform hierarchy ----------
  // Mounts are independent: `/v1/orgs`, `/v1/teams`, `/v1/projects`,
  // `/v1/tenant`. Each requires its own binding. Team + Project
  // sub-resources (`/memberships`) require both bindings supplied.
  if (input.orgBinding !== undefined) {
    v1.route('/orgs', orgsRouter(input.orgBinding, tenantHierarchyBinding, authorizer));
  }
  if (input.teamBinding !== undefined && input.teamMembershipBinding !== undefined) {
    v1.route(
      '/teams',
      teamsRouter(
        input.teamBinding,
        input.teamMembershipBinding,
        tenantHierarchyBinding,
        authorizer,
        input.identityDirectory,
      ),
    );
  }
  if (input.projectBinding !== undefined && input.projectMembershipBinding !== undefined) {
    v1.route(
      '/projects',
      projectsRouter(
        input.projectBinding,
        input.projectMembershipBinding,
        tenantHierarchyBinding,
        authorizer,
        input.identityDirectory,
        input.serviceAccountBinding,
      ),
    );
  }
  if (input.projectBinding !== undefined) {
    v1.route(
      '/projects',
      projectProductionRouter({
        projects: input.projectBinding,
        tenantHierarchy: tenantHierarchyBinding,
        ...(authorizer !== undefined && { authorizer }),
        ...(input.production !== undefined && { production: input.production }),
      }),
    );
  }
  if (input.projectBinding !== undefined && input.projectMembershipBinding !== undefined) {
    v1.route(
      '/projects',
      projectAccessRouter({
        projects: input.projectBinding,
        ...(input.projectAccess !== undefined && { access: input.projectAccess }),
        ...(authorizer !== undefined && { authorizer }),
      }),
    );
  }
  if (
    input.teamProjectGrantBinding !== undefined &&
    input.projectBinding !== undefined &&
    input.teamBinding !== undefined
  ) {
    const teamGrants = {
      grants: input.teamProjectGrantBinding,
      projects: input.projectBinding,
      teams: input.teamBinding,
      tenantHierarchy: tenantHierarchyBinding,
      ...(authorizer !== undefined && { authorizer }),
    };
    v1.route('/projects', projectTeamGrantsRouter(teamGrants));
    v1.route('/teams', teamProjectGrantsRouter(teamGrants));
  }
  // `/v1/tenant` is always mounted (reads the tenant through the
  // tenant-hierarchy binding);
  // `/config` sub-routes are gated on the presence of at least one of
  // `envBinding` / `secretsBinding`.
  v1.route(
    '/tenant',
    tenantRouter({
      tenantHierarchyBinding: input.tenantHierarchyBinding,
      ...(input.envBinding !== undefined && { envBinding: input.envBinding }),
      ...(secretsBinding !== undefined && { secretsBinding }),
      ...(authorizer !== undefined && { authorizer }),
      ...(input.production?.next !== undefined && { productionNext: input.production.next }),
      ...(input.egress !== undefined && { egress: input.egress }),
      // Its entries live where the runtime's tools read them.
      ...(servedEnv !== undefined && { envName: servedEnv }),
    }),
  );
  // ---------- env + secrets ----------
  // Dedicated env/secrets HTTP surface. `/v1/env/*` mounts iff
  // `envBinding` is wired; `/v1/secrets/*` iff `secretsBinding` is
  // wired. `secretsBinding` also drives the async-rotation status
  // store — an in-memory reference is used when the caller doesn't
  // plug in a durable one.
  if (input.envBinding !== undefined) {
    v1.route('/env', envRouter(input.envBinding, authorizer, input.auditEvents, servedEnvRule));
  }
  // Audit query surface. Admin-only PEP applied inside the router
  // (self-contained; no plumbing here).
  if (input.auditEvents !== undefined) {
    v1.route('/audit', auditRouter(input.auditEvents, authorizer));
  }
  if (secretsBinding !== undefined) {
    v1.route(
      '/secrets',
      secretsRouter({
        secretsBinding,
        rotationStatusStore: input.rotationStatusStore ?? createInMemoryRotationStatusStore(),
        ...(authorizer !== undefined && { authorizer }),
        ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
        ...(servedEnvRule !== undefined && { servedEnv: servedEnvRule }),
      }),
    );
  }
  if (input.envBinding !== undefined || secretsBinding !== undefined) {
    v1.route(
      '/environments',
      environmentsRouter({
        ...(input.envBinding !== undefined && { envBinding: input.envBinding }),
        ...(secretsBinding !== undefined && { secretsBinding }),
        ...(authorizer !== undefined && { authorizer }),
      }),
    );
  }
  if (input.environmentOrders !== undefined) {
    v1.route(
      '/environment-orders',
      environmentOrdersRouter({
        binding: input.environmentOrders,
        ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
        ...(authorizer !== undefined && { authorizer }),
      }),
    );
  }
  // ---------- deployments ----------
  // Requires all three of: DeploymentBinding + SigningKeyRegistryBinding +
  // ImageRegistryBinding. Optional tool/guardrail/agent/flow registries
  // are threaded through so the atomic transaction upserts primitives
  // from the deployment's index.json into the same catalogs the SDK
  // publish surfaces consume — a deploy is just a bulk publish + ledger
  // record, signed end-to-end.
  // The trust list `POST /v1/deployments` verifies signers against.
  // Mounted on its own: a deployment can trust keys before it accepts
  // deployments.
  if (input.signingKeyRegistry !== undefined) {
    v1.route('/signing-keys', signingKeysRouter(input.signingKeyRegistry, authorizer));
  }
  if (
    input.deploymentRegistry !== undefined &&
    input.signingKeyRegistry !== undefined &&
    input.imageRegistry !== undefined
  ) {
    v1.route(
      '/deployments',
      deploymentsRouter(
        {
          deploymentRegistry: input.deploymentRegistry,
          // Only where the runtime serves many tenants: one tenant's runtime
          // deploys any image, as before.
          ...(input.tenancy === 'multi' &&
            input.imagePrefixes !== undefined && {
              imagePrefixes: {
                of: (tenantId: import('@kindgi/types').TenantId) =>
                  input.imagePrefixes?.of(tenantId) ?? Promise.resolve(undefined),
                required: true,
              },
            }),
          signingKeyRegistry: input.signingKeyRegistry,
          providerKeys,
          imageRegistry: input.imageRegistry,
          // A runtime routing pack calls per deployment sends each check call
          // by its id: a pack check must carry its pack's id.
          ...(input.systemDeployments !== undefined && { requirePrefixedPackChecks: true }),
          ...(input.projectSuspended !== undefined && { projectSuspended: input.projectSuspended }),
          ...(input.toolRegistry !== undefined && { toolRegistry: input.toolRegistry }),
          ...(input.blockRegistry !== undefined && { blockRegistry: input.blockRegistry }),
          ...(input.guardrailRegistry !== undefined && {
            guardrailRegistry: input.guardrailRegistry,
          }),
          ...(input.agentRegistry !== undefined && { agentRegistry: input.agentRegistry }),
          ...(input.flowRegistry !== undefined && { flowRegistry: input.flowRegistry }),
          ...(input.agentReleases !== undefined && { liveVersions: input.agentReleases.live }),
          // A promotion asked to make its carried agents live pins each in
          // the target through the same gate a live route uses.
          ...(input.agentReleases !== undefined && {
            agentReleases: input.agentReleases,
            releaseGateDeps: {
              ...(input.evalRunBinding !== undefined && { evalRuns: input.evalRunBinding }),
              ...(input.projectBinding !== undefined && { projects: input.projectBinding }),
              ...(input.referenceScope !== undefined && { referenceScope: input.referenceScope }),
            },
          }),
          ...(itemRights !== undefined && { itemRights }),
          // The deployments router's agents publish loop resolves the
          // Default project through this binding. Optional at wiring so
          // app compositions without a project binding still boot; the loop
          // fails fast at runtime if agents are in the deployment index
          // but the binding is absent.
          ...(input.projectBinding !== undefined && { projectBinding: input.projectBinding }),
          ...(input.referenceScope !== undefined && { referenceScope: input.referenceScope }),
          ...(input.environmentOrders !== undefined && {
            environmentOrders: input.environmentOrders,
          }),
          // POST /v1/deployments/:deploymentId/secrets needs the
          // secretsBinding. Absent binding → the route answers 500 with an
          // operator-actionable message.
          ...(secretsBinding !== undefined && { secretsBinding }),
          ...(servedEnv !== undefined && { envName: servedEnv }),
          // A runtime running a pack service per deployment gives each the
          // env its pack declares, from the env store.
          ...(input.systemDeployments !== undefined && { packEnvServed: true }),
          ...(input.envBinding !== undefined && { envBinding: input.envBinding }),
          ...(servedEnvRule !== undefined && { servedEnv: servedEnvRule }),
          // A deploy registers tools and guardrails: the same cache hooks
          // `POST /v1/tools` / `POST /v1/guardrails` call.
          ...(input.onToolWrite !== undefined && { onToolWrite: input.onToolWrite }),
          ...(input.onGuardrailWrite !== undefined && { onGuardrailWrite: input.onGuardrailWrite }),
          // A deployment's values check (a promotion's, and its values read)
          // reads env values and model keys as a run does.
          values: {
            ...(input.envBinding !== undefined && { env: input.envBinding }),
            ...(input.providerRegistry !== undefined && { providers: input.providerRegistry }),
            ...input.deploymentValues,
          },
          ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
        },
        authorizer,
      ),
    );
  }
  if (input.evalRunBinding !== undefined) {
    // Mount the start route under `/v1/eval-suites/:suiteId/runs` and
    // the readback surface under `/v1/eval-runs/*`. Both share one
    // binding — the start-route registration happens even without an
    // `evalSuiteRegistry` binding: the dispatcher itself surfaces
    // `suite-not-found` when the caller-plugged binding can't resolve
    // the suite id, so the API layer stays consumer-neutral.
    const evalRuns = evalRunsRouters(
      input.evalRunBinding,
      input.flowRegistry !== undefined
        ? {
            flows: input.flowRegistry,
            ...(input.agentRegistry !== undefined && { agents: input.agentRegistry }),
            ...(input.toolRegistry !== undefined && { tools: input.toolRegistry }),
          }
        : undefined,
      input.agentRegistry !== undefined && input.blockRegistry !== undefined
        ? { agents: input.agentRegistry, blocks: input.blockRegistry }
        : undefined,
      authorizer,
      input.referenceScope,
      input.projectSuspended,
      itemRights,
    );
    v1.route('/eval-suites', evalRuns.start);
    v1.route('/eval-runs', evalRuns.readback);
  }
  // ---------- auth routes ----------
  // The session store + identity-provider catalog: the auth router mounts
  // under `/v1/auth/*`, behind the same bearer chain (a static bearer or a
  // session token reaches it).
  if (input.sessionStore !== undefined && input.identityProvider !== undefined) {
    v1.route(
      '/auth',
      authRouter({
        sessionStore: input.sessionStore,
        identityProvider: input.identityProvider,
        ...(authorizer !== undefined && { authorizer }),
        ...(input.identityProviderChanges !== undefined && {
          providerChanges: input.identityProviderChanges,
        }),
        ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
      }),
    );
  }
  // How a person can sign in, before anyone is: outside the bearer chain
  // (mounted ahead of `/v1`). Always mounted, so the
  // console and `kindgi doctor` get a definite answer even when there is no
  // way in at all: the case an operator most needs to hear about.
  const cookieSessions = input.sessionStore !== undefined && input.session?.cookie !== undefined;
  const tokenSignIn =
    cookieSessions && input.session?.tokenSignIn === true && input.tokenAdmin !== undefined;
  const sessionCookie = sessionCookieOf(input.session?.cookie);
  // A browser refuses `__Host-` / `__Secure-` cookies that aren't `Secure`.
  if (!sessionCookie.secure && /^__(Host|Secure)-/.test(sessionCookie.name)) {
    throw new Error(
      `createApp: session.cookie.secure is false, so its name can't start with __Host- or __Secure- (got ${sessionCookie.name}); leave name unset for ${'`kindgi_session`'}.`,
    );
  }
  checkSignInLegal(input.signInLegal);
  checkConsoleLinks(input.consoleLinks);
  app.route(
    '/v1/auth/sign-in-options',
    signInOptionsRouter({
      ...(input.identityProvider !== undefined && { identityProvider: input.identityProvider }),
      tokenSignIn,
      ...(cookieSessions && { sessionCookie: sessionCookie.secure ? 'secure' : 'plain' }),
      ...(input.signInOptionsRateLimit !== undefined && {
        rateLimit: input.signInOptionsRateLimit,
      }),
      ...(input.signInEmailLink !== undefined && { emailLink: input.signInEmailLink }),
      ...(input.signInLegal !== undefined && { legal: input.signInLegal }),
      ...(input.consoleLinks !== undefined && { links: input.consoleLinks }),
    }),
  );
  // The inbound webhook receiver: outside the bearer chain (mounted ahead
  // of `/v1`), since nobody signs in to send a webhook; the request's
  // signature is what it checks. A bearer token, if sent, is never read.
  if (
    input.webhookReceiver !== undefined &&
    input.triggerRegistry !== undefined &&
    secretsBinding !== undefined &&
    observedSecrets !== undefined &&
    new Set<TriggerKind>(input.triggerKinds ?? TRIGGER_KINDS).has('webhook') &&
    input.triggerRegistry.findWebhook !== undefined &&
    input.triggerRegistry.fireWebhook !== undefined &&
    input.triggerRegistry.recordWebhookRefusal !== undefined
  ) {
    app.route(
      '/v1/hooks',
      hooksRouter({
        ...(tenantLimiter !== undefined && { tenantLimiter }),
        triggers: input.triggerRegistry,
        secrets: secretsBinding,
        secretWrites: observedSecrets.writes,
        envName: input.webhookReceiver.envName,
        providerKeys,
        ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
        ...(input.webhookReceiver.clientAddress !== undefined && {
          clientAddress: input.webhookReceiver.clientAddress,
        }),
        ...(input.webhookReceiver.rateLimitStore !== undefined && {
          rateLimitStore: input.webhookReceiver.rateLimitStore,
        }),
        ...(input.tenantStates !== undefined && { tenantStates: input.tenantStates }),
        ...(input.projectSuspended !== undefined && {
          projectSuspended: input.projectSuspended,
        }),
      }),
    );
  }
  // Removals an app reports: outside the bearer chain (mounted ahead of
  // `/v1`), checked by the app's own signature.
  if (input.connections !== undefined) {
    app.route(
      '/v1/connection-notices',
      connectionNoticesRouter(input.connections, {
        ...(input.webhookReceiver?.clientAddress !== undefined && {
          clientAddress: input.webhookReceiver.clientAddress,
        }),
        ...(input.webhookReceiver?.rateLimitStore !== undefined && {
          rateLimitStore: input.webhookReceiver.rateLimitStore,
        }),
      }),
    );
  }
  // Another system answers a paused run through its wait token's link:
  // outside the bearer chain (mounted ahead of `/v1`), since that system
  // has no Kindgi key; the token in the path is the credential. Always
  // mounted, so a link to a runtime that pauses no run is a clear 404.
  app.route(
    '/v1/wait-tokens',
    waitTokensRouter({
      ...(input.waitTokens !== undefined && { binding: input.waitTokens }),
      runHandler: input.runHandler,
      ...(input.webhookReceiver?.clientAddress !== undefined && {
        clientAddress: input.webhookReceiver.clientAddress,
      }),
      ...(input.webhookReceiver?.rateLimitStore !== undefined && {
        rateLimitStore: input.webhookReceiver.rateLimitStore,
      }),
    }),
  );
  // A site enrolls its key, and signs its people in: outside the bearer
  // chain (mounted ahead of `/v1`), since nobody is signed in yet.
  if (input.sites !== undefined) {
    // A site's session is held to its project by the authorizer (on routes
    // that take only an id, by `inKeyProject`), and ends with the site
    // (`revokeByProvider`): without either, refuse to start.
    if (input.authz === undefined) {
      throw new Error(
        'createApp: `sites` needs authorization (`authz`): without it a site session is not held to its project',
      );
    }
    if (input.sessionStore?.revokeByProvider === undefined) {
      throw new Error(
        'createApp: `sites` needs a session store with `revokeByProvider`: a paused or revoked site must end its sessions',
      );
    }
    const siteAuth = {
      binding: input.sites.binding,
      // Default: the nearest X-Forwarded-For hop (the proxy in front wrote
      // it), as the sign-in options limit tells clients apart.
      clientAddress:
        input.sites.clientAddress ?? ((request: Request) => nearestForwardedClient(request)),
    };
    app.route('/v1/auth/sites/enroll', siteEnrollRouter(siteAuth));
    app.route('/v1/auth/site-sign-in', siteSignInRouter(siteAuth));
    v1.route('/projects', sitesRouter(input.sites.binding, authorizer));
  }
  // Browser sessions need a way out even without identity providers
  // (which bring their own `/auth` routes, logout included).
  if (cookieSessions && input.identityProvider === undefined && input.sessionStore !== undefined) {
    v1.post('/auth/logout', logoutHandler(input.sessionStore, input.auditEvents));
  }
  // A person signs in to the console with an API token: inside the bearer
  // chain (the token arrives in `Authorization`). Always mounted: without
  // browser sessions, unless the deployment allows it, or without its API
  // keys (each request on such a session reads its key), it refuses with
  // 403 token-sign-in-off.
  v1.route(
    '/auth/token-sign-in',
    tokenSignInRouter(
      input.sessionStore !== undefined &&
        input.session?.cookie !== undefined &&
        input.session.tokenSignIn === true &&
        input.tokenAdmin !== undefined
        ? {
            enabled: true,
            sessionStore: input.sessionStore,
            ttlMs: input.session.ttl ?? DEFAULT_TOKEN_SIGN_IN_TTL_MS,
            cookieName: sessionCookieOf(input.session.cookie).name,
            cookieSecure: sessionCookieOf(input.session.cookie).secure,
            ...(input.auditEvents !== undefined && { auditEvents: input.auditEvents }),
            ...(input.secondFactor !== undefined && {
              secondFactorRequired: input.secondFactor.required.bind(input.secondFactor),
            }),
          }
        : {
            enabled: false,
            ...(cookieSessions && input.session?.tokenSignIn === true && { withoutApiKeys: true }),
          },
      authorizer,
    ),
  );
  app.route('/v1', v1);

  // ---------- S3-compat surface (/s3/*, SigV4 auth) ----------
  // Mounted OUTSIDE the /v1/* Bearer chain — S3 clients authenticate
  // with SigV4, not bearer tokens. Requires both a resolved
  // `blobStorage` binding (storage) and an `s3Credentials` binding
  // (auth); omitting either leaves /s3/* unmounted (Hono 404).
  if (input.blobStorage !== undefined && input.s3Credentials !== undefined) {
    const s3 = new Hono<AppEnv>();
    s3.use(
      '*',
      sigv4Middleware(input.s3Credentials, input.artifactMaxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES),
    );
    // A frozen tenant's artifacts are read, not written, here too.
    s3.use('*', tenantStateGate(input.tenantStates, { surface: 's3' }));
    // The tenant's API requests a minute count here too, once SigV4 names it.
    if (tenantLimiter !== undefined) s3.use('*', tenantS3RequestLimit(tenantLimiter));
    s3.route('/', s3Router(input.blobStorage));
    app.route('/s3', s3);
  }

  // Terminal 404 handler — every unmatched route returns the standard
  // `{ error: { code, message, requestId } }` envelope instead of Hono's
  // plaintext default. Rationale: routes mount conditionally on optional
  // bindings (e.g. `secretsBinding`, `blobStorage`), so "route not
  // registered" is a routine caller-facing outcome, not a bug. Serving a
  // naked 404 makes SDKs report "HTTP 404 without recognizable error
  // envelope", which reads as a bug at the SDK layer when the real
  // signal is "this deployment didn't wire that binding." The
  // `requestIdMiddleware` above runs for unmatched paths too, so the
  // id is always available.
  app.notFound((c) => {
    const requestId = (c.get('requestId') as string | undefined) ?? 'req-unknown';
    const body: WireErrorBody = {
      error: {
        code: 'route-not-found',
        message: `No route registered for ${c.req.method} ${loggablePath(c.req.path)}. If this endpoint is expected, verify the deployment wired the required binding.`,
        requestId,
      },
    };
    return c.json(body, 404);
  });

  return app;
}

/**
 * What the runs router checks a turn against: a conversation's agent,
 * participant, project and opener (`turnRefusal`, `participantRefusal`),
 * whether it's closed (`closedRefusal`), and a target's own project.
 */
function participantLookups(
  input: Pick<CreateAppInput, 'conversationBinding' | 'agentRegistry' | 'flowRegistry'>,
): Pick<RunsRouterOptions, 'conversationOf' | 'targetProject'> {
  return {
    conversationOf: async (tenantId, conversationId) => {
      const got = await input.conversationBinding.getConversation(
        tenantId,
        conversationId as never,
      );
      if (got.kind !== 'ok') {
        if (got.error.code === 'conversation-not-found') return null;
        // Any other failure isn't "no conversation": the turn would then run
        // as the stored participant unchecked. A 500, and no turn.
        throw new Error("Couldn't read the conversation, so the turn wasn't started", {
          cause: got.error,
        });
      }
      const { agentId, participantId, projectId, openedBy, closedAt } = got.value;
      return {
        agentId: agentId as unknown as string,
        ...(participantId !== undefined && { participantId }),
        ...(projectId !== undefined && { projectId: projectId as unknown as string }),
        ...(openedBy !== undefined && { openedBy }),
        ...(closedAt !== undefined && { closedAt: closedAt as unknown as string }),
      };
    },
    targetProject: async (tenantId, target) => {
      const record =
        target.kind === 'agent'
          ? await input.agentRegistry?.get({ tenantId, agentId: target.id as never })
          : await input.flowRegistry?.get({ tenantId, flowId: target.id as never });
      return record?.projectId as unknown as string | undefined;
    },
  };
}
