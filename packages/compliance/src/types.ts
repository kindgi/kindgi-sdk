// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AgentId,
  ComplianceEvidenceId,
  FlowId,
  ProjectId,
  ProvenanceId,
  RunId,
  SigningKeyId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

// ============ Wire types (schema-derived) ============

/**
 * The built-in (known) compliance-relevant event classes. Listed as
 * `examples` in `@kindgi/specs/compliance-evidence.schema.json`.
 *
 * Not exhaustive: evidence is a classifier lens over the audit stream,
 * whose kinds are open (pack authors add their own), and a deployment's
 * compliance classifier can mark any kind exportable. See `EvidenceKind`.
 */
export const EVIDENCE_KINDS = [
  'access-event',
  'policy-decision',
  'config-change',
  // `secret-rotation` is the coarse kind; emitters use the granular
  // `secret-rotated` / `secret-rotation-started` / `secret-rotation-failed`
  // kinds.
  'secret-rotation',
  'incident-event',
  'guardrail-violation',
  'eval-run',
  'approval-completed',
  'data-retention-action',
  'authn-event',
  'authz-decision',
  'model-invocation',
  'pack-install',
  'pack-upgrade',
  'pack-uninstall',
  'run-outcome',
  // Env-binding lifecycle events. Symmetric with the secret-* kinds
  // below; `env-*` events never carry the value in their payload.
  'env-resolved',
  'env-set',
  'env-deleted',
  // Secret-binding lifecycle events. The framework NEVER copies the
  // plaintext value into an evidence payload;
  // payloads carry only metadata (name, version, scope, caller, errorCode).
  'secret-resolved',
  'secret-set',
  'secret-rotated',
  'secret-rotation-started',
  'secret-rotation-failed',
  'secret-revoked',
  'secret-hard-revoked',
  // Human-in-the-loop approval decisions (exportable in the shipped
  // compliance classifier).
  'hitl-decision',
  // Which agent version is live for a scope: a promotion, a rollback, or
  // an unpin (the scope falls back to the one above).
  'agent-promotion',
  // A promotion its gate policy refused (evals step 4b): the checks that failed.
  'agent-promotion-refused',
  'agent-rollback',
  'agent-live-unpinned',
  // A live pin whose version was unregistered: runs use the scope above.
  'agent-live-pin-inactive',
] as const;

/**
 * An evidence kind: one of the built-in `EVIDENCE_KINDS`, or any other
 * audit-event kind a deployment's classifier marks exportable. Consumers
 * must tolerate kinds they don't know.
 */
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number] | (string & {});

export type ActorKind = 'user' | 'agent' | 'system' | 'admin' | 'external';

