// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a secret an item names is read: decided once, when the item is
 * registered, and recorded on it. An MCP endpoint's credentials, a tool's
 * secrets and a webhook trigger's signing secret are then read at that
 * scope only, never another.
 *
 * At registration, the named secret is looked for at the item's own scope,
 * then its project's org, then the tenant, but only at the scopes the
 * person registering administers (as reading or writing a secret there
 * needs). The first that has it is recorded. If none has it yet (an item
 * registered before its secret is set), the broadest scope they administer
 * is: the tenant for a tenant admin, the project for a project admin. A
 * deployment's tools, deployed or promoted, record the scope that
 * deployment's secrets sync writes instead (`deploymentSecretScope`), when
 * the caller administers it: a call then reads what the sync stores. A
 * caller who administers none of them records none, and the
 * item reads no secret until an admin records it again: a tool by
 * publishing a new version, an MCP endpoint by unregistering it and
 * registering it again, a webhook trigger by naming its secret again (an
 * update).
 *
 * Nothing here refuses: what's recorded doesn't say whether the name
 * exists at a scope the caller can't read. A secret set later at another
 * scope changes nothing until the scope is recorded again, as above; one
 * removed from the recorded scope is missing, never read from a broader one.
 */

import type { AuditEventBinding } from '@kindgi/audit-events';
import { emitResolveEvent } from '@kindgi/compliance';
import type { Logger } from '@kindgi/log';
import type { ProjectBinding, Scope } from '@kindgi/platform';
import type { ToolManifest } from '@kindgi/tools';
import type {
  EnvName,
  OrgId,
  ProjectId,
  RecordedSecretScope,
  Result,
  TenantId,
} from '@kindgi/types';
import type { Context } from 'hono';

import type { Authorizer } from './middleware/authorize.js';
import { scopeResourceRef } from './routes/scope-params.js';
import type {
  SecretBinding,
  SecretError,
  SecretRecord,
  SecretResolveInput,
  SecretResolveOutcome,
} from './secrets-binding.js';
import type { AppEnv } from './types.js';

/** The scopes a secret named by an item at `item` is looked for at, narrowest first. */
export function secretScopeChain(item: Scope, orgId: OrgId | undefined): readonly Scope[] {
  const tenant: Scope = { kind: 'tenant', tenantId: item.tenantId };
  if (item.kind === 'tenant') return [tenant];
  if (item.kind === 'org') return [item, tenant];
  return [
    item,
    ...(orgId !== undefined ? [{ kind: 'org' as const, tenantId: item.tenantId, orgId }] : []),
    tenant,
  ];
}

export interface NamedSecretScopeInput {
  readonly secrets: Pick<SecretBinding, 'get'>;
  /** Whether the caller administers `scope` (as the secrets routes ask). Absent: every scope (no authorization). */
  readonly administers?: (scope: Scope) => Promise<boolean>;
  /** `secretScopeChain` of the item's scope. */
  readonly chain: readonly Scope[];
  /**
   * The env the secret is read in. Absent (the deployment didn't say which
   * env it serves): nothing is looked up, and the broadest scope the caller
   * administers is recorded, which tells nothing about what exists.
   */
  readonly envName: EnvName | undefined;
  readonly name: string;
  /**
   * The scope to record when none of the chain has the name, in place of
   * the broadest the caller administers: where a deployment's secrets sync
   * writes. Used only when it's in `chain` and the caller administers it;
   * otherwise the broadest administered scope is recorded, as without it.
   */
  readonly fallback?: Scope;
}

/**
 * Where a deployment's secrets sync writes (`POST
 * /v1/deployments/{deploymentId}/secrets`), from the deployment record's
 * `projectId`. The sync never accepts a caller-supplied scope override on
 * the wire (CRITICAL — scope MUST be inferred server-side to prevent
 * tenant/project confusion attacks).
 *
 * A deployment stored in a named project syncs its secrets into that
 * project. One stored with no `projectId` syncs them tenant-wide, though
 * its tools are in the Default project: a deploy that named no project, or
 * a promotion into the Default project. A deploy and a promotion record
 * this scope for a secret their tools name that's set nowhere yet, so a
 * call reads what the sync stores.
 */
