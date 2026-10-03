// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk/types` — branded IDs, framework-wide result envelope,
 * pagination, refs, temporal + version primitives.
 *
 * Re-exports types from `@kindgi/types` under their own names. These
 * are the workspace-wide identifiers callers pass across the SDK
 * boundary.
 *
 * The /types sub-path is where branded identifiers live in the public
 * facade.
 *
 * @module @kindgi/sdk/types
 */

export type {
  BlobRef,
  Brand,
  ContentHash,
  Cursor,
  DatasetRef,
  DurationMs,
  ErrOf,
  Filter,
  IsoDuration,
  OkOf,
  Page,
  Result,
  SchemaMajor,
  Semver,
  SignatureValue,
  Timestamp,
  VersionedRef,
} from '@kindgi/types';

// ---- Branded IDs ----
//
// Re-exported individually rather than via `export type *` so the flat
// barrel (`import { RunId } from '@kindgi/sdk'`) can see them —
// `verbatimModuleSyntax` requires named type re-exports for `export *`
// forwarding to work through the barrel.
export type {
  AgentId,
  ApiTokenId,
  ApprovalId,
  ArtifactId,
  AuditBundleId,
  ComplianceEvidenceId,
  ConversationId,
  DatasetId,
  EdgeId,
  EventId,
  FactId,
  FixProposalId,
  FlowId,
  InstallationId,
  GuardrailId,
  KeyId,
  LogEntryId,
  NodeId,
  ObservationId,
  OrgId,
  PackId,
  PolicyId,
  ProjectId,
  ProvenanceId,
  ProviderId,
  ReviewerId,
  RunId,
  ScheduleId,
  SessionId,
  SigningKeyId,
  SubscriptionId,
  SupervisorId,
  TeamId,
  TenantId,
  ThreadId,
  ToolId,
  TriggerId,
  UserId,
  WaitTokenId,
  WebhookDeliveryId,
  WebhookId,
} from '@kindgi/types';
