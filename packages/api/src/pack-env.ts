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
 * A name that's set only as a secret is given only to the orchestrator, and
 * only when it asks for secret values (`packEnvValues` with `secrets`,
 * naming the request and the system key asking): each value with the
 * revision it's given under, read at the version that revision names, and
 * each one's audit row written before any is returned. To an orchestrator that doesn't ask, such a name is
 * `secret-not-yet`; to the owner's check, it's set as a secret. A name
 * that's set two ways (as two of a plain value, a secret and a cloud
 * secret) is `ambiguous`, naming each scope, and is never given.
 *
 * A name can also be set to a cloud secret (`EnvCloudSecretBinding`): a
 * version of a secret the pack service's cloud holds, which the cloud reads,
 * never the runtime. It's set, with no problem, to the orchestrator and the
 * owner alike, and the orchestrator is given its name (`cloudSecrets`),
 * never a value. Set as two of a plain value, a secret and a cloud secret,
 * a name is `ambiguous`.
 *
 * A check reads with `get` only, never `resolve`: it tells where each name
 * is set. Only `packEnvValues`, the orchestrator's read, returns values, and
 * it audits each one it returns.
 */

import { createHash } from 'node:crypto';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { emitResolveEvent, resolveEvent } from '@kindgi/compliance';
import type { Logger } from '@kindgi/log';
import type { ProjectBinding, Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId } from '@kindgi/types';

import type {
  EnvBinding,
  EnvCloudSecretBinding,
  EnvCloudSecretRecord,
  EnvRecord,
} from './env-binding.js';
import { secretScopeChain } from './secret-scope.js';
import type { SecretBinding, SecretError, SecretRecord } from './secrets-binding.js';

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
 * - `pack-env-ambiguous`: a name is set as two of a plain value, a secret and
 *   a cloud secret;
 * - `pack-env-secret-not-yet`: a name is set only as a secret, and the
 *   orchestrator didn't ask for secret values;
 * - `pack-env-missing`: a required name is set nowhere;
 * - `pack-env-secret-unreadable`: a name's secret is set, but it can't be
 *   read, for a reason the platform fixes, not the owner. It's tried again.
 *   Only the orchestrator's read with secret values finds it, and only when
 *   there's no other problem.
 */
export const PACK_ENV_PROBLEM_CODES = [
  'pack-env-ambiguous',
  'pack-env-secret-not-yet',
  'pack-env-missing',
  'pack-env-secret-unreadable',
] as const;

export type PackEnvProblemCode = (typeof PACK_ENV_PROBLEM_CODES)[number];

/**
 * Why the orchestrator couldn't give a pack service its secrets, which it
 * records itself, at a create (the endpoint's problem) or for a ready
 * service (held):
 * - `pack-env-secrets-unaudited`: the runtime has nowhere to audit a secret
 *   it gives out, so it gives none (`501`). The platform fixes it, and it's
 *   tried again;
 * - `pack-env-secret-too-large`: a secret's value is over 32768 bytes, the
 *   most a pack service can be given;
 * - `pack-env-name-too-long`: a name set as a secret is too long for the
 *   secret the orchestrator keeps it in, which is named after the pack
 *   service. Shorten the name in the pack.
 * - `pack-env-cloud-secret-unsupported`: a name is set to a cloud secret, and
 *   the host the pack service runs on can't give it one. It waits for the
 *   name to be set another way.
 */
export const PACK_ENV_SECRET_GIVE_CODES = [
  'pack-env-secrets-unaudited',
  'pack-env-secret-too-large',
  'pack-env-name-too-long',
  'pack-env-cloud-secret-unsupported',
] as const;