export function deploymentSecretScope(tenantId: TenantId, projectId: ProjectId | undefined): Scope {
  if (projectId !== undefined) return { kind: 'project', tenantId, projectId };
  return { kind: 'tenant', tenantId };
}

/** The scope to record for one named secret; `null` when the caller administers none of the chain. */
export async function namedSecretScope(input: NamedSecretScopeInput): Promise<Scope | null> {
  return (await findNamedSecretScope(input))?.scope ?? null;
}

/**
 * The scope `namedSecretScope` records, and the secret there when it was
 * found: what a run will read. Absent `found`: the secret isn't there (the
 * fallback, else the broadest administered scope, is recorded), or nothing
 * was looked up (no `envName`). `null` when the caller administers none of the chain.
 */
export async function findNamedSecretScope(
  input: NamedSecretScopeInput,
): Promise<{ readonly scope: Scope; readonly found?: SecretRecord } | null> {
  let ceiling: Scope | null = null;
  let fallback: Scope | null = null;
  for (const scope of input.chain) {
    if (input.administers !== undefined && !(await input.administers(scope))) continue;
    ceiling = scope;
    if (input.fallback !== undefined && sameScope(scope, input.fallback)) fallback = scope;
    if (input.envName === undefined) continue;
    const found = await input.secrets.get({ scope, envName: input.envName, name: input.name });
    if (found !== null) return { scope, found };
  }
  const recorded = fallback ?? ceiling;
  return recorded === null ? null : { scope: recorded };
}

export type { RecordedSecretScope };

export function recordedSecretScope(scope: Scope): RecordedSecretScope {
  if (scope.kind === 'org') return { kind: 'org', orgId: scope.orgId };
  if (scope.kind === 'project') return { kind: 'project', projectId: scope.projectId };
  return { kind: 'tenant' };
}

/** The scope a recorded one names, in `tenantId`. */
export function scopeOfRecorded(tenantId: TenantId, recorded: RecordedSecretScope): Scope {
  if (recorded.kind === 'org') return { kind: 'org', tenantId, orgId: recorded.orgId };
  if (recorded.kind === 'project')
    return { kind: 'project', tenantId, projectId: recorded.projectId };
  return { kind: 'tenant', tenantId };
}

/**
 * Read an item's secret at the scope recorded for it, and only there: an
 * exact read. A store that answers from another scope anyway, or doesn't
 * say which (one that ignores `exact`, or doesn't report `scope`), is
 * refused as the in-tree stores say a secret isn't set, and the refusal is
 * audited (scope and name, never the value). An audit append that fails
 * is logged at `warn` through `log`, when given.
 */
export async function resolveAtScope(
  secrets: Pick<SecretBinding, 'resolve'>,
  input: Omit<SecretResolveInput, 'exact'>,
  auditEvents?: AuditEventBinding,
  log?: Logger,
): Promise<Result<SecretResolveOutcome, SecretError>> {
  const resolved = await secrets.resolve({ ...input, exact: true });
  if (resolved.kind === 'err') return resolved;
  const at = resolved.value.scope;
  if (at !== undefined && sameScope(at, input.scope)) return resolved;
  if (auditEvents !== undefined) {
    await emitResolveEvent({
      kind: 'secret',
      scope: input.scope,
      envName: input.envName,
      name: input.name,
      outcome: 'failed',
      errorCode: 'secret-scope-mismatch',
      resolveContext: input.resolveContext,
      auditEvents,
      tenantId: input.scope.tenantId,
      ...(input.scope.kind === 'project' && { projectId: input.scope.projectId }),
      ...(log !== undefined && { log }),
    });
  }
  return {
    kind: 'err',
    error: {
      code: 'secret-not-found',
      message: `No secret at scope + envName for name "${input.name}".`,
      name: input.name,
    },
  };
}

