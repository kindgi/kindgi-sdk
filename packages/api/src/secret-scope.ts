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
 * caller who administers none of them records none, and the item reads no
 * secret until an admin registers it again.
 *
 * Nothing here refuses: what's recorded doesn't say whether the name
 * exists at a scope the caller can't read. A secret set later at another
 * scope changes nothing until the item is registered again; one removed
 * from the recorded scope is missing, never read from a broader one.
 */

import type { ProjectBinding, Scope } from '@kindgi/platform';
import type { ToolManifest } from '@kindgi/tools';
import type { EnvName, OrgId, RecordedSecretScope, TenantId } from '@kindgi/types';
import type { Context } from 'hono';

import type { Authorizer } from './middleware/authorize.js';
import { scopeResourceRef } from './routes/scope-params.js';
import type { SecretBinding } from './secrets-binding.js';
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
  readonly envName: EnvName;
  readonly name: string;
}

/** The scope to record for one named secret; `null` when the caller administers none of the chain. */
export async function namedSecretScope(input: NamedSecretScopeInput): Promise<Scope | null> {
  let ceiling: Scope | null = null;
  for (const scope of input.chain) {
    if (input.administers !== undefined && !(await input.administers(scope))) continue;
    ceiling = scope;
    const found = await input.secrets.get({ scope, envName: input.envName, name: input.name });
    if (found !== null) return scope;
  }
  return ceiling;
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

/** Each named secret's scope to record (`null` for none usable), by name. */
export async function namedSecretScopes(
  input: Omit<NamedSecretScopeInput, 'name' | 'envName'> & {
    readonly names: readonly { readonly envName: EnvName; readonly name: string }[];
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
 * The scopes to record for the secrets an item at `item` names, by name,
 * as the request's caller registers it; `undefined` without a secrets store
 * (nothing is recorded, as before).
 */
export async function secretScopesFor(
  c: Context<AppEnv>,
  deps: SecretScopeDeps,
  item: Scope,
  names: readonly { readonly envName: EnvName; readonly name: string }[],
): Promise<Readonly<Record<string, RecordedSecretScope | null>> | undefined> {
  if (deps.secrets === undefined || names.length === 0) return undefined;
  const orgId =
    item.kind === 'project'
      ? (await deps.projects?.get(item.tenantId, item.projectId))?.orgId
      : undefined;
  const authorizer = deps.authorizer;
  return namedSecretScopes({
    secrets: deps.secrets,
    chain: secretScopeChain(item, orgId),
    ...(authorizer !== undefined && {
      administers: (scope: Scope) =>
        authorizer.can(c, 'admin', scopeResourceRef(scope, item.tenantId)),
    }),
    names,
  });
}

/**
 * The secrets a tool names, with the env each is read in: a declarative
 * tool's `secretRef` in its own env, and the ones its code declares in the
 * env the runtime serves (left out without one: not recorded).
 */
export function toolSecretRefs(
  manifest: Pick<ToolManifest, 'needsSpec' | 'spec'>,
  envName: EnvName | undefined,
): { readonly envName: EnvName; readonly name: string }[] {
  const refs: { readonly envName: EnvName; readonly name: string }[] = [];
  const ref = manifest.spec?.authorization?.secretRef;
  if (ref !== undefined) refs.push({ envName: ref.envName as EnvName, name: ref.name });
  if (envName !== undefined) {
    for (const name of Object.keys(manifest.needsSpec?.secrets ?? {})) {
      if (!refs.some((r) => r.name === name)) refs.push({ envName, name });
    }
  }
  return refs;
}
