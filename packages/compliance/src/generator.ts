// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AuditEvent } from '@kindgi/audit-events';
import type { ComplianceEvidenceId, Result, RunId, SigningKeyId, TenantId } from '@kindgi/types';

import type { ComplianceError } from './errors.js';
import type {
  ActorKind,
  ComplianceEvidence,
  EvidenceActor,
  EvidenceFilter,
  EvidenceOutcome,
  EvidencePayload,
  RecordFromRunOptions,
  SignedEvidenceBundle,
} from './types.js';

/**
 * The runtime service that turns terminated runs into audit-event
 * records and produces signed export bundles.
 *
 * Public interface — deployments plug an implementation into
 * `@kindgi/api` via `CreateAppInput.complianceGenerator`. The Kindgi
 * runtime provides one; callers may supply their own. Implementations
 * may expose additional subscription / auto-emit methods; this interface
 * is the minimum surface `@kindgi/api` consumes.
 */
export interface ComplianceEvidenceGenerator {
  recordFromRun(
    options: RecordFromRunOptions,
  ): Promise<Result<{ readonly evidenceId: ComplianceEvidenceId }, ComplianceError>>;

  exportSigned(
    tenantId: TenantId,
    filter: EvidenceFilter,
    signingKeyId: SigningKeyId,
  ): Promise<Result<SignedEvidenceBundle, ComplianceError>>;

  describe(): { readonly name: string; readonly version: string };
}

/**
 * Materialize a `ComplianceEvidence` wire record from an `AuditEvent`.
 * The bundle body carries `ComplianceEvidence[]` for wire-shape
 * stability — regulators verifying bundles read one record shape
 * regardless of how events are stored.
 *
 * Pure function — no I/O, no random. Safe to call from any layer.
 */
export function auditEventToEvidence(event: AuditEvent): ComplianceEvidence {
  return {
    id: event.id as ComplianceEvidenceId,
    tenantId: event.tenantId,
    // Tenant-level events carry no project; the key is omitted, never `undefined`.
    ...(event.projectId !== undefined && { projectId: event.projectId }),
    kind: event.kind,
    timestamp: event.timestamp,
    payload: extractDoc(event.payload) as EvidencePayload,
    ...(event.outcome !== undefined && { outcome: event.outcome as EvidenceOutcome }),
    ...(event.runId !== undefined && { provenanceRef: { runId: event.runId as RunId } }),
    ...actorOf(event.actor),
  };
}

const ACTOR_KINDS: ReadonlySet<string> = new Set<ActorKind>([
  'user',
  'agent',
  'system',
  'admin',
  'external',
]);

/**
 * The event's actor, as evidence names one: `<kind>:<id>` (or a bare
 * `<kind>`, as the evidence generator writes it) is `{ kind, id }`. An
 * actor of a kind evidence can't name is left out.
 */
function actorOf(actor: string): { readonly actor?: EvidenceActor } {
  const colon = actor.indexOf(':');
  const kind = colon === -1 ? actor : actor.slice(0, colon);
  if (!ACTOR_KINDS.has(kind)) return {};
  const id = colon === -1 ? '' : actor.slice(colon + 1);
  return { actor: { kind: kind as ActorKind, ...(id.length > 0 && { id }) } };
}

function extractDoc(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const inner = payload.doc;
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Readonly<Record<string, unknown>>;
  }
  return payload;
}
