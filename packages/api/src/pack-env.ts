// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack's declared environment (`index.json`'s `env`) on a server that runs
 * a pack service per deployment: where each declared name's value is set.
 *
 * Each name is looked for in the env store at the deployment's project, then
 * the project's org, then the tenant, as a tool's env values are (most
 * specific wins). A tenant-wide deployment is read at the tenant's Default
 * project, where its primitives went.
 *
 * A secret isn't served into a pack service's environment yet. A name that's
 * set only as a secret is `secret-not-yet`; a tool reads a secret per call
 * instead (`ctx.secrets`). A name that's set both as a secret and as a plain
 * value is `ambiguous`, naming both scopes. Neither is ever served.
 *
 * Every read here is a `get`, never a `resolve`. A check tells where each
 * name is set. Only `packEnvValues`, the orchestrator's read, returns values,
 * and it audits each one it returns.
 */

import { createHash } from 'node:crypto';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { emitResolveEvent } from '@kindgi/compliance';
import type { Logger } from '@kindgi/log';
import type { ProjectBinding, Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId } from '@kindgi/types';

import type { EnvBinding, EnvRecord } from './env-binding.js';
import { secretScopeChain } from './secret-scope.js';
import type { SecretBinding, SecretRecord } from './secrets-binding.js';

/** A pack's declared process environment, as `index.json` carries it: both lists sorted. */
export interface PackEnvDeclaration {
  /** Names the pack service needs, set and non-empty, to be ready. */
  readonly required: readonly string[];
  /** Names the pack reads when present. */
  readonly optional: readonly string[];
}

/** Where a value is set: `id` is the project's or the org's, and absent for the tenant. */
export interface PackEnvScopeRef {
  readonly kind: 'project' | 'org' | 'tenant';
  readonly id?: string;
}

/**
 * Why a deployment's pack service can't be given its declared environment,
 * in the order it's reported:
 * - `pack-env-ambiguous`: a name is set both as a secret and as a plain value;
 * - `pack-env-secret-not-yet`: a name is set only as a secret, and a secret
 *   isn't served into a pack service's environment yet;
 * - `pack-env-missing`: a required name is set nowhere.
 */
export const PACK_ENV_PROBLEM_CODES = [
  'pack-env-ambiguous',
  'pack-env-secret-not-yet',
  'pack-env-missing',
] as const;

export type PackEnvProblemCode = (typeof PACK_ENV_PROBLEM_CODES)[number];

/**
 * Why a ready pack service runs on the values it was last given, as its
 * endpoint shows it (`packEnvProblem`): one of `PACK_ENV_PROBLEM_CODES`, so
 * the newest can't be given to it, or `pack-env-update-failed`: they were
 * given, and its revision with them didn't start, so the last ready one
 * serves. That one is tried again for `PACK_ENV_RETRY_MS` after it's first
 * recorded; setting the values again is a new revision, which is tried too.
 */
export const PACK_ENV_HELD_CODES = [...PACK_ENV_PROBLEM_CODES, 'pack-env-update-failed'] as const;

export type PackEnvHeldCode = (typeof PACK_ENV_HELD_CODES)[number];

/** How long a revision held as `pack-env-update-failed` is listed to be tried again: an hour. */
export const PACK_ENV_RETRY_MS = 60 * 60_000;

/** One declared name: where it's set, and why it can't be served, if it can't. */
export interface PackEnvNameStatus {
  readonly name: string;
  readonly required: boolean;
  /** What it's set as. `null` when it's set nowhere. */
  readonly kind: 'env' | 'secret' | null;
  /** Where it's set: the plain value's scope when `ambiguous`. `null` when it's set nowhere. */
  readonly scope: PackEnvScopeRef | null;
  /** Set nowhere, as a plain value or a secret (optional names too). */
  readonly missing: boolean;
  /** Why it can't be served. Absent when it can, and for an optional name set nowhere. */
  readonly problem?: 'ambiguous' | 'secret-not-yet' | 'missing';
  /** `ambiguous` only: the secret's scope. */
  readonly secretScope?: PackEnvScopeRef;
}

export interface PackEnvCheck {
  /**
   * Changes whenever what would be served changes: a value written or
   * removed, a secret set or revoked. It's made from scopes, row ids,
   * revisions and update times, never from a value.
   */
  readonly revision: string;
  /** Every declared name, required ones first, each list in name order. */
  readonly names: readonly PackEnvNameStatus[];
  /** The first reason in `PACK_ENV_PROBLEM_CODES` order, when there's one. */
  readonly problem?: PackEnvProblemCode;
}

export interface PackEnvDeps {
  readonly env: Pick<EnvBinding, 'get'>;
  /** Absent: no secret store, so nothing is ever `secret-not-yet` or `ambiguous`. */
  readonly secrets?: Pick<SecretBinding, 'get'>;
  readonly projects?: Pick<ProjectBinding, 'get' | 'getDefault'>;
}

export interface PackEnvCheckInput {
  readonly tenantId: TenantId;
  /** The deployment's project. Absent: a tenant-wide deployment, read at the Default project. */
  readonly projectId?: ProjectId;
  /** The env the server serves (`KINDGI_ENV`). */
  readonly envName: EnvName;
  readonly declaration: PackEnvDeclaration;
}

/** Where each declared name is set, at the deployment's scopes, without reading a value. */
export async function packEnvCheck(
  deps: PackEnvDeps,
  input: PackEnvCheckInput,
): Promise<PackEnvCheck> {
  return (await readPackEnv(deps, input)).check;
}

export interface PackEnvValuesInput extends PackEnvCheckInput {
  readonly deploymentId: string;
  readonly auditEvents?: AuditEventBinding;
  readonly log?: Logger;
}

