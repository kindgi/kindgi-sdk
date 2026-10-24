// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import type { EnvName, TenantId } from '@kindgi/types';

import { type MCPEndpointRegistryBinding, mcpEndpointSecretRefs } from './mcp-endpoint-binding.js';
import type { ProviderRegistryBinding } from './provider-binding.js';
import { pages } from './provider-keys.js';
import { sameScope, scopeOfRecorded } from './secret-scope.js';
import type { WebhookEndpointBinding } from './webhook-endpoint-binding.js';

/**
 * A runtime that refuses other envs (`createApp({ envName, refuseOtherEnvs:
 * true })`) is the only reader of its stores and keeps every value under
 * the env it serves. A value stored under another env would never be read,
 * so the API refuses to store one (`env-not-served`), and a new registration
 * must name its secret under the served env.
 *
 * Except what a reference still reads: a provider, MCP endpoint or webhook
 * endpoint registered before names its own env, and is read there, at the
 * scopes it's read at. A secret at that (env, name), at one of those
 * scopes, can still be written, so a value in use can be rotated. Reads and
 * deletes are never refused: a value stored before can still be found and
 * removed.
 */
export interface ServedEnvRule {
  readonly envName: EnvName;
  /** Each secret a provider, MCP endpoint or webhook endpoint of the tenant names, with its env and scope. */
  references(tenantId: TenantId): Promise<readonly SecretReference[]>;
}

/**
 * A registration's reference to a secret, read under its own env at
 * `scope`: a provider's at `'every'` scope of the tenant, since a run reads
 * its key at the run's project, else the project's org, else the tenant;
 * a webhook endpoint's at the tenant's; an MCP endpoint's at the scope
 * recorded for the secret (none recorded: the tenant's).
 */
export interface SecretReference {
  readonly scope: Scope | 'every';
  readonly envName: string;
  readonly name: string;
  readonly by: {
    readonly kind: 'provider' | 'mcp-endpoint' | 'webhook-endpoint';
    readonly id: string;
  };
}

/** What the references come from: the tenant's registrations that name a secret by env. */
export interface SecretReferencesDeps {
  readonly providers?: ProviderRegistryBinding;
  readonly mcpEndpoints?: MCPEndpointRegistryBinding;
  readonly webhookEndpoints?: WebhookEndpointBinding;
}

/** A page's worth, as `usersOfSecret` reads them. */
const PAGE = 100;

/**
 * Every reference to a secret the tenant's registrations hold. Past the
 * page cap a reference is missed, and a write it would let through is
 * refused: the safe way round. An MCP endpoint's secret recorded at no
 * scope (`null`) is read nowhere, so it's no reference.
 */
export function secretReferencesOf(
  deps: SecretReferencesDeps,
): (tenantId: TenantId) => Promise<readonly SecretReference[]> {
  return async (tenantId) => {
    const tenant: Scope = { kind: 'tenant', tenantId };
    const out: SecretReference[] = [];
    if (deps.providers !== undefined) {
      for (const entry of await deps.providers.resolveForRuntime({ tenantId })) {
        if (entry.secretRef === undefined) continue;
        out.push({
          scope: 'every',
          envName: entry.secretRef.envName,
          name: entry.secretRef.name,
          by: { kind: 'provider', id: entry.metadata.id },
        });
      }
    }
    if (deps.mcpEndpoints !== undefined) {
      const mcp = deps.mcpEndpoints;
      for await (const e of pages((cursor) =>
        mcp.list({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
      )) {
        for (const ref of mcpEndpointSecretRefs(e)) {
          const recorded = e.secretScopes?.[ref.name];
          if (recorded === null) continue;
          out.push({
            scope: recorded === undefined ? tenant : scopeOfRecorded(tenantId, recorded),
            envName: ref.envName,
            name: ref.name,
            by: { kind: 'mcp-endpoint', id: e.endpointId },
          });
        }
      }
    }
    if (deps.webhookEndpoints !== undefined) {
      const hooks = deps.webhookEndpoints;
      for await (const e of pages((cursor) =>
        hooks.list({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
      )) {
        out.push({
          scope: tenant,
          envName: e.secretRef.envName,
          name: e.secretRef.name,
          by: { kind: 'webhook-endpoint', id: e.endpointId as unknown as string },
        });
      }
    }
    return out;
  };
}

/**
 * The rule with each tenant's references read once, for a request that
 * checks many values (a deployment's secret sync).
 */
export function readReferencesOnce(rule: ServedEnvRule): ServedEnvRule {
  const read = new Map<TenantId, Promise<readonly SecretReference[]>>();
  return {
    envName: rule.envName,
    references: (tenantId) => {
      const known = read.get(tenantId);
      if (known !== undefined) return known;
      const refs = rule.references(tenantId);
      read.set(tenantId, refs);
      return refs;
    },
  };
}

/** The refusal: `envName` isn't the env this runtime serves. A type, so it goes to `toWireError` as is. */
export type EnvNotServed = {
  readonly code: 'env-not-served';
  readonly message: string;
  readonly envName: string;
  readonly servedEnv: EnvName;
};

/**
 * Why a secret or env value can't be stored under `envName`, or nothing.
 * A secret that a reference names under that env, at a scope it's read
 * at, is let through: the reference reads it there. `storeWith` names the
 * route to store it with instead, for a route that takes no env.
 */
export async function refuseUnservedValue(
  rule: ServedEnvRule | undefined,
  input: {
    readonly tenantId: TenantId;
    readonly scope: Scope;
    readonly envName: EnvName;
    readonly name: string;
    readonly kind: 'secret' | 'env value';
    readonly storeWith?: string;
  },
): Promise<EnvNotServed | undefined> {
  if (rule === undefined || input.envName === rule.envName) return undefined;
  if (input.kind === 'secret') {
    const refs = await rule.references(input.tenantId);
    if (
      refs.some(
        (ref) =>
          ref.envName === input.envName &&
          ref.name === input.name &&
          (ref.scope === 'every' || sameScope(ref.scope, input.scope)),
      )
    ) {
      return undefined;
    }
  }
  const how = input.storeWith !== undefined ? `, with ${input.storeWith}` : '';
  return envNotServed(
    rule.envName,
    input.envName,
    `the ${input.kind} \`${input.name}\` under \`${input.envName}\` would never be read. Store it under \`${rule.envName}\`${how}`,
  );
}

/**
 * Why a registration can't name its secret under `ref.envName`, or nothing.
 * `who` says what names it, as a message's subject (`` `secret_ref` ``).
 */
export function refuseUnservedReference(
  rule: ServedEnvRule | undefined,
  ref: { readonly envName: string; readonly name: string },
  who: string,
): EnvNotServed | undefined {
  if (rule === undefined || ref.envName === rule.envName) return undefined;
  return envNotServed(
    rule.envName,
    ref.envName,
    `${who} names \`${ref.name}\` under \`${ref.envName}\`. Name it under \`${rule.envName}\`, and store the secret there`,
  );
}

function envNotServed(servedEnv: EnvName, envName: string, rest: string): EnvNotServed {
  return {
    code: 'env-not-served',
    message: `This runtime keeps its values under \`${servedEnv}\` only, so ${rest}`,
    envName,
    servedEnv,
  };
}