/**
 * Why a ready pack service runs on the values it was last given, as its
 * endpoint shows it (`packEnvProblem`):
 * - one of `PACK_ENV_PROBLEM_CODES`, so the newest can't be given to it;
 * - `pack-env-update-failed`: they were given, and its revision with them
 *   didn't start, so the last ready one serves. That one is tried again for
 *   `PACK_ENV_RETRY_MS` after it's first recorded; setting the values again
 *   is a new revision, which is tried too;
 * - one of `PACK_ENV_SECRET_GIVE_CODES`;
 * - `pack-env-secret-redeploy`: a name is now set only as a secret, and this
 *   pack service was made where no secret can be given to it. It runs on the
 *   values it was last given. A new deployment's pack service, from a new
 *   build of the pack, can be given secrets.
 */
export const PACK_ENV_HELD_CODES = [
  ...PACK_ENV_PROBLEM_CODES,
  'pack-env-update-failed',
  ...PACK_ENV_SECRET_GIVE_CODES,
  'pack-env-secret-redeploy',
] as const;

export type PackEnvHeldCode = (typeof PACK_ENV_HELD_CODES)[number];

/**
 * The holds whose cause the platform fixes, not a change of the owner's:
 * `GET /v1/system/pack-env` lists a pack service held as one of these at its
 * current revision every time, with the hold, and the orchestrator's
 * back-off decides when it reads again. Every other hold waits for the
 * revision to move.
 */
export const PACK_ENV_PLATFORM_HOLDS = [
  'pack-env-secret-unreadable',
  'pack-env-secrets-unaudited',
] as const satisfies readonly PackEnvHeldCode[];

export type PackEnvPlatformHold = (typeof PACK_ENV_PLATFORM_HOLDS)[number];

export function isPackEnvPlatformHold(code: PackEnvHeldCode): code is PackEnvPlatformHold {
  return (PACK_ENV_PLATFORM_HOLDS as readonly PackEnvHeldCode[]).includes(code);
}

/** How long a revision held as `pack-env-update-failed` is listed to be tried again: an hour. */
export const PACK_ENV_RETRY_MS = 60 * 60_000;

/** One declared name: where it's set, and why it can't be served, if it can't. */
export interface PackEnvNameStatus {
  readonly name: string;
  readonly required: boolean;
  /**
   * What it's set as: a plain value, a secret, or a cloud secret. `null`
   * when it's set nowhere. When `ambiguous`, the first of those it's set as.
   */
  readonly kind: 'env' | 'secret' | 'cloud-secret' | null;
  /** Where it's set, as `kind`. `null` when it's set nowhere. */
  readonly scope: PackEnvScopeRef | null;
  /** Set nowhere, as a plain value, a secret or a cloud secret (optional names too). */
  readonly missing: boolean;
  /** Why it can't be served. Absent when it can, and for an optional name set nowhere. */
  readonly problem?: 'ambiguous' | 'secret-not-yet' | 'missing' | 'unreadable';
  /** `ambiguous` only, when `kind` isn't `secret` and it's set as a secret too: the secret's scope. */
  readonly secretScope?: PackEnvScopeRef;
  /** `ambiguous` only, when it's set as a cloud secret too: the cloud secret's scope. */
  readonly cloudSecretScope?: PackEnvScopeRef;
}

export interface PackEnvCheck {
  /**
   * Changes whenever what would be served changes: a value written or
   * removed, a secret set or revoked, a cloud secret set, changed or
   * removed. It's made from scopes, row ids, revisions and update times,
   * never from a value.
   */
  readonly revision: string;
  /** Every declared name, required ones first, each list in name order. */
  readonly names: readonly PackEnvNameStatus[];
  /** The first reason in `PACK_ENV_PROBLEM_CODES` order, when there's one. */
  readonly problem?: PackEnvProblemCode;
}

export interface PackEnvDeps {
  readonly env: Pick<EnvBinding, 'get'>;
  /**
   * Absent: no secret store, so nothing is ever set as a secret. A check
   * reads it with `get` only; `resolve` is only for the orchestrator's read
   * with secret values.
   */
  readonly secrets?: Pick<SecretBinding, 'get' | 'resolve'>;
  /** Absent: nothing is ever set to a cloud secret. */
  readonly cloudSecrets?: Pick<EnvCloudSecretBinding, 'get'>;
  readonly projects?: Pick<ProjectBinding, 'get' | 'getDefault'>;
}

