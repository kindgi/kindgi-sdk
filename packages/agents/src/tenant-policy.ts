// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantPolicy } from '@kindgi/capabilities';

type AllowDeny = { readonly allow?: readonly string[]; readonly deny?: readonly string[] };

/**
 * Combine two tenant policies (the statically bound one and one derived
 * from the policy registry) so the result is at least as strict as each:
 *
 *   - allow lists (`providers.allow`, `models.allow`, `regionAllow`) →
 *     INTERSECTION when both set one; a list set on one side only applies
 *     as-is. An empty result allows nothing (the router fails closed).
 *   - deny lists (`providers.deny`, `models.deny`) → UNION.
 *   - `maxCostPerCallUsd` / `maxTokensPerCall` → the smaller value.
 *
 * Returns `undefined` when both are undefined (routing runs with no
 * tenant policy).
 */
export function mergeTenantPolicies(
  a: TenantPolicy | undefined,
  b: TenantPolicy | undefined,
): TenantPolicy | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const providers = mergeAllowDeny(a.providers, b.providers);
  const models = mergeAllowDeny(a.models, b.models);
  const regionAllow = intersectStrings(a.regionAllow, b.regionAllow);
  const maxCost = minDefined(a.maxCostPerCallUsd, b.maxCostPerCallUsd);
  const maxTokens = minDefined(a.maxTokensPerCall, b.maxTokensPerCall);
  const merged: { -readonly [K in keyof TenantPolicy]: TenantPolicy[K] } = {
    tenantId: a.tenantId,
  };
  if (providers !== undefined) merged.providers = providers;
  if (models !== undefined) merged.models = models;
  if (regionAllow !== undefined) merged.regionAllow = regionAllow;
  if (maxCost !== undefined) merged.maxCostPerCallUsd = maxCost;
  if (maxTokens !== undefined) merged.maxTokensPerCall = maxTokens;
  return merged;
}

function mergeAllowDeny(a: AllowDeny | undefined, b: AllowDeny | undefined): AllowDeny | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const allow = intersectStrings(a.allow, b.allow);
  const deny = unionStrings(a.deny, b.deny);
  if (allow === undefined && deny === undefined) return undefined;
  return {
    ...(allow !== undefined && { allow }),
    ...(deny !== undefined && { deny }),
  };
}

function intersectStrings(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): readonly string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const inB = new Set(b);
  return Array.from(new Set(a)).filter((v) => inB.has(v));
}

function unionStrings(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): readonly string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Array.from(new Set([...a, ...b]));
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}
