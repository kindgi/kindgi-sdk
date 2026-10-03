// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// ============ Wire types ============
export { EVIDENCE_KINDS } from './types.js';
export type {
  ActorKind,
  ComplianceEvidence,
  ComplianceProvider,
  EmitEvidenceInput,
  Evidence,
  EvidenceActor,
  EvidenceKind,
  EvidenceOutcome,
  EvidencePayload,
  EvidenceSignature,
  EvidenceSigner,
  EvidenceSubject,
  ListEvidenceFilter,
  ProvenanceRef,
} from './types.js';

// ============ Pipeline data types ============
export type {
  EvidenceBundleBody,
  EvidenceFilter,
  EvidencePage,
  GuardrailResultSummary,
  ModelCallSummary,
  RecordFromRunOptions,
  RunEvidenceContext,
  SignedEvidenceBundle,
  ToolInvocationSummary,
} from './types.js';

// ============ Errors ============
export type {
  ComplianceError,
  EmitResult,
  InvalidCursorError,
  InvalidEvidenceError,
  ListResult,
  PersistenceError,
  ProjectNotFoundError,
  SignerFailureError,
  SigningFailureError,
  SigningKeyMissingError,
  UnsupportedVersionError,
} from './errors.js';

// ============ Classifier ============
export type {
  Classification,
  ComplianceClassifierFile,
  LoadedClassifier,
} from './classifier.js';

// ============ Generator interface + pure transform ============
export type { ComplianceEvidenceGenerator } from './generator.js';
export { auditEventToEvidence } from './generator.js';

// ============ Resolve + lifecycle event emitters ============
export { emitLifecycleEvent, emitResolveEvent } from './resolve-emit.js';
export type {
  EmitLifecycleEventInput,
  EmitResolveEventInput,
  ResolveContext,
} from './resolve-emit.js';
