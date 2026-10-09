// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { emitLifecycleEvent } from '@kindgi/compliance';
import type { Scope } from '@kindgi/platform';
import type { EnvName } from '@kindgi/types';

import { callerIdentity } from '../caller.js';
import type { AppEnv } from '../types.js';

/** The secret and env writes the API records (the compliance lens's own kinds). */
export type WriteAuditKind =
  | 'secret-set'
  | 'secret-rotated'
  | 'secret-rotation-started'
  | 'secret-rotation-failed'
  | 'secret-revoked'
  | 'secret-hard-revoked'
  | 'env-set'
  | 'env-deleted';

export interface WriteAuditInput {
  readonly kind: WriteAuditKind;
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly outcome: 'succeeded' | 'failed';
  /** The version the write made (a secret's `versionId`, an env value's `revision`). */
  readonly version?: number;
  readonly previousVersion?: number;
  /** What the client was answered, when the backend refused. */
  readonly errorCode?: string;
  readonly hard?: boolean;
  readonly reason?: string;
  readonly writeMode?: 'create-new' | 'add-version';
  readonly rotationId?: string;
  readonly revokedValuesPurged?: true;
}

/**
 * Record a secret or env write in the audit log, at the route, where the
 * caller is known: who (the caller, as the idempotency cache names it),
 * the tenant, the scope's project, the request (`correlationId`), and what
 * the backend answered. Never the value, nor anything derived from one:
 * the record holds names, versions and the backend's answer. Best effort,
 * like every lifecycle event: a failed append is logged, never the answer.
 * Without an audit binding, nothing is recorded.
 */
export async function auditWrite(
  c: Context<AppEnv>,
  auditEvents: AuditEventBinding | undefined,
  input: WriteAuditInput,
): Promise<void> {
  if (auditEvents === undefined) return;
  const { kind, scope, ...fields } = input;
  await emitLifecycleEvent({
    ...fields,
    evidenceKind: kind,
    bindingKind: kind.startsWith('env-') ? 'env' : 'secret',
    scope,
    actor: callerIdentity(c),
    correlationId: c.get('requestId'),
    auditEvents,
    tenantId: scope.tenantId,
    ...(scope.kind === 'project' && { projectId: scope.projectId }),
  });
}