export interface EvidenceActor {
  readonly kind: ActorKind;
  readonly id?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface EvidenceSubject {
  readonly kind: string;
  readonly id?: string;
}

export type EvidenceOutcome = 'allowed' | 'denied' | 'succeeded' | 'failed' | 'escalated';

/**
 * Reference back to the provenance DAG that produced this evidence.
 * Same shape as `provenance.schema.json`'s runId + nodeId pair.
 */
export interface ProvenanceRef {
  readonly runId?: RunId;
  readonly nodeId?: string;
  /** For records linked to a persisted provenance record by id. */
  readonly recordId?: ProvenanceId;
}

/** Ed25519 signature over the canonical serialisation of the evidence. */
export interface EvidenceSignature {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly value: string;
  readonly signedAt: Timestamp;
}

/**
 * The kind-specific payload lives here. `payload` always includes a
 * `version` field, so consumers migrate older shapes to the current one
 * on read instead of rewriting stored records.
 */
export interface EvidencePayload {
  readonly version: number;
  readonly [key: string]: unknown;
}

/**
 * One evidence record. Matches `@kindgi/specs/compliance-evidence.schema.json`
 * modulo `payload` being an in-package-typed versioned document.
 */
export interface Evidence {
  readonly id: ComplianceEvidenceId;
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor — the project the underlying audit event
   * belongs to. Absent for tenant-level events (e.g. authz decisions,
   * admin actions before any project exists), mirroring the optional
   * `AuditEvent.projectId`.
   */
  readonly projectId?: ProjectId;
  readonly kind: EvidenceKind;
  readonly timestamp: Timestamp;
  readonly actor?: EvidenceActor;
  readonly subject?: EvidenceSubject;
  readonly outcome?: EvidenceOutcome;
  readonly payload: EvidencePayload;
  readonly provenanceRef?: ProvenanceRef;
  readonly signature?: EvidenceSignature;
}

/**
 * Alias exposing the public wire type under the framework-standard name.
 * `ComplianceEvidence` and `Evidence` are the same type.
 */
export type ComplianceEvidence = Evidence;

/**
 * Optional signer. If a caller wires one up (typically backed by a
 * signing key), every emitted record is signed for tamper detection.
 * Absent signer = unsigned records, still valid but weaker audit story.
 */
export type EvidenceSigner = (bytes: Uint8Array, tenantId: TenantId) => Promise<EvidenceSignature>;

/**
 * Filter for `ComplianceProvider.list`. `tenantId` is required; the other
 * fields are optional and compose as AND — with only `tenantId` set, it
 * matches all evidence for the tenant.
 */
export interface ListEvidenceFilter {
  readonly tenantId: TenantId;
  readonly kind?: EvidenceKind;
  readonly runId?: RunId;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
}

/**
 * Pluggable provider — adapters forward evidence to an external
 * compliance platform or SIEM. The core `emit` API stays constant;
 * adapters translate the wire format.
 */
export interface ComplianceProvider {
  emit(evidence: EmitEvidenceInput): Promise<import('./errors.js').EmitResult>;
  list(filter: ListEvidenceFilter): Promise<import('./errors.js').ListResult>;
  describe(): { readonly name: string; readonly version: string };
}

/**
 * Caller-supplied input to `emit`. The provider fills in `id` +
 * `timestamp` + optional `signature`; everything else comes from the
 * caller.
 */
export interface EmitEvidenceInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly kind: EvidenceKind;
  readonly payload: EvidencePayload;
  readonly actor?: EvidenceActor;
  readonly subject?: EvidenceSubject;
  readonly outcome?: EvidenceOutcome;
  readonly provenanceRef?: ProvenanceRef;
  /** Override the record id (defaults to `randomUUID()`). */
  readonly id?: ComplianceEvidenceId;
  /** Override the timestamp (defaults to `now()`). Useful for backfills. */
  readonly timestamp?: Timestamp;
}

// ============ Pipeline types (record-from-run, filter, page, bundle) ============

/**
 * One model call summary attached to a run's evidence record. Redaction-
 * safe by construction: no raw prompt text, no raw completion — only
 * hashes + counts + timing + outcome. Callers that need raw content pass
 * it via `RecordFromRunOptions.rawMessages` under the explicit opt-in
 * (`RecordFromRunOptions.allowRawMessages: true`).
 */
export interface ModelCallSummary {
  readonly provider: string;
  readonly model: string;
  /** `<provider>/<model>@<date-or-version>` — matches provenance node convention. */
  readonly modelVersion?: string;
  /** SHA-256 (or similar) of the canonical prompt; caller-supplied. */
  readonly promptHash?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly outcome?: 'succeeded' | 'failed';
}

/**
 * One tool invocation summary. Same redaction discipline as
 * `ModelCallSummary` — args are hashed, not embedded.
 */
export interface ToolInvocationSummary {
  readonly toolId: string;
  /** SHA-256 (or similar) of the canonical args; caller-supplied. */
  readonly argsHash?: string;
  readonly outcome?: 'succeeded' | 'failed';
  readonly durationMs?: number;
}

/** One guardrail check outcome captured on the run. */
export interface GuardrailResultSummary {
  readonly guardrailId: string;
  readonly verdict: 'pass' | 'fail' | 'warn';
  readonly severity?: 'low' | 'medium' | 'high' | 'critical';
  /** Short human message; caller ensures no sensitive content. */
  readonly message?: string;
}

/**
 * Structured input to `generator.recordFromRun`. Represents the state of
 * a terminated run that the pipeline turns into one evidence record.
 *
 * By construction this shape is redaction-safe: model prompts and tool
 * args are hashes, guardrail messages are short strings without payload
 * content.
 */
