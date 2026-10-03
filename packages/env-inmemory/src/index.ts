// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/env-inmemory` — reference in-memory `EnvBinding` for
 * dev + tests. Refuses to boot in production.
 *
 * Storage: `Map<scopeKey(scope), Map<EnvName, Map<name, EnvRecord>>>`.
 * Resolution walks most-specific-wins: `project → tenant` and
 * `org → tenant`. A project scope skips the `org` middle step because
 * this adapter has no project → org relation; the full walk described
 * on `Scope` in `@kindgi/platform` is `project → org → tenant`.
 */

import type {
  EnvBinding,
  EnvDeleteInput,
  EnvDeleteOutcome,
  EnvError,
  EnvGetInput,
  EnvListInput,
  EnvListPage,
  EnvRecord,
  EnvResolveInput,
  EnvResolveOutcome,
  EnvSetInput,
  EnvSetOutcome,
} from '@kindgi/api';
import type { AuditEventBinding } from '@kindgi/audit-events';
import type { ResolveContext as ComplianceResolveContext } from '@kindgi/compliance';
import { emitLifecycleEvent, emitResolveEvent } from '@kindgi/compliance';
import type { Scope } from '@kindgi/platform';
import { scopeKey } from '@kindgi/platform';
import type { EnvName, ProjectId, Result, TenantId } from '@kindgi/types';

/**
 * Options for the in-memory env binding.
 */
export interface InMemoryEnvBindingOptions {
  /**
   * Set `true` to allow booting under `NODE_ENV === 'production'`.
   * Default `false` — `createInMemoryEnvBinding` throws when the process
   * is in production without this flag. Never set in production unless
   * the process is truly a dev-shape (e.g. an isolated test container
   * running with `NODE_ENV=production` for parity testing).
   */
  readonly productionSafe?: boolean;
  /**
   * Deterministic clock for tests. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Optional unified audit binding — when supplied, `set`, `resolve`,
   * and a `delete` that removed an entry each emit an `env-*`
   * `AuditEvent`. Emission is awaited before the op returns; emission
   * failures are logged (`console.warn`) but never fail the caller's op.
   *
   * `tenantId` + `projectId` must be provided alongside — emission is
   * enabled only when all three are set, and every emitted record is
   * attributed to this tenant + project.
   */
  readonly auditEvents?: AuditEventBinding;
  readonly tenantId?: TenantId;
  readonly projectId?: ProjectId;
}