export interface PackEnvCheckInput {
  readonly tenantId: TenantId;
  /** The deployment's project. Absent: a tenant-wide deployment, read at the Default project. */
  readonly projectId?: ProjectId;
  /** The env the server serves (`KINDGI_ENV`). */
  readonly envName: EnvName;
  readonly declaration: PackEnvDeclaration;
  /**
   * How a name set only as a secret is told: `'not-yet'` (the default), as
   * `secret-not-yet`, for an orchestrator that doesn't ask for secret
   * values; `'set'`, as set as a secret with no problem, for the owner's
   * check, since the orchestrator records when it can't give one.
   */
  readonly secretOnly?: 'not-yet' | 'set';
}

/** Where each declared name is set, at the deployment's scopes, without reading a value. */
export async function packEnvCheck(
  deps: PackEnvDeps,
  input: PackEnvCheckInput,
): Promise<PackEnvCheck> {
  return (await readPackEnv(deps, input)).check;
}

export interface PackEnvValuesInput extends Omit<PackEnvCheckInput, 'secretOnly'> {
  readonly deploymentId: string;
  readonly auditEvents?: AuditEventBinding;
  readonly log?: Logger;
  /**
   * The orchestrator asks for secret values too. A name set only as a
   * secret is given in `secrets`, read at the version its revision names,
   * and every one's audit row is written before any is returned. It takes
   * `auditEvents`: without them, no secret is read.
   */
  readonly secrets?: PackEnvSecretsAsk;
}

/** Who asks for a pack service's secret values: each one's row names them. */
export interface PackEnvSecretsAsk {
  /** The request asking (the API's `requestId`): each row's correlation id. */
  readonly requestId: string;
  /** The system key asking, by its id (never its token). */
  readonly systemKeyId: string;
}

/** A secret given to a pack service: its value, and the revision it's given under. */
export interface PackEnvSecretValue {
  readonly value: string;
  /**
   * `ps1-…`: the same value under the same name, and it changes whenever
   * what's given for the name does. Made from the name's part of the
   * deployment's revision, never from the value.
   */
  readonly revision: string;
}

/** What the orchestrator's read gives. */
export type PackEnvValues =
  | {
      readonly kind: 'ok';
      readonly check: PackEnvCheck;
      /** The plain values, by name. Absent while there's a problem. */
      readonly values?: Readonly<Record<string, string>>;
      /** With `secrets` asked, the secrets, by name. Absent while there's a problem. */
      readonly secrets?: Readonly<Record<string, PackEnvSecretValue>>;
      /**
       * The names set to a cloud secret, each with its version's resource
       * name, for the host to give the pack service: names, never values,
       * so given whether or not `secrets` is asked. Absent while there's a
       * problem, and when there's none.
       */
      readonly cloudSecrets?: Readonly<Record<string, string>>;
    }
  /**
   * Nothing given, for now, and the orchestrator tries again: the secret
   * store is out (`store`), a secret changed while it was read, twice
   * (`changed`), or the secrets' audit rows weren't written (`audit`).
   */
  | { readonly kind: 'unavailable'; readonly cause: 'store' | 'changed' | 'audit' }
  /** With `secrets` asked and no `auditEvents`: no secret is read or given. */
  | { readonly kind: 'unaudited' };

/**
 * The check, plus the values to give when there's no problem: each declared
 * name that's set as a plain value, and with `secrets` asked, each
 * that's set only as a secret. Each plain value given is audited
 * (`env-resolved`, as the deployment's system read). The secrets' rows
 * (`secret-resolved`, caller `pack-env`) are written in one append before
 * anything is returned, and none is given when they can't be. Nothing is
 * given while there's a problem.
 */
