// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk/client` — client callsite surface.
 *
 * Re-exports `createClient` plus every resource-client type, the error
 * surface, transport primitives, and streaming helpers from the
 * `@kindgi/client` package (`sdks/typescript/` in this repository).
 * Names preserved verbatim.
 *
 * This sub-path intentionally does NOT re-export the branded ID types
 * (`AgentId`, `RunId`, etc.) that `@kindgi/client` also happens to
 * surface — those live in `@kindgi/sdk/types` to keep the flat barrel
 * (`import { ... } from '@kindgi/sdk'`) collision-free.
 *
 * Callsite examples target
 * `import { createClient } from '@kindgi/sdk/client'`.
 *
 * @module @kindgi/sdk/client
 */

// ---- Client factory + top-level shape ----
export { createClient } from '@kindgi/client';
export type { KindgiClient } from '@kindgi/client';

// ---- Resource client types + per-resource input shapes ----
export type {
  AdapterConfigureInput,
  AdapterFilter,
  AdapterTestInput,
  AdaptersClient,
  AddMembershipInput,
  AgentsClient,
  ApplyProposalInput,
  ApprovalFilter,
  ApprovalsClient,
  ArtifactFilter,
  ArtifactsClient,
  AuditClient,
  AuditExportInput,
  BatchDecideInput,
  BudgetsClient,
  CapabilitiesClient,
  CapabilityFilter,
  ClientOptions,
  CompleteTokenInput,
  ConversationFilter,
  ConversationsClient,
  CostClient,
  DecideInput,
  DraftProposalsInput,
  EventsClient,
  FactsClient,
  FlowFilter,
  FlowsClient,
  FlowValidateResult,
  GuardrailFilter,
  GuardrailsClient,
  LogsClient,
  McpClient,
  McpEndpointFilter,
  McpEndpointsClient,
  TeamMembershipsClient,
  MemoryClient,
  MessageFilter,
  ObservationFilter,
  ObservationsClient,
  OrgsClient,
  PackFilter,
  PacksClient,
  PageFilter,
  PatternsInput,
  PoliciesClient,
  PolicyListFilter,
  PolicyVersionsFilter,
  ProposalDryRunInput,
  ProposalListInput,
  ProposalsClient,
  ProvenanceClient,
  ProvenanceExportInput,
  ProviderFilter,
  ProvidersClient,
  ReflectReviewInput,
  RegistryClient,
  RegistryFilter,
  ResumeRunInput,
  ReviewerFilter,
  ReviewersClient,
  RollbackProposalInput,
  Run,
  RunsClient,
  SchedulesClient,
  SessionsClient,
  StartRunInput,
  SubmitForReviewInput,
  SubscriptionsClient,
  SupervisorClient,
  ListTeamsFilter,
  TeamsClient,
  TenantClient,
  TenantConfigClient,
  TokenFilter,
  TokensClient,
  ReinstateToolVersionResult,
  ToolFilter,
  ToolVersionFilter,
  ToolsClient,
  Transport,
  TransportRequest,
  UsageClient,
  UsageSummaryInput,
  UserFilter,
  UsersClient,
  WebhooksClient,
  WithdrawProposalInput,
} from '@kindgi/client';

// ---- Error surface ----
export { KindgiApiError, fromWire, notImplementedInPreview, notYetWired } from '@kindgi/client';
export type {
  AuthError,
  ConflictError,
  GuardrailViolation,
  GuardrailViolationError,
  InvalidRequestError,
  NetworkError,
  NotFoundError,
  NotImplementedInPreviewError,
  NotYetWiredError,
  RateLimitedError,
  ServerError,
  KindgiError,
} from '@kindgi/client';

// ---- Streaming helpers (SSE parser + resume) ----
export { readSse, unwrapSseData } from '@kindgi/client';
export type { SseEvent, SseReadOptions } from '@kindgi/client';

// ---- Following a run (browser-safe: a page follows a run with a public token) ----
export { followRun, subscribeToRun } from '@kindgi/client';
export type {
  FollowRunOptions,
  RunProgress,
  RunProgressEvent,
  SubscribeToRunOptions,
} from '@kindgi/client';
