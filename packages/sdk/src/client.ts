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
import { createClient as createKindgiClient } from '@kindgi/client';
import type { ClientOptions, KindgiClient } from '@kindgi/client';

import { resolveClientOptions } from './runtime-config.js';

export type { KindgiClient } from '@kindgi/client';

/**
 * A client for the app's Kindgi runtime. Every option is optional:
 *
 * - `apiUrl` and `auth` come from `KINDGI_API_URL` and `KINDGI_API_TOKEN`;
 * - outside production, when those aren't set, from the running
 *   `kindgi dev` (the nearest `.kindgirc.json`), with a one-time warning to
 *   put them in the app's env file;
 * - a token that doesn't match the running `kindgi dev`'s for the same
 *   `apiUrl` (after `kindgi dev --reset`) is warned about once.
 *
 * Production (`NODE_ENV` or `KINDGI_ENV` = `production`) never reads
 * `.kindgirc.json`: there, the env or explicit options must say. In a
 * browser, pass `apiUrl` and `auth`. `@kindgi/client`'s `createClient` is
 * the explicit form underneath.
 *
 * The options are found on first use, not here: a module-scope
 * `const kindgi = createClient()` is safe to import where the runtime's
 * settings aren't set, as a production build (`next build`) imports every
 * module. When they're missing, the first use (`kindgi.runs`, …) throws
 * the error that says what to set; once they're set, the next use works.
 *
 * @example
 * ```ts
 * import { createClient } from '@kindgi/sdk/client';
 *
 * const kindgi = createClient();
 * ```
 */
export function createClient(options: Partial<ClientOptions> = {}): KindgiClient {
  let client: KindgiClient | undefined;
  // A failed lookup isn't kept: the env may be set by the next use.
  const resolved = (): KindgiClient => {
    client ??= createKindgiClient(resolveClientOptions(options));
    return client;
  };
  return new Proxy({} as KindgiClient, {
    get(_target, key) {
      // Never resolve to answer whether the client is a promise (`await`,
      // `return` from an async function), or for a symbol a tool inspects.
      if (client === undefined && (key === 'then' || typeof key === 'symbol')) return undefined;
      return Reflect.get(resolved(), key);
    },
    // A write (a test swapping a resource) is a use: it lands on the client.
    // A property defined non-configurable (`defineProperty`'s default) throws:
    // a proxy can't hold one its target doesn't. Define it `configurable: true`.
    set: (_target, key, value) => Reflect.set(resolved(), key, value),
    defineProperty: (_target, key, descriptor) =>
      Reflect.defineProperty(resolved(), key, descriptor),
    deleteProperty: (_target, key) => Reflect.deleteProperty(resolved(), key),
    has: (_target, key) => key in resolved(),
    ownKeys: () => Reflect.ownKeys(resolved()),
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolved(), key);
      // The target holds none of the client's fields, so none may be reported fixed.
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
  });
}

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

// ---- Signed exports: check one where it's read ----
export { verifySignedExport } from '@kindgi/client';
export type {
  ExportSigningKey,
  SignedExportEnvelope,
  SignedExportVerification,
  VerifySignedExportOptions,
} from '@kindgi/client';

// ---- Following a run (browser-safe: a page follows a run with a public token) ----
export { followRun, subscribeToRun } from '@kindgi/client';
export type {
  FollowRunOptions,
  RunProgress,
  RunProgressEvent,
  SubscribeToRunOptions,
} from '@kindgi/client';

// ---- Comparisons (a test set compared with a version): the typed result ----
export { comparisonOf } from '@kindgi/client';
export type {
  ComparisonCandidate,
  ComparisonCaseResult,
  ComparisonMetric,
  JudgedComparisonResult,
  JudgedComparisonSummary,
} from '@kindgi/client';