export async function packEnvValues(
  deps: PackEnvDeps,
  input: PackEnvValuesInput,
): Promise<PackEnvValues> {
  const ask = input.secrets;
  if (ask === undefined) {
    const read = await readPackEnv(deps, input);
    if (read.check.problem !== undefined) return { kind: 'ok', check: read.check };
    return {
      kind: 'ok',
      check: read.check,
      values: await plainValues(read.plain, input),
      ...cloudSecretsOf(read.cloudSecrets),
    };
  }
  const auditEvents = input.auditEvents;
  if (auditEvents === undefined) return { kind: 'unaudited' };
  // A secret that changed between where it was found and its read is read
  // again, once, from the start.
  const first = await valuesWithSecrets(deps, input, auditEvents, ask);
  if (first.kind !== 'changed') return first;
  const again = await valuesWithSecrets(deps, input, auditEvents, ask);
  return again.kind === 'changed' ? { kind: 'unavailable', cause: 'changed' } : again;
}

async function valuesWithSecrets(
  deps: PackEnvDeps,
  input: PackEnvValuesInput,
  auditEvents: AuditEventBinding,
  ask: PackEnvSecretsAsk,
): Promise<PackEnvValues | { readonly kind: 'changed' }> {
  const read = await readPackEnv(deps, { ...input, secretOnly: 'set' });
  if (read.check.problem !== undefined) return { kind: 'ok', check: read.check };
  const given = await readSecrets(deps, read, input, ask);
  if (given.kind === 'store') return { kind: 'unavailable', cause: 'store' };
  if (given.kind === 'changed') return given;
  if (given.kind === 'unreadable') {
    return { kind: 'ok', check: withUnreadable(read.check, given.names) };
  }
  if (!(await appendRows(auditEvents, given.rows, input.log))) {
    return { kind: 'unavailable', cause: 'audit' };
  }
  return {
    kind: 'ok',
    check: read.check,
    values: await plainValues(read.plain, input),
    secrets: given.secrets,
    ...cloudSecretsOf(read.cloudSecrets),
  };
}

/** The names set to a cloud secret, each with its version's resource name: none, when there are none. */
function cloudSecretsOf(found: ReadonlyMap<string, EnvCloudSecretRecord>): {
  readonly cloudSecrets?: Readonly<Record<string, string>>;
} {
  if (found.size === 0) return {};
  const cloudSecrets: Record<string, string> = {};
  for (const [name, record] of found) cloudSecrets[name] = record.cloudSecret;
  return { cloudSecrets };
}

