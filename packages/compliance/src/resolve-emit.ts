// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Shared helpers for emitting `env-*` and `secret-*` audit events.
 * `EnvBinding` and `SecretBinding` implementations call
 * `emitResolveEvent` from their `resolve` paths and `emitLifecycleEvent`
 * for `set` / `delete` / `rotate` / `revoke`.
 *
 * Writes land on the single `AuditEventBinding`. Classification
 * (retention / signing / export) is a lens on top, not baked into the
 * write path.
 *
 * Design guardrails:
 *   - Framework NEVER copies a secret plaintext `value` into a payload.
 *     Payloads carry only metadata (name, version, scope,
 *     caller, errorCode).
 *   - Emission is fire-and-forget: failures inside the binding are
 *     logged (via `console.warn`) but never poison the caller's op.
 *   - The `resolveContext.caller` discriminant maps to a distinct
 *     `actor` string.
 */

import { randomUUID } from 'node:crypto';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Scope } from '@kindgi/platform';
import type { EnvName, ProjectId, TenantId, Timestamp } from '@kindgi/types';

/**
 * Uniform caller-of-resolution shape. Structurally identical to
 * `@kindgi/api.ResolveContext` (kept as a duplicate declaration here
 * to avoid a compliance → api dep cycle — TS structural typing
 * makes them assignable across the boundary).
 */
export interface ResolveContext {
  readonly runId?: string;
  readonly deploymentId?: string;
  readonly nodeId?: string;
  readonly caller: 'dispatch' | 'deploy-sync' | 'admin-cli' | 'boot-bridge';
}