export function createInMemoryEnvBinding(options: InMemoryEnvBindingOptions = {}): EnvBinding {
  if (!options.productionSafe && process.env.NODE_ENV === 'production') {
    throw new Error(
      '@kindgi/env-inmemory refuses to boot with NODE_ENV=production; supply { productionSafe: true } if this is a parity test.',
    );
  }
  const now = options.now ?? (() => Date.now());
  const auditEvents = options.auditEvents;
  const evidenceTenant = options.tenantId;
  const evidenceProject = options.projectId;
  const canEmit =
    auditEvents !== undefined && evidenceTenant !== undefined && evidenceProject !== undefined;

  // scopeKey → envName → name → record.
  const store = new Map<string, Map<EnvName, Map<string, EnvRecord>>>();

  const bucket = (scope: Scope, envName: EnvName): Map<string, EnvRecord> => {
    const sk = scopeKey(scope);
    let byEnv = store.get(sk);
    if (byEnv === undefined) {
      byEnv = new Map();
      store.set(sk, byEnv);
    }
    let byName = byEnv.get(envName);
    if (byName === undefined) {
      byName = new Map();
      byEnv.set(envName, byName);
    }
    return byName;
  };

  const parents = (scope: Scope): Scope[] => {
    // Most-specific first; caller iterates and returns first hit.
    const chain: Scope[] = [scope];
    if (scope.kind === 'project') {
      chain.push({ kind: 'tenant', tenantId: scope.tenantId as TenantId });
    } else if (scope.kind === 'org') {
      chain.push({ kind: 'tenant', tenantId: scope.tenantId as TenantId });
    }
    return chain;
  };

  const seqRef = { seq: 0 };
  const nextTimestamp = (): string => {
    seqRef.seq += 1;
    return new Date(now() + seqRef.seq).toISOString();
  };

  return {
    async list(input: EnvListInput): Promise<EnvListPage> {
      const byName = bucket(input.scope, input.envName);
      const all: EnvRecord[] = [];
      for (const rec of byName.values()) {
        if (
          input.namePrefix !== undefined &&
          input.namePrefix.length > 0 &&
          !rec.name.startsWith(input.namePrefix)
        ) {
          continue;
        }
        if (input.tagFilter !== undefined) {
          if (!matchesTagFilter(rec, input.tagFilter)) continue;
        }
        all.push(rec);
      }
      all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { data: all.slice(0, input.limit) };
    },

    async get(input: EnvGetInput): Promise<EnvRecord | null> {
      const byName = bucket(input.scope, input.envName);
      return byName.get(input.name) ?? null;
    },

    async resolve(input: EnvResolveInput): Promise<Result<EnvResolveOutcome, EnvError>> {
      for (const s of parents(input.scope)) {
        const byName = bucket(s, input.envName);
        const rec = byName.get(input.name);
        if (rec !== undefined) {
          if (canEmit) {
            await emitResolveEvent({
              kind: 'env',
              scope: input.scope,
              envName: input.envName,
              name: input.name,
              outcome: 'succeeded',
              version: rec.revision,
              resolveContext: input.resolveContext as ComplianceResolveContext,
              auditEvents: auditEvents!,
              tenantId: evidenceTenant,
              projectId: evidenceProject,
            });
          }
          return {
            kind: 'ok',
            value: { name: rec.name, value: rec.value, revision: rec.revision },
          };
        }
      }
      if (canEmit) {
        await emitResolveEvent({
          kind: 'env',
          scope: input.scope,
          envName: input.envName,
          name: input.name,
          outcome: 'failed',
          errorCode: 'env-not-found',
          resolveContext: input.resolveContext as ComplianceResolveContext,
          auditEvents: auditEvents!,
          tenantId: evidenceTenant,
          projectId: evidenceProject,
        });
      }
      return {
        kind: 'err',
        error: {
          code: 'env-not-found',
          message: `No env value at scope + envName for name "${input.name}"`,
          name: input.name,
        },
      };
    },

    async set(input: EnvSetInput): Promise<EnvSetOutcome> {
      const byName = bucket(input.scope, input.envName);
      const existing = byName.get(input.name);
      if (input.ifRevision !== undefined) {
        const current = existing?.revision ?? 0;
        if (current !== input.ifRevision) {
          if (canEmit) {
            await emitLifecycleEvent({
              evidenceKind: 'env-set',
              bindingKind: 'env',
              scope: input.scope,
              envName: input.envName,
              name: input.name,
              outcome: 'failed',
              errorCode: 'env-write-conflict',
              version: current,
              auditEvents: auditEvents!,
              tenantId: evidenceTenant,
              projectId: evidenceProject,
            });
          }
          return { kind: 'revision-conflict', currentRevision: current };
        }
      }
      const createdAt = existing?.createdAt ?? nextTimestamp();
      const updatedAt = nextTimestamp();
      const previousRevision = existing?.revision;
      const record: EnvRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        value: input.value,
        revision: (existing?.revision ?? 0) + 1,
        createdAt,
        updatedAt,
        ...(input.tags !== undefined && { tags: input.tags }),
      };
      byName.set(input.name, record);
      if (canEmit) {
        await emitLifecycleEvent({
          evidenceKind: 'env-set',
          bindingKind: 'env',
          scope: input.scope,
          envName: input.envName,
          name: input.name,
          outcome: 'succeeded',
          version: record.revision,
          ...(previousRevision !== undefined && { previousVersion: previousRevision }),
          auditEvents: auditEvents!,
          tenantId: evidenceTenant,
          projectId: evidenceProject,
        });
      }
      return { kind: 'ok', record };
    },

    async delete(input: EnvDeleteInput): Promise<EnvDeleteOutcome> {
      const byName = bucket(input.scope, input.envName);
      const had = byName.delete(input.name);
      if (had && canEmit) {
        await emitLifecycleEvent({
          evidenceKind: 'env-deleted',
          bindingKind: 'env',
          scope: input.scope,
          envName: input.envName,
          name: input.name,
          outcome: 'succeeded',
          auditEvents: auditEvents!,
          tenantId: evidenceTenant,
          projectId: evidenceProject,
        });
      }
      return { deleted: had };
    },
  };
}

function matchesTagFilter(rec: EnvRecord, filter: Readonly<Record<string, string>>): boolean {
  const tags = rec.tags;
  if (tags === undefined) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (tags[k] !== v) return false;
  }
  return true;
}