export interface RunEvidenceContext {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly startedAt?: Timestamp;
  readonly endedAt?: Timestamp;
  readonly agentId?: AgentId;
  readonly flowId?: FlowId;
  readonly flowVersion?: string;
  readonly modelCalls?: readonly ModelCallSummary[];
  readonly toolInvocations?: readonly ToolInvocationSummary[];
  readonly guardrailResults?: readonly GuardrailResultSummary[];
  /**
   * Failure message from the terminal run. Callers redact this before
   * passing — the generator does not scan it for secrets.
   */
  readonly failureMessage?: string;
  /**
   * Free-form extra fields the caller wants on the evidence payload.
   * Additive; caller is responsible for redaction. NEVER put secrets or
   * raw user-message content here — use `RecordFromRunOptions.rawMessages`
   * for the latter (with the opt-in flag) so the redaction seam stays
   * explicit.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Options for `generator.recordFromRun`. `tenantId`, `projectId`, `runId`,
 * `kind` and `runContext` are required; everything else is optional, and
 * the generator fills in `id` + `timestamp` when absent.
 */
export interface RecordFromRunOptions {
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. The generator
   * threads this into `Evidence.projectId` on the emitted record.
   */
  readonly projectId: ProjectId;
  readonly runId: RunId;
  /**
   * Compliance-relevant event class the caller wants this record filed
   * under. The pipeline does NOT infer kind from the run outcome — the
   * caller knows why the record is being emitted.
   */
  readonly kind: EvidenceKind;
  readonly runContext: RunEvidenceContext;
  readonly actor?: EvidenceActor;
  readonly subject?: EvidenceSubject;
  readonly outcome?: EvidenceOutcome;
  /** Override the record id (defaults to `randomUUID()`). */
  readonly id?: ComplianceEvidenceId;
  /** Override the timestamp (defaults to `now()`). */
  readonly timestamp?: Timestamp;
  /** Optional provenance DAG back-reference. */
  readonly provenanceRef?: ProvenanceRef;
  /**
   * When the tenant has explicitly opted in to raw-message retention,
   * caller passes the raw messages here. They land verbatim under
   * `payload.rawMessages`. Without this opt-in, raw content stays out
   * of the record entirely.
   */
  readonly rawMessages?: readonly Readonly<Record<string, unknown>>[];
  /**
   * Must be `true` for `rawMessages` to be embedded — a belt-and-braces
   * guard so a caller can't accidentally pass raw messages without an
   * explicit opt-in acknowledgement.
   */
  readonly allowRawMessages?: boolean;
}

/**
 * Filter shape shared by evidence listing and signed export
 * (`ComplianceEvidenceGenerator.exportSigned`). `ComplianceProvider.list`
 * takes `ListEvidenceFilter` instead. Every field is optional; an empty
 * filter is "everything in the tenant". Composition is AND — all
 * populated fields must match.
 */
export interface EvidenceFilter {
  readonly runId?: RunId;
  readonly agentId?: AgentId;
  readonly flowId?: FlowId;
  readonly evidenceKind?: EvidenceKind;
  /**
   * Restrict to these kinds. An empty array matches nothing. Callers
   * applying a classifier pass its exportable kinds here, so a signed
   * bundle records exactly which kinds it covers.
   */
  readonly evidenceKinds?: readonly EvidenceKind[];
  readonly from?: Timestamp;
  readonly to?: Timestamp;
}

/** One page of evidence records from a cursor-paginated listing. */
export interface EvidencePage {
  readonly data: readonly ComplianceEvidence[];
  /** Absent when there are no more results after this page. */
  readonly nextCursor?: string;
}

/**
 * The signed export bundle envelope. Same shape family as the provenance
 * signed export + audit-bundle envelope, so verifiers can reuse the exact
 * same Ed25519 verification wrapper across all three surfaces.
 */
export interface SignedEvidenceBundle {
  readonly bundleSchemaVersion: '1.0.0';
  readonly tenantId: TenantId;
  /** Base64 of canonical JSON bytes — exactly what was signed. */
  readonly bundle: string;
  readonly algorithm: 'ed25519';
  readonly signingKeyId: SigningKeyId;
  /** Base64 of the Ed25519 signature bytes (64 bytes decoded). */
  readonly signature: string;
  /** PEM-encoded Ed25519 public key. */
  readonly publicKey: string;
  readonly canonicalization: 'sorted-key-json';
  readonly exportedAt: Timestamp;
}

/**
 * The body inside the signed bundle. Kept as a distinct exported type so
 * downstream verifiers can type the decoded bytes without duplicating the
 * shape.
 */
export interface EvidenceBundleBody {
  readonly bundleSchemaVersion: '1.0.0';
  readonly tenantId: TenantId;
  readonly filter: EvidenceFilter;
  readonly records: readonly ComplianceEvidence[];
  readonly exportedAt: Timestamp;
  /** Count of records in the bundle. */
  readonly recordCount: number;
}
