// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The values a deployment needs set in a project before it serves there:
 * each tool's secrets and env, each agent's model key, and the pack's own
 * env. A promotion checks them at its target and refuses while one isn't
 * ready (`409 promotion-values-not-ready`), so a promoted build never
 * starts in an environment that can't run it. Each value is read where a
 * run reads it, never its value: whether it's set, and where.
 */

import type { ProjectBinding, Scope } from '@kindgi/platform';
import { toolOptionalSecretNames, toolRequiredEnvNames } from '@kindgi/tools';
import type { AgentId, EnvName, ProjectId, Semver, TenantId, ToolId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { CarriedVersion } from './carried-versions.js';
import type { Deployment } from './deployment-binding.js';
import type { EnvBinding } from './env-binding.js';
import type { ProviderRegistryBinding, ProviderRuntimeEntry } from './provider-binding.js';
import { findNamedSecretScope, secretScopeChain, toolSecretRefs } from './secret-scope.js';
import type { SecretBinding } from './secrets-binding.js';
import type { ToolRecord, ToolRegistryBinding } from './tool-binding.js';

/** Where a value is set, as a run looks for it: the project, else its org, else the tenant. */
export type DeploymentValueScope = 'project' | 'org' | 'tenant';

/**
 * Why a value isn't ready:
 * - `missing`: a required value set nowhere a run looks;
 * - `secret-not-yet`: a pack env name set only as a secret, which isn't
 *   given into a pack service's environment yet;
 * - `ambiguous`: a pack env name set both as a secret and as a plain value;
 * - `revoked`: a tool's secret revoked where it's recorded, or a model key
 *   revoked where a run looks first: a run refuses (`secret-revoked`)
 *   rather than read a wider one;
 * - `no-provider`: an agent that runs on any provider (it names none, or
 *   one that isn't registered), with no provider registered in the tenant:
 *   a run has none to call. Its name is `any provider`.
 */
export type DeploymentValueProblem =
  | 'missing'
  | 'secret-not-yet'
  | 'ambiguous'
  | 'revoked'
  | 'no-provider';

/** One value a deployment needs in a project. Never the value itself. */
export interface DeploymentValue {
  /**
   * The secret's or env variable's name; for a model key, the key's secret
   * name, or `any provider` when none is registered (`no-provider`).
   */
  readonly name: string;
  readonly kind: 'secret' | 'env' | 'model-key' | 'pack-env';
  /** What needs it: a tool version, an agent version, a model provider, or the pack's service. */
  readonly neededBy: {
    readonly type: 'tool' | 'agent' | 'provider' | 'pack';
    readonly id: string;
    readonly version?: string;
  };
  /** Where a run finds it, when it's set. */
  readonly foundAt?: DeploymentValueScope;
  /** Why it isn't ready; absent when it is. */
  readonly problem?: DeploymentValueProblem;
}

/**
 * Where a model provider's key is for a run in a project: the first scope
 * that holds it (the project, else its org, else the tenant), else the
 * tenant's, where it would be set. The run reads exactly this place, and
 * the values check asks the same function, so the two never disagree.
 */
export interface ModelKeyLocation {
  readonly scope: Scope;
  readonly envName: string;
  readonly name: string;
  /**
   * When the key at `scope` was revoked. A run doesn't fall back to a wider
   * scope past a revoked key: it refuses (`secret-revoked`). A hard-revoked
   * key is erased, so it's at no scope: the wider one answers, for the run
   * and for this lookup alike.
   */
  readonly revokedAt?: string;
}

/**
 * Looks a provider's model key up for a run (`ModelKeyLocation`). The
 * runtime supplies it; without one, every key is the tenant's.
 */
export type ModelKeyLookup = (
  registration: ProviderRuntimeEntry,
  where: { readonly tenantId: TenantId; readonly projectId?: ProjectId },
) => Promise<ModelKeyLocation>;

/** What the values check reads, each as a run reads it. */
export interface DeploymentValuesDeps {
  /**
   * The env the runtime serves (`KINDGI_ENV`), where every value is read.
   * Absent: nothing can be looked up, and each needed name is listed with
   * neither `foundAt` nor `problem` (a run refuses for the missing env).
   */
  readonly envName?: EnvName;
  readonly secrets?: Pick<SecretBinding, 'get'>;
  readonly projects?: Pick<ProjectBinding, 'get'>;
  /**
   * Whether the person promoting administers a scope: a tool's secret is
   * recorded only at a scope they do, as on a deploy (`secret-scope.ts`).
   * Absent: every scope.
   */
  readonly administers?: (scope: Scope) => Promise<boolean>;
  readonly tools?: Pick<ToolRegistryBinding, 'get' | 'getVersion'>;
  readonly agents?: Pick<AgentRegistryBinding, 'getVersion'>;
  readonly env?: Pick<EnvBinding, 'get'>;
  /** The tenant's model providers. Absent: no model key is checked. */
  readonly providers?: Pick<ProviderRegistryBinding, 'resolveForRuntime'>;
  readonly modelKeyLookup?: ModelKeyLookup;
  /** The pack service's own env at the project, as `pack-env` values. Absent: not checked. */
  readonly packEnv?: (input: {
    readonly tenantId: TenantId;
    readonly projectId: ProjectId;
    readonly envName: EnvName;
    readonly deployment: Deployment;
  }) => Promise<readonly DeploymentValue[]>;
}

export interface DeploymentValuesInput {
  readonly deployment: Deployment;
  /** The versions that move with it (`carriedVersions`): their model keys are needed too. */
  readonly carried: readonly CarriedVersion[];
  /** Where the values are needed: the project it's promoted to. */
  readonly projectId: ProjectId;
}

/**
 * Every value `deployment` needs in `projectId`, each read where a run
 * there will read it, and why it isn't ready (`problem`, absent when it
 * is):
 *
 * - each tool version's secrets, at the scope a promotion records for it
 *   (the first of the project, its org and the tenant that holds it, among
 *   those the person promoting administers);
 * - each tool version's env values that have no default, at the project,
 *   else its org, else the tenant;
 * - a model key for each agent version shipped or carried: its
 *   `preferredProvider`'s, when that provider is registered (a run falls
 *   back only when it isn't), else any registered provider's. A provider
 *   with no key needs none. When an agent needs any provider and none is
 *   ready, each registered provider's key is listed;
 * - the pack service's own env (`packEnv`).
 *
 * Tools first (in contents order, secrets then env), then model keys by
 * provider, then the pack's env. Never a value.
 */
export async function deploymentValues(
  deps: DeploymentValuesDeps,
  input: DeploymentValuesInput,
): Promise<DeploymentValue[]> {
  const { deployment, projectId } = input;
  const tenantId = deployment.tenantId;
  const orgId = (await deps.projects?.get(tenantId, projectId))?.orgId;
  const chain = secretScopeChain({ kind: 'project', tenantId, projectId }, orgId);
  const out: DeploymentValue[] = [];
  const seenTools = new Set<string>();
  for (const { id, version } of deployment.contents.tools) {
    const key = `${id}@${version ?? ''}`;
    if (seenTools.has(key)) continue;
    seenTools.add(key);
    const tool = await toolAt(deps, tenantId, id, version);
    if (tool === null) continue;
    const neededBy = { type: 'tool' as const, id, version: tool.version as unknown as string };
    out.push(...(await toolSecrets(deps, chain, tool, neededBy)));
    out.push(...(await toolEnv(deps, chain, tool, neededBy)));
  }
  out.push(...(await modelKeys(deps, input)));
  if (deps.packEnv !== undefined && deps.envName !== undefined) {
    out.push(...(await deps.packEnv({ tenantId, projectId, envName: deps.envName, deployment })));
  }
  return out;
}

type NeededBy = DeploymentValue['neededBy'];

async function toolAt(
  deps: DeploymentValuesDeps,
  tenantId: TenantId,
  id: string,
  version: string | undefined,
): Promise<ToolRecord | null> {
  if (deps.tools === undefined) return null;
  const toolId = id as ToolId;
  // A deployment from before versions were recorded runs the tool's latest.
  return version === undefined
    ? deps.tools.get({ tenantId, toolId })
    : deps.tools.getVersion({ tenantId, toolId, version: version as Semver });
}

/**
 * A tool's secrets, each at the scope a promotion records for it: what a
 * run reads, and only there. An optional one (its schema accepts `null`)
 * that's set nowhere isn't listed, as a call runs without it; set, it's
 * listed, and revoked it's a problem, as it still refuses the call. The
 * authorization's `secretRef` is always required.
 */
async function toolSecrets(
  deps: DeploymentValuesDeps,
  chain: readonly Scope[],
  tool: ToolRecord,
  neededBy: NeededBy,
): Promise<DeploymentValue[]> {
  const out: DeploymentValue[] = [];
  const optional = new Set(toolOptionalSecretNames(tool));
  const authorization = tool.spec?.authorization?.secretRef?.name;
  if (authorization !== undefined) optional.delete(authorization);
  for (const ref of toolSecretRefs(tool, deps.envName)) {
    const base = { name: ref.name, kind: 'secret' as const, neededBy };
    if (deps.secrets === undefined || ref.envName === undefined) {
      out.push(base);
      continue;
    }
    const at = await findNamedSecretScope({
      secrets: deps.secrets,
      ...(deps.administers !== undefined && { administers: deps.administers }),
      chain,
      envName: ref.envName,
      name: ref.name,
    });
    if (at?.found === undefined) {
      if (!optional.has(ref.name)) out.push({ ...base, problem: 'missing' });
    } else if (at.found.revokedAt !== undefined) {
      out.push({ ...base, foundAt: at.scope.kind, problem: 'revoked' });
    } else {
      out.push({ ...base, foundAt: at.scope.kind });
    }
  }
  return out;
}

/** A tool's env values with no default: the first of the project, its org and the tenant that sets each. */
async function toolEnv(
  deps: DeploymentValuesDeps,
  chain: readonly Scope[],
  tool: ToolRecord,
  neededBy: NeededBy,
): Promise<DeploymentValue[]> {
  const out: DeploymentValue[] = [];
  for (const name of toolRequiredEnvNames(tool)) {
    const base = { name, kind: 'env' as const, neededBy };
    const { env, envName } = deps;
    if (env === undefined || envName === undefined) {
      out.push(base);
      continue;
    }
    let foundAt: DeploymentValueScope | undefined;
    for (const scope of chain) {
      if ((await env.get({ scope, envName, name })) !== null) {
        foundAt = scope.kind;
        break;
      }
    }
    out.push(foundAt === undefined ? { ...base, problem: 'missing' } : { ...base, foundAt });
  }
  return out;
}

/**
 * The model keys the deployment's agents and the carried ones need, by
 * provider. An agent that runs on any provider needs one registered with
 * its key ("model key, any provider"): with none registered at all, each
 * such agent version is `no-provider`.
 */
async function modelKeys(
  deps: DeploymentValuesDeps,
  input: DeploymentValuesInput,
): Promise<DeploymentValue[]> {
  if (deps.providers === undefined) return [];
  const registered = new Map(
    (await deps.providers.resolveForRuntime({ tenantId: input.deployment.tenantId })).map((e) => [
      e.metadata.id,
      e,
    ]),
  );
  const { needed, anyNeeders } = await providersNeeded(deps, input, registered);
  const keys = new Map<string, Promise<DeploymentValue | 'keyless'>>();
  const keyOf = (entry: ProviderRuntimeEntry) => {
    const known = keys.get(entry.metadata.id) ?? modelKey(deps, input, entry);
    keys.set(entry.metadata.id, known);
    return known;
  };
  const out: DeploymentValue[] = [];
  for (const providerId of [...needed].sort()) {
    const value = await keyOf(registered.get(providerId) as ProviderRuntimeEntry);
    if (value !== 'keyless') out.push(value);
  }
  if (anyNeeders.length === 0) return out;
  if (registered.size === 0) {
    return [
      ...out,
      ...anyNeeders.map(({ id, version }) => ({
        name: 'any provider',
        kind: 'model-key' as const,
        neededBy: { type: 'agent' as const, id, version },
        problem: 'no-provider' as const,
      })),
    ];
  }
  const all = [...registered.keys()].sort().map((id) => registered.get(id) as ProviderRuntimeEntry);
  const answers = await Promise.all(all.map(keyOf));
  // Any provider will do: when one is ready, nothing more is needed.
  if (answers.some((v) => v === 'keyless' || v.problem === undefined)) return out;
  return [
    ...out,
    ...answers.filter((v): v is DeploymentValue => v !== 'keyless' && !needed.has(v.neededBy.id)),
  ];
}

/**
 * The providers whose keys the agent versions need: each one's registered
 * `preferredProvider`, and the agent versions that run on any provider
 * (they name none, or name one that isn't registered).
 */
async function providersNeeded(
  deps: DeploymentValuesDeps,
  input: DeploymentValuesInput,
  registered: ReadonlyMap<string, ProviderRuntimeEntry>,
): Promise<{
  readonly needed: ReadonlySet<string>;
  readonly anyNeeders: readonly { readonly id: string; readonly version: string }[];
}> {
  const needed = new Set<string>();
  const anyNeeders: { id: string; version: string }[] = [];
  for (const { id, version } of agentVersions(input)) {
    const agent = await deps.agents?.getVersion({
      tenantId: input.deployment.tenantId,
      agentId: id as AgentId,
      version: version as Semver,
    });
    const preferred = agent?.preferredProvider;
    if (preferred !== undefined && registered.has(preferred)) needed.add(preferred);
    else anyNeeders.push({ id, version });
  }
  return { needed, anyNeeders };
}

/** Each agent version the deployment ships or carries, once. */
function agentVersions(input: DeploymentValuesInput): { id: string; version: string }[] {
  const seen = new Set<string>();
  const out: { id: string; version: string }[] = [];
  const all = [
    ...input.deployment.contents.agents,
    ...input.carried.filter((c) => c.kind === 'agent'),
  ];
  for (const { id, version } of all) {
    if (version === undefined || seen.has(`${id}@${version}`)) continue;
    seen.add(`${id}@${version}`);
    out.push({ id, version });
  }
  return out;
}

/** One provider's key where a run in the project reads it; `keyless` for a provider that needs none. */
async function modelKey(
  deps: DeploymentValuesDeps,
  input: DeploymentValuesInput,
  entry: ProviderRuntimeEntry,
): Promise<DeploymentValue | 'keyless'> {
  if (entry.secretRef === undefined) return 'keyless';
  const tenantId = input.deployment.tenantId;
  const location: ModelKeyLocation =
    deps.modelKeyLookup !== undefined
      ? await deps.modelKeyLookup(entry, { tenantId, projectId: input.projectId })
      : {
          scope: { kind: 'tenant', tenantId },
          envName: entry.secretRef.envName,
          name: entry.secretRef.name,
        };
  const base = {
    name: location.name,
    kind: 'model-key' as const,
    neededBy: { type: 'provider' as const, id: entry.metadata.id },
  };
  if (deps.secrets === undefined) return base;
  const found = await deps.secrets.get({
    scope: location.scope,
    envName: location.envName as EnvName,
    name: location.name,
  });
  if (found === null) return { ...base, problem: 'missing' };
  const foundAt = location.scope.kind;
  if (location.revokedAt !== undefined || found.revokedAt !== undefined) {
    return { ...base, foundAt, problem: 'revoked' };
  }
  return { ...base, foundAt };
}