/** Input to `emitResolveEvent`. */
export interface EmitResolveEventInput {
  readonly kind: 'env' | 'secret';
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly resolveContext: ResolveContext;
  readonly version?: number;
  readonly errorCode?: string;
  readonly auditEvents: AuditEventBinding;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

/**
 * Emit an `env-resolved` or `secret-resolved` audit event.
 *
 * The helper NEVER accepts nor emits the resolved value — the resolve
 * outcome carries the plaintext to the caller; the audit event carries
 * only the fact-of-resolution + version + scope + caller attribution.
 *
 * Fire-and-forget: any error is logged but swallowed. The resolve path
 * must not fail because the audit sink is unreachable.
 */
export async function emitResolveEvent(input: EmitResolveEventInput): Promise<void> {
  const kind = input.kind === 'env' ? 'env-resolved' : 'secret-resolved';
  const payload = buildResolvePayload(input);
  const actor = actorFromResolveContext(input.resolveContext);
  const event = buildEvent({
    tenantId: input.tenantId,
    projectId: input.projectId,
    kind,
    outcome: input.outcome,
    actor,
    runId: input.resolveContext.runId,
    payload,
  });
  await safeEmit(input.auditEvents, event);
}

/**
 * Input to `emitLifecycleEvent`. Used for env `set` / `delete` and
 * secret `set` / `rotate` / `revoke` — the non-resolve write ops that
 * still need audit-trail attribution.
 */
export interface EmitLifecycleEventInput {
  readonly evidenceKind: string;
  readonly bindingKind: 'env' | 'secret';
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly outcome: 'succeeded' | 'failed';
  /**
   * Caller-of-op attribution. Same shape as the resolve path — env
   * `set` from an admin CLI produces `actor = 'admin'`; a
   * deployment-sync `set` produces `actor = 'system:<deploymentId>'`.
   */
  readonly resolveContext?: ResolveContext;
  readonly version?: number;
  readonly previousVersion?: number;
  readonly errorCode?: string;
  readonly hard?: boolean;
  readonly reason?: string;
  /** A secret set's mode: a new secret, or a new version of one. */
  readonly writeMode?: 'create-new' | 'add-version';
  /** An asynchronous rotation's id (`secret-rotation-started`). */
  readonly rotationId?: string;
  /**
   * The backend dropped a revoked secret's stored values to set it again
   * (a provider that keeps them for a recovery window): the record says
   * their retention ended here.
   */
  readonly revokedValuesPurged?: true;
  /**
   * Who did it, as the API names its caller (`user:<id>`,
   * `service_account:<id>`, `session:<id>`, `token:<hash>`). Absent: from
   * `resolveContext`, as a binding emits.
   */
  readonly actor?: string;
  /** The request it came from (the API's `requestId`). */
  readonly correlationId?: string;
  readonly auditEvents: AuditEventBinding;
  readonly tenantId: TenantId;
  /** The project, for a project-scoped value; absent for a tenant- or org-scoped one. */
  readonly projectId?: ProjectId;
}

/**
 * Emit a non-resolve lifecycle event (`env-set` / `env-deleted` /
 * `secret-set` / `secret-rotated` / `secret-rotation-started` /
 * `secret-rotation-failed` / `secret-revoked` / `secret-hard-revoked`).
 * Same fire-and-forget contract as `emitResolveEvent`.
 */
export async function emitLifecycleEvent(input: EmitLifecycleEventInput): Promise<void> {
  const payload = buildLifecyclePayload(input);
  const actor =
    input.actor ??
    (input.resolveContext !== undefined
      ? actorFromResolveContext(input.resolveContext)
      : undefined);
  const event = buildEvent({
    tenantId: input.tenantId,
    ...(input.projectId !== undefined && { projectId: input.projectId }),
    kind: input.evidenceKind,
    outcome: input.outcome,
    actor,
    runId: input.resolveContext?.runId,
    ...(input.correlationId !== undefined && { correlationId: input.correlationId }),
    payload,
  });
  await safeEmit(input.auditEvents, event);
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface BuildEventInput {
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly kind: string;
  readonly outcome: string;
  readonly actor: string | undefined;
  readonly runId: string | undefined;
  readonly correlationId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function buildEvent(input: BuildEventInput): AuditEvent {
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    ...(input.projectId !== undefined && { projectId: input.projectId }),
    kind: input.kind,
    timestamp: new Date().toISOString() as unknown as Timestamp,
    actor: input.actor ?? 'user:system',
    outcome: input.outcome,
    ...(input.runId !== undefined && { runId: input.runId }),
    ...(input.correlationId !== undefined && { correlationId: input.correlationId }),
    payload: { v: 1, doc: input.payload },
  };
}

async function safeEmit(binding: AuditEventBinding, event: AuditEvent): Promise<void> {
  try {
    const result = await binding.append([event]);
    if (result.kind === 'err') {
      // eslint-disable-next-line no-console -- no injected logger here
      console.warn(`[compliance] emit ${event.kind} audit event failed: ${result.error.message}`);
    }
  } catch (cause) {
    // eslint-disable-next-line no-console -- no injected logger here
    console.warn(
      `[compliance] emit ${event.kind} audit event threw: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/**
 * Map the `resolveContext.caller` discriminant to a subject string.
 * Format matches the audit-events `actor` convention
 * (`<type>:<id>` — `agent:<runId>`, `system:<deploymentId>`, `user:admin`,
 * `user:system`).
 */
function actorFromResolveContext(ctx: ResolveContext): string | undefined {
  switch (ctx.caller) {
    case 'dispatch':
      return ctx.runId !== undefined ? `agent:${ctx.runId}` : 'agent:unknown';
    case 'deploy-sync':
      return ctx.deploymentId !== undefined ? `system:${ctx.deploymentId}` : 'system:deploy';
    case 'admin-cli':
      return 'user:admin';
    case 'boot-bridge':
      return 'user:system';
    default:
      return undefined;
  }
}

function scopeToPayloadShape(scope: Scope): Readonly<Record<string, unknown>> {
  if (scope.kind === 'tenant') {
    return { kind: 'tenant', tenantId: scope.tenantId as unknown as string };
  }
  if (scope.kind === 'org') {
    return {
      kind: 'org',
      tenantId: scope.tenantId as unknown as string,
      orgId: scope.orgId as unknown as string,
    };
  }
  return {
    kind: 'project',
    tenantId: scope.tenantId as unknown as string,
    projectId: scope.projectId as unknown as string,
  };
}

/**
 * Build the resolve-event payload. Structural guarantee: NO `value`
 * key ever appears. Every field is either metadata (name,
 * version, scope) or attribution (caller, errorCode).
 */
function buildResolvePayload(input: EmitResolveEventInput): Readonly<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    scope: scopeToPayloadShape(input.scope),
    envName: input.envName as unknown as string,
    name: input.name,
    caller: input.resolveContext.caller,
  };
  if (input.version !== undefined) payload.recordVersion = input.version;
  if (input.errorCode !== undefined) payload.errorCode = input.errorCode;
  if (input.resolveContext.nodeId !== undefined) payload.nodeId = input.resolveContext.nodeId;
  if (input.resolveContext.runId !== undefined) payload.runId = input.resolveContext.runId;
  return payload;
}

/**
 * Build the lifecycle-event payload. Same structural rule as
 * `buildResolvePayload` — never carries the value.
 */
function buildLifecyclePayload(input: EmitLifecycleEventInput): Readonly<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    scope: scopeToPayloadShape(input.scope),
    envName: input.envName as unknown as string,
    name: input.name,
  };
  if (input.resolveContext !== undefined) payload.caller = input.resolveContext.caller;
  if (input.version !== undefined) payload.recordVersion = input.version;
  if (input.previousVersion !== undefined) payload.previousVersion = input.previousVersion;
  if (input.errorCode !== undefined) payload.errorCode = input.errorCode;
  if (input.hard !== undefined) payload.hard = input.hard;
  if (input.reason !== undefined) payload.reason = input.reason;
  if (input.writeMode !== undefined) payload.writeMode = input.writeMode;
  if (input.rotationId !== undefined) payload.rotationId = input.rotationId;
  if (input.revokedValuesPurged === true) payload.revokedValuesPurged = true;
  if (input.resolveContext?.nodeId !== undefined) payload.nodeId = input.resolveContext.nodeId;
  if (input.resolveContext?.runId !== undefined) payload.runId = input.resolveContext.runId;
  return payload;
}