/** Each plain value to give, by name, each audited as the deployment's system read. */
async function plainValues(
  plain: ReadonlyMap<string, EnvRecord>,
  input: PackEnvValuesInput,
): Promise<Readonly<Record<string, string>>> {
  const values: Record<string, string> = {};
  for (const [name, record] of plain) {
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
  return values;
}

type SecretsRead =
  | {
      readonly kind: 'ok';
      readonly secrets: Readonly<Record<string, PackEnvSecretValue>>;
      readonly rows: readonly AuditEvent[];
    }
  | { readonly kind: 'unreadable'; readonly names: ReadonlySet<string> }
  | { readonly kind: 'changed' }
  | { readonly kind: 'store' };

/** Why a secret's value wasn't read: it changed since it was found, the store is out, or the platform has to fix it. */
type ReadFault =
  | { readonly kind: 'changed' }
  | { readonly kind: 'store' }
  | { readonly kind: 'unreadable' };

/**
 * Each secret-only name's value, at the version `get` saw, with its row.
 * One the store is out for makes the whole read `store`; one gone or moved
 * since makes it `changed`; otherwise one that can't be read makes it
 * `unreadable`, naming each such name.
 */
async function readSecrets(
  deps: PackEnvDeps,
  found: {
    readonly secrets: ReadonlyMap<string, SecretRecord>;
    readonly projectId?: ProjectId;
  },
  input: PackEnvValuesInput,
  ask: PackEnvSecretsAsk,
): Promise<SecretsRead> {
  const secrets: Record<string, PackEnvSecretValue> = {};
  const rows: AuditEvent[] = [];
  const unreadable = new Set<string>();
  let changed = false;
  for (const [name, record] of found.secrets) {
    const read = await readSecret(deps, name, record, input);
    if (read.kind === 'store') return read;
    if (read.kind === 'changed') changed = true;
    else if (read.kind === 'unreadable') unreadable.add(name);
    else {
      const revision = secretRevision(name, record);
      secrets[name] = { value: read.value, revision };
      rows.push(secretRow(name, record, read.versionId, revision, input, ask, found.projectId));
    }
  }
  if (changed) return { kind: 'changed' };
  if (unreadable.size > 0) return { kind: 'unreadable', names: unreadable };
  return { kind: 'ok', secrets, rows };
}

async function readSecret(
  deps: PackEnvDeps,
  name: string,
  record: SecretRecord,
  input: PackEnvValuesInput,
): Promise<
  { readonly kind: 'ok'; readonly value: string; readonly versionId: number } | ReadFault
> {
  const secrets = deps.secrets;
  // Never: a name is found as a secret only through the store.
  if (secrets === undefined) return { kind: 'unreadable' };
  const resolved = await secrets.resolve({
    scope: record.scope,
    envName: input.envName,
    name,
    version: record.currentVersion,
    exact: true,
    resolveContext: { caller: 'pack-env', deploymentId: input.deploymentId },
  });
  if (resolved.kind === 'err') {
    const fault = faultOf(resolved.error.code);
    if (fault.kind === 'unreadable') {
      input.log?.warn(
        "A pack service's secret can't be read: it isn't given, and the orchestrator holds the deployment",
        {
          event: 'pack-env-secret-unreadable',
          deploymentId: input.deploymentId,
          name,
          code: resolved.error.code,
        },
      );
    }
    return fault;
  }
  if (resolved.value.versionId !== record.currentVersion) return { kind: 'changed' };
  // A store that answers from another scope than the one asked for, or
  // doesn't say which, is the platform's to fix.
  const at = resolved.value.scope;
  if (at === undefined || !sameScope(at, record.scope)) {
    input.log?.warn(
      "A pack service's secret was read from another scope than asked: it isn't given, and the orchestrator holds the deployment",
      { event: 'pack-env-secret-unreadable', deploymentId: input.deploymentId, name },
    );
    return { kind: 'unreadable' };
  }
  return { kind: 'ok', value: resolved.value.value, versionId: resolved.value.versionId };
}

/**
 * What a secret that can't be read means for the read: `changed` when it's
 * gone or moved since `get` saw it, so it's read again; `store` when the
 * store is out for now, so the orchestrator tries again; and otherwise
 * `unreadable`, which the platform fixes. A store's message is never passed
 * on: it can name the store's own resources.
 */
function faultOf(code: SecretError['code']): ReadFault {
  switch (code) {
    case 'secret-revoked':
    case 'secret-not-found':
    case 'secret-version-not-found':
      return { kind: 'changed' };
    case 'secret-store-error':
    case 'secret-provider-unavailable':
    case 'secret-provider-rate-limited':
      return { kind: 'store' };
    default:
      return { kind: 'unreadable' };
  }
}

/**
 * A secret given out's row: where it was read, at which version and
 * revision, for which deployment, and who asked (the request and the
 * system key), never its value. It belongs to the project it was read for
 * (`servedProject`): a deployment that names none is the Default's.
 */
function secretRow(
  name: string,
  record: SecretRecord,
  versionId: number,
  revision: string,
  input: PackEnvValuesInput,
  ask: PackEnvSecretsAsk,
  projectId: ProjectId | undefined,
): AuditEvent {
  return resolveEvent({
    kind: 'secret',
    scope: record.scope,
    envName: input.envName,
    name,
    outcome: 'succeeded',
    resolveContext: { caller: 'pack-env', deploymentId: input.deploymentId },
    version: versionId,
    revision,
    correlationId: ask.requestId,
    systemKeyId: ask.systemKeyId,
    tenantId: input.tenantId,
    ...(projectId !== undefined && { projectId }),
  });
}

/** The rows in one append: `false` when it fails or throws, so nothing is given. */
async function appendRows(
  auditEvents: AuditEventBinding,
  rows: readonly AuditEvent[],
  log: Logger | undefined,
): Promise<boolean> {
  if (rows.length === 0) return true;
  const why = "A pack service's secrets weren't given: their audit rows weren't written";
  try {
    const result = await auditEvents.append(rows);
    if (result.kind === 'ok') return true;
    log?.warn(why, {
      event: 'pack-env-secret-rows-unwritten',
      rows: rows.length,
      code: result.error.code,
    });
  } catch (cause) {
    log?.warn(why, { event: 'pack-env-secret-rows-unwritten', rows: rows.length, err: cause });
  }
  return false;
}

/** The check with each named secret marked `unreadable`, and that as its problem. */
function withUnreadable(check: PackEnvCheck, unreadable: ReadonlySet<string>): PackEnvCheck {
  return {
    ...check,
    names: check.names.map((n) =>
      unreadable.has(n.name) ? { ...n, problem: 'unreadable' as const } : n,
    ),
    problem: 'pack-env-secret-unreadable',
  };
}

/**
 * The project a deployment's names are read for: the one it names, else
 * the tenant's Default. Absent only when the tenant has no Default.
 */
async function servedProject(
  deps: PackEnvDeps,
  input: PackEnvCheckInput,
): Promise<ProjectId | undefined> {
  return input.projectId ?? (await deps.projects?.getDefault(input.tenantId))?.id ?? undefined;
}

/** The scopes a deployment's names are looked for at, narrowest first. */
async function chainFor(
  deps: PackEnvDeps,
  tenantId: TenantId,
  projectId: ProjectId | undefined,
): Promise<readonly Scope[]> {
  const tenant: Scope = { kind: 'tenant', tenantId };
  if (projectId === undefined) return [tenant];
  const project = await deps.projects?.get(tenantId, projectId);
  const orgId: OrgId | undefined = project?.orgId;
  return secretScopeChain({ kind: 'project', tenantId, projectId }, orgId);
}

async function readPackEnv(
  deps: PackEnvDeps,
  input: PackEnvCheckInput,
): Promise<{
  readonly check: PackEnvCheck;
  readonly plain: ReadonlyMap<string, EnvRecord>;
  /** With `secretOnly: 'set'`, each name set only as a secret. */
  readonly secrets: ReadonlyMap<string, SecretRecord>;
  /** Each name set only to a cloud secret. */
  readonly cloudSecrets: ReadonlyMap<string, EnvCloudSecretRecord>;
  /** The project the names were read for (`servedProject`). */
  readonly projectId?: ProjectId;
}> {
  const projectId = await servedProject(deps, input);
  const chain = await chainFor(deps, input.tenantId, projectId);
  const names: PackEnvNameStatus[] = [];
  const plain = new Map<string, EnvRecord>();
  const secrets = new Map<string, SecretRecord>();
  const cloudSecrets = new Map<string, EnvCloudSecretRecord>();
  const marks: string[] = [];
  const declared = [
    ...input.declaration.required.map((name) => ({ name, required: true })),
    ...input.declaration.optional.map((name) => ({ name, required: false })),
  ];
  for (const { name, required } of declared) {
    const env = await firstEnv(deps, chain, input.envName, name);
    const secret = await firstSecret(deps, chain, input.envName, name);
    const cloud = await firstCloudSecret(deps, chain, input.envName, name);
    marks.push(markOf(name, env, secret, cloud));
    const status = statusOf(name, required, { env, secret, cloud }, input.secretOnly ?? 'not-yet');
    names.push(status);
    if (status.problem !== undefined) continue;
    if (status.kind === 'env' && env !== undefined) plain.set(name, env);
    else if (status.kind === 'secret' && secret !== undefined) secrets.set(name, secret);
    else if (status.kind === 'cloud-secret' && cloud !== undefined) cloudSecrets.set(name, cloud);
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
    secrets,
    cloudSecrets,
    ...(projectId !== undefined && { projectId }),
  };
}

/** Where a declared name is found, at the first scope of the chain each is set at. */
interface Found {
  readonly env: EnvRecord | undefined;
  readonly secret: SecretRecord | undefined;
  readonly cloud: EnvCloudSecretRecord | undefined;
}

/** Where a declared name is set, and why it can't be given, if it can't. */
function statusOf(
  name: string,
  required: boolean,
  { env, secret, cloud }: Found,
  secretOnly: 'not-yet' | 'set',
): PackEnvNameStatus {
  const ways = [env, secret, cloud].filter((found) => found !== undefined).length;
  if (ways > 1) {
    // Set two ways or three: `kind` and `scope` are the first, and each
    // other way's scope says where else it's set.
    const first = env !== undefined ? ('env' as const) : ('secret' as const);
    const at = (env ?? secret) as EnvRecord | SecretRecord;
    return {
      name,
      required,
      kind: first,
      scope: scopeRef(at.scope),
      missing: false,
      problem: 'ambiguous',
      ...(first === 'env' && secret !== undefined && { secretScope: scopeRef(secret.scope) }),
      ...(cloud !== undefined && { cloudSecretScope: scopeRef(cloud.scope) }),
    };
  }
  if (secret !== undefined) {
    return {
      name,
      required,
      kind: 'secret',
      scope: scopeRef(secret.scope),
      missing: false,
      ...(secretOnly === 'not-yet' && { problem: 'secret-not-yet' as const }),
    };
  }
  if (cloud !== undefined) {
    return { name, required, kind: 'cloud-secret', scope: scopeRef(cloud.scope), missing: false };
  }
  if (env !== undefined) {
    return { name, required, kind: 'env', scope: scopeRef(env.scope), missing: false };
  }
  return {
    name,
    required,
    kind: null,
    scope: null,
    missing: true,
    ...(required && { problem: 'missing' as const }),
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
  cloud: EnvCloudSecretRecord | undefined,
): string {
  return JSON.stringify([
    name,
    env === undefined
      ? null
      : [scopeKey(env.scope), env.recordId ?? null, env.revision, env.updatedAt],
    secret === undefined ? null : secretMark(secret),
    // Only with one, so a name with none keeps the mark it had before cloud
    // secrets, and a pack service's revision doesn't move for nothing.
    ...(cloud === undefined
      ? []
      : [[scopeKey(cloud.scope), cloud.recordId ?? null, cloud.revision, cloud.updatedAt]]),
  ]);
}

/** A secret's part of a name's mark: where it's set, as which record, at which version and when. */
function secretMark(secret: SecretRecord): readonly unknown[] {
  return [scopeKey(secret.scope), secret.recordId ?? null, secret.currentVersion, secret.updatedAt];
}

/**
 * The revision a secret is given under: made from its part of the name's
 * mark in the deployment's revision, so it moves whenever that does, and
 * never from the value (a hash of a short value would let it be guessed).
 */
function secretRevision(name: string, secret: SecretRecord): string {
  return `ps1-${createHash('sha256')
    .update(JSON.stringify([name, ...secretMark(secret)]))
    .digest('hex')}`;
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.tenantId === b.tenantId && scopeKey(a) === scopeKey(b);
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

async function firstCloudSecret(
  deps: PackEnvDeps,
  chain: readonly Scope[],
  envName: EnvName,
  name: string,
): Promise<EnvCloudSecretRecord | undefined> {
  if (deps.cloudSecrets === undefined) return undefined;
  for (const scope of chain) {
    const found = await deps.cloudSecrets.get({ scope, envName, name });
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
