// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId } from '@kindgi/types';

import type { CapabilityError, DuplicateProviderError, InvalidProviderError } from './errors.js';
import { validateProviderLabels } from './provider-labels.js';
import type { ModelProvider, ModelThinking, ProviderRegistry } from './types.js';

/**
 * Create an in-memory registry of model providers. Tenant-scoped:
 * each tenant owns its own `providerId → ModelProvider` map. The
 * router receives a tenant's slice, so cross-tenant leakage is
 * impossible at the routing layer.
 *
 * Registration is validated for shape: provider `id` + `region`
 * non-empty; `models[]` non-empty with unique `name` per entry;
 * per-model `contextWindow` positive integer; per-model `cost`
 * non-negative; optional per-model `p95LatencyMs` / `maxOutputTokens`
 * well-shaped; `labels` within their limits (`provider-labels.ts`);
 * `invoke` is a function. Duplicate ids within a tenant
 * are refused — accidental clobber of a running provider would be
 * catastrophic under a live workload. The same `providerId` may be
 * registered under different tenants (that's the whole point).
 */
export function createProviderRegistry(
  seed: readonly { readonly tenantId: TenantId; readonly provider: ModelProvider }[] = [],
): {
  readonly registry: ProviderRegistry;
  register(tenantId: TenantId, provider: ModelProvider): Result<void, CapabilityError>;
} {
  const byTenant = new Map<TenantId, Map<string, ModelProvider>>();

  function tenantMap(tenantId: TenantId): Map<string, ModelProvider> {
    let m = byTenant.get(tenantId);
    if (m === undefined) {
      m = new Map<string, ModelProvider>();
      byTenant.set(tenantId, m);
    }
    return m;
  }

  function validate(p: ModelProvider): InvalidProviderError | undefined {
    if (typeof p.metadata.id !== 'string' || p.metadata.id.length === 0) {
      return {
        code: 'invalid-provider',
        message: 'provider.metadata.id required',
        reason: 'empty-id',
      };
    }
    if (typeof p.metadata.region !== 'string' || p.metadata.region.length === 0) {
      return {
        code: 'invalid-provider',
        message: `provider "${p.metadata.id}" missing metadata.region`,
        reason: 'empty-region',
      };
    }
    if (!Array.isArray(p.metadata.models) || p.metadata.models.length === 0) {
      return {
        code: 'invalid-provider',
        message: `provider "${p.metadata.id}" must expose at least one model in metadata.models[]`,
        reason: 'empty-models',
      };
    }
    const seenNames = new Set<string>();
    for (const m of p.metadata.models) {
      if (typeof m.name !== 'string' || m.name.length === 0) {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" has a model with empty name`,
          reason: 'empty-model-name',
        };
      }
      if (seenNames.has(m.name)) {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" declares model "${m.name}" more than once in metadata.models[]`,
          reason: 'duplicate-model-name',
        };
      }
      seenNames.add(m.name);
      if (
        typeof m.contextWindow !== 'number' ||
        m.contextWindow <= 0 ||
        !Number.isInteger(m.contextWindow)
      ) {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" model "${m.name}" contextWindow must be a positive integer`,
          reason: 'invalid-context-window',
        };
      }
      if (
        typeof m.cost?.promptUsdPer1kTokens !== 'number' ||
        m.cost.promptUsdPer1kTokens < 0 ||
        typeof m.cost.completionUsdPer1kTokens !== 'number' ||
        m.cost.completionUsdPer1kTokens < 0
      ) {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" model "${m.name}" cost table must have non-negative promptUsdPer1kTokens + completionUsdPer1kTokens`,
          reason: 'invalid-cost',
        };
      }
      if (
        m.p95LatencyMs !== undefined &&
        (typeof m.p95LatencyMs !== 'number' || m.p95LatencyMs < 0)
      ) {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" model "${m.name}" p95LatencyMs must be a non-negative number`,
          reason: 'invalid-p95-latency',
        };
      }
      if (
        m.maxOutputTokens !== undefined &&
        (typeof m.maxOutputTokens !== 'number' ||
          m.maxOutputTokens <= 0 ||
          !Number.isInteger(m.maxOutputTokens))
      ) {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" model "${m.name}" maxOutputTokens must be a positive integer`,
          reason: 'invalid-max-output-tokens',
        };
      }
      if (m.sampling !== undefined && typeof m.sampling !== 'boolean') {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" model "${m.name}" sampling must be true or false`,
          reason: 'invalid-sampling',
        };
      }
      if (m.thinking !== undefined && !isModelThinking(m.thinking)) {
        return {
          code: 'invalid-provider',
          message: `provider "${p.metadata.id}" model "${m.name}" thinking must be { mode: 'adaptive' | 'always', lowest: <the vendor's setting> }`,
          reason: 'invalid-thinking',
        };
      }
    }
    const defaultModel = p.metadata.defaultModel;
    if (defaultModel !== undefined && !p.metadata.models.some((m) => m.name === defaultModel)) {
      return {
        code: 'invalid-provider',
        message: `provider "${p.metadata.id}" defaultModel "${String(defaultModel)}" isn't one of its models (${p.metadata.models.map((m) => m.name).join(', ')})`,
        reason: 'unknown-default-model',
      };
    }
    const badLabels = validateProviderLabels(p.metadata.id, p.metadata.labels);
    if (badLabels !== undefined) return { code: 'invalid-provider', ...badLabels };
    if (typeof p.invoke !== 'function') {
      return {
        code: 'invalid-provider',
        message: `provider "${p.metadata.id}" invoke must be a function`,
        reason: 'invalid-invoke',
      };
    }
    return undefined;
  }

  function register(tenantId: TenantId, provider: ModelProvider): Result<void, CapabilityError> {
    const invalid = validate(provider);
    if (invalid !== undefined) return { kind: 'err', error: invalid };
    const m = tenantMap(tenantId);
    if (m.has(provider.metadata.id)) {
      const dup: DuplicateProviderError = {
        code: 'duplicate-provider',
        message: `Provider "${provider.metadata.id}" is already registered for tenant "${tenantId}"`,
        providerId: provider.metadata.id,
      };
      return { kind: 'err', error: dup };
    }
    m.set(provider.metadata.id, provider);
    return { kind: 'ok', value: undefined };
  }

  const registry: ProviderRegistry = {
    register(tenantId, provider): void {
      const r = register(tenantId, provider);
      if (r.kind === 'err') throw new Error(r.error.message);
    },
    get(tenantId, id): ModelProvider | undefined {
      return byTenant.get(tenantId)?.get(id);
    },
    list(tenantId): readonly ModelProvider[] {
      const m = byTenant.get(tenantId);
      if (m === undefined) return [];
      return [...m.values()];
    },
    has(tenantId, id): boolean {
      return byTenant.get(tenantId)?.has(id) ?? false;
    },
  };

  for (const entry of seed) {
    const r = register(entry.tenantId, entry.provider);
    if (r.kind === 'err')
      throw new Error(
        `seed provider "${entry.provider.metadata.id}" rejected for tenant "${entry.tenantId}": ${r.error.message}`,
      );
  }

  return { registry, register };
}

/** `ModelInfo.thinking`'s shape: a known mode and a non-empty vendor setting. */
export function isModelThinking(value: unknown): value is ModelThinking {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    (t.mode === 'adaptive' || t.mode === 'always') &&
    typeof t.lowest === 'string' &&
    t.lowest.length > 0 &&
    Object.keys(t).every((k) => k === 'mode' || k === 'lowest')
  );
}