/**
 * The check, plus the plain values to serve when there's no problem: each
 * declared name that's set, by name. Each value served is audited
 * (`env-resolved`, as the deployment's system read), and none is returned
 * while there's a problem.
 */
export async function packEnvValues(
  deps: PackEnvDeps,
  input: PackEnvValuesInput,
): Promise<{ readonly check: PackEnvCheck; readonly values?: Readonly<Record<string, string>> }> {
  const read = await readPackEnv(deps, input);
  if (read.check.problem !== undefined) return { check: read.check };
  const values: Record<string, string> = {};
  for (const [name, record] of read.plain) {
    values[name] = record.value;
    if (input.auditEvents !== undefined) {
      await emitResolveEvent({
        kind: 'env',
        scope: record.scope,
        envName: input.envName,
        name,
        outcome: 'succeeded',
        resolveContext: { caller: 'deploy-sync', deploymentId: input.deploymentId },
        auditEvents: input.auditEvents,
        tenantId: input.tenantId,
        ...(record.scope.kind === 'project' && { projectId: record.scope.projectId }),
        ...(input.log !== undefined && { log: input.log }),
      });
    }
  }
  return { check: read.check, values };
}

/** The scopes a deployment's names are looked for at, narrowest first. */
async function chainFor(deps: PackEnvDeps, input: PackEnvCheckInput): Promise<readonly Scope[]> {
  const tenant: Scope = { kind: 'tenant', tenantId: input.tenantId };
  const projectId =
    input.projectId ?? (await deps.projects?.getDefault(input.tenantId))?.id ?? undefined;
  if (projectId === undefined) return [tenant];
  const project = await deps.projects?.get(input.tenantId, projectId);
  const orgId: OrgId | undefined = project?.orgId;
  return secretScopeChain({ kind: 'project', tenantId: input.tenantId, projectId }, orgId);
}

async function readPackEnv(
  deps: PackEnvDeps,
  input: PackEnvCheckInput,
): Promise<{ readonly check: PackEnvCheck; readonly plain: ReadonlyMap<string, EnvRecord> }> {
  const chain = await chainFor(deps, input);
  const names: PackEnvNameStatus[] = [];
  const plain = new Map<string, EnvRecord>();
  const marks: string[] = [];
  const declared = [
    ...input.declaration.required.map((name) => ({ name, required: true })),
    ...input.declaration.optional.map((name) => ({ name, required: false })),
  ];
  for (const { name, required } of declared) {
    const env = await firstEnv(deps, chain, input.envName, name);
    const secret = await firstSecret(deps, chain, input.envName, name);
    marks.push(markOf(name, env, secret));
    if (env !== undefined && secret !== undefined) {
      names.push({
        name,
        required,
        kind: 'env',
        scope: scopeRef(env.scope),
        missing: false,
        problem: 'ambiguous',
        secretScope: scopeRef(secret.scope),
      });
    } else if (secret !== undefined) {
      names.push({
        name,
        required,
        kind: 'secret',
        scope: scopeRef(secret.scope),
        missing: false,
        problem: 'secret-not-yet',
      });
    } else if (env !== undefined) {
      plain.set(name, env);
      names.push({ name, required, kind: 'env', scope: scopeRef(env.scope), missing: false });
    } else {
      names.push({
        name,
        required,
        kind: null,
        scope: null,
        missing: true,
        ...(required && { problem: 'missing' as const }),
      });
    }
  }
  const problem = PACK_ENV_PROBLEM_CODES.find((code) =>
    names.some((n) => n.problem !== undefined && `pack-env-${n.problem}` === code),
  );
  const revision = `pe1-${createHash('sha256')
    .update(`${chain.map(scopeKey).join(',')}\n${marks.join('\n')}`)
    .digest('hex')}`;
  return {
    check: { revision, names, ...(problem !== undefined && { problem }) },
    plain,
  };
}

/**
 * A declared name's part of the revision: where it's set, as which row, at
 * which revision and when, never its value. A row's revision starts again at
 * 1 when a removed value is set again, and two update times can be the same
 * millisecond: the store's row id tells the new row from the old one. A store
 * with no row id has only the update time to tell them apart.
 */
function markOf(
  name: string,
  env: EnvRecord | undefined,
  secret: SecretRecord | undefined,
): string {
  return JSON.stringify([
    name,
    env === undefined
      ? null
      : [scopeKey(env.scope), env.recordId ?? null, env.revision, env.updatedAt],
    secret === undefined
      ? null
      : [scopeKey(secret.scope), secret.recordId ?? null, secret.currentVersion, secret.updatedAt],
  ]);
}

async function firstEnv(
  deps: PackEnvDeps,
  chain: readonly Scope[],
  envName: EnvName,
  name: string,
): Promise<EnvRecord | undefined> {
  for (const scope of chain) {
    const found = await deps.env.get({ scope, envName, name });
    if (found !== null) return found;
  }
  return undefined;
}

async function firstSecret(
  deps: PackEnvDeps,
  chain: readonly Scope[],
  envName: EnvName,
  name: string,
): Promise<SecretRecord | undefined> {
  if (deps.secrets === undefined) return undefined;
  for (const scope of chain) {
    const found = await deps.secrets.get({ scope, envName, name });
    if (found !== null && found.revokedAt === undefined) return found;
  }
  return undefined;
}

function scopeRef(scope: Scope): PackEnvScopeRef {
  if (scope.kind === 'project') return { kind: 'project', id: scope.projectId };
  if (scope.kind === 'org') return { kind: 'org', id: scope.orgId };
  return { kind: 'tenant' };
}

function scopeKey(scope: Scope): string {
  const ref = scopeRef(scope);
  return ref.id === undefined ? ref.kind : `${ref.kind}:${ref.id}`;
}