/** Whether two scopes are the same one. */
export function sameScope(a: Scope, b: Scope): boolean {
  if (a.tenantId !== b.tenantId) return false;
  if (a.kind === 'project') return b.kind === 'project' && a.projectId === b.projectId;
  if (a.kind === 'org') return b.kind === 'org' && a.orgId === b.orgId;
  return b.kind === 'tenant';
}

/** Each named secret's scope to record (`null` for none usable), by name. */
export async function namedSecretScopes(
  input: Omit<NamedSecretScopeInput, 'name' | 'envName'> & {
    readonly names: readonly NamedSecret[];
  },
): Promise<Readonly<Record<string, RecordedSecretScope | null>>> {
  const out: Record<string, RecordedSecretScope | null> = {};
  for (const { envName, name } of input.names) {
    const scope = await namedSecretScope({ ...input, envName, name });
    out[name] = scope === null ? null : recordedSecretScope(scope);
  }
  return out;
}

/** What a route needs to record where an item's secrets are read. */
export interface SecretScopeDeps {
  readonly secrets?: Pick<SecretBinding, 'get'> | undefined;
  readonly projects?: Pick<ProjectBinding, 'get'> | undefined;
  readonly authorizer?: Authorizer | undefined;
}

/**
 * Whether the caller administers a scope (`admin` on it), the question a
 * write that records a secret's scope asks of each scope it could record.
 * `undefined` without an authorizer: every scope counts.
 */
export function callerAdministers(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  tenantId: TenantId,
): ((scope: Scope) => Promise<boolean>) | undefined {
  if (authorizer === undefined) return undefined;
  return (scope) => authorizer.can(c, 'admin', scopeResourceRef(scope, tenantId));
}

/**
 * The scopes to record for the secrets an item at `item` names, by name,
 * as the request's caller registers it; `undefined` without a secrets store
 * (nothing is recorded, as before). `fallback`: what a name set nowhere is
 * recorded at, as `NamedSecretScopeInput.fallback`.
 */
export async function secretScopesFor(
  c: Context<AppEnv>,
  deps: SecretScopeDeps,
  item: Scope,
  names: readonly NamedSecret[],
  fallback?: Scope,
): Promise<Readonly<Record<string, RecordedSecretScope | null>> | undefined> {
  if (deps.secrets === undefined || names.length === 0) return undefined;
  const orgId =
    item.kind === 'project'
      ? (await deps.projects?.get(item.tenantId, item.projectId))?.orgId
      : undefined;
  const administers = callerAdministers(c, deps.authorizer, item.tenantId);
  return namedSecretScopes({
    secrets: deps.secrets,
    chain: secretScopeChain(item, orgId),
    ...(administers !== undefined && { administers }),
    ...(fallback !== undefined && { fallback }),
    names,
  });
}

/** A secret an item names, and the env it's read in (absent: not known here; see `NamedSecretScopeInput.envName`). */
export interface NamedSecret {
  readonly envName: EnvName | undefined;
  readonly name: string;
}

/**
 * The secrets a tool names, with the env each is read in: a declarative
 * tool's `secretRef` in its own env, and the ones its code declares in the
 * env the runtime serves (`envName`; absent, each is recorded without a
 * lookup). Scopes are recorded by name: a declared secret with the name of
 * the `secretRef` shares its record, decided in the `secretRef`'s env.
 */
export function toolSecretRefs(
  manifest: Pick<ToolManifest, 'needsSpec' | 'spec'>,
  envName: EnvName | undefined,
): NamedSecret[] {
  const refs: NamedSecret[] = [];
  const auth = manifest.spec?.authorization;
  // A connection's authorization sends the connection's token, not a secret.
  if (auth !== undefined && auth.kind !== 'connection') {
    refs.push({ envName: auth.secretRef.envName as EnvName, name: auth.secretRef.name });
  }
  for (const name of Object.keys(manifest.needsSpec?.secrets ?? {})) {
    if (!refs.some((r) => r.name === name)) refs.push({ envName, name });
  }
  return refs;
}
