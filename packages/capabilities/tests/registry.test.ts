// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createProviderRegistry } from '../src/index.js';
import type { ModelInfo, ProviderMetadata } from '../src/index.js';
import { fakeProvider } from './helpers.js';

const TENANT_A = '00000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_B = '00000000-0000-0000-0000-000000000002' as TenantId;

/**
 * Build a `ProviderMetadata` with exactly ONE model. Tests exercising
 * multi-model validation build metadata directly.
 */
function meta(
  id: string,
  over: { readonly provider?: Partial<ProviderMetadata>; readonly model?: Partial<ModelInfo> } = {},
): ProviderMetadata {
  const model: ModelInfo = {
    name: `${id}/model-v1`,
    contextWindow: 128000,
    features: ['tool-use', 'streaming'],
    cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
    ...over.model,
  };
  return {
    id,
    region: 'us-east-1',
    models: [model],
    ...over.provider,
  };
}

describe('createProviderRegistry', () => {
  test('register + get + list + has round-trip within a tenant', () => {
    const { registry, register } = createProviderRegistry();
    const p = fakeProvider(meta('anthropic-a'));
    const r = register(TENANT_A, p);
    expect(r.kind).toBe('ok');
    expect(registry.get(TENANT_A, 'anthropic-a')).toBe(p);
    expect(registry.has(TENANT_A, 'anthropic-a')).toBe(true);
    expect(registry.list(TENANT_A)).toEqual([p]);
  });

  test('same providerId can be registered under different tenants', () => {
    // Enables the "shared platform" model — Anthropic registered per
    // tenant, each with its own key resolver, same providerId.
    const { registry, register } = createProviderRegistry();
    const pA = fakeProvider(meta('anthropic'));
    const pB = fakeProvider(meta('anthropic'));
    expect(register(TENANT_A, pA).kind).toBe('ok');
    expect(register(TENANT_B, pB).kind).toBe('ok');
    expect(registry.get(TENANT_A, 'anthropic')).toBe(pA);
    expect(registry.get(TENANT_B, 'anthropic')).toBe(pB);
  });

  test('cross-tenant reads return nothing', () => {
    const { registry, register } = createProviderRegistry();
    register(TENANT_A, fakeProvider(meta('secret-a')));
    expect(registry.get(TENANT_B, 'secret-a')).toBeUndefined();
    expect(registry.has(TENANT_B, 'secret-a')).toBe(false);
    expect(registry.list(TENANT_B)).toEqual([]);
  });

  test('duplicate registration within a tenant is rejected', () => {
    const { register } = createProviderRegistry();
    const p = fakeProvider(meta('dup'));
    expect(register(TENANT_A, p).kind).toBe('ok');
    const second = register(TENANT_A, p);
    expect(second.kind).toBe('err');
    if (second.kind === 'err') expect(second.error.code).toBe('duplicate-provider');
  });

  test('rejects invalid metadata', () => {
    const { register } = createProviderRegistry();
    const badId = register(TENANT_A, fakeProvider(meta('')));
    expect(badId.kind).toBe('err');
    if (badId.kind === 'err') expect(badId.error.code).toBe('invalid-provider');

    const badContext = register(TENANT_A, fakeProvider(meta('x', { model: { contextWindow: 0 } })));
    expect(badContext.kind).toBe('err');

    const badCost = register(
      TENANT_A,
      fakeProvider(
        meta('y', {
          model: { cost: { promptUsdPer1kTokens: -1, completionUsdPer1kTokens: 0 } },
        }),
      ),
    );
    expect(badCost.kind).toBe('err');

    // Empty models[] is unusable — must be rejected explicitly.
    const emptyModels = register(
      TENANT_A,
      fakeProvider({ id: 'z', region: 'us-east-1', models: [] }),
    );
    expect(emptyModels.kind).toBe('err');
    if (emptyModels.kind === 'err') {
      expect(emptyModels.error.code).toBe('invalid-provider');
      if (emptyModels.error.code === 'invalid-provider') {
        expect(emptyModels.error.reason).toBe('empty-models');
      }
    }

    // Duplicate model name within one provider is rejected.
    const dupModelName: ProviderMetadata = {
      id: 'd',
      region: 'us-east-1',
      models: [
        {
          name: 'sonnet',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
        },
        {
          name: 'sonnet',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
        },
      ],
    };
    const dupResult = register(TENANT_A, fakeProvider(dupModelName));
    expect(dupResult.kind).toBe('err');
    if (dupResult.kind === 'err' && dupResult.error.code === 'invalid-provider') {
      expect(dupResult.error.reason).toBe('duplicate-model-name');
    }
  });

  test('seed pre-populates providers per tenant', () => {
    const { registry } = createProviderRegistry([
      { tenantId: TENANT_A, provider: fakeProvider(meta('a')) },
      { tenantId: TENANT_A, provider: fakeProvider(meta('b')) },
      { tenantId: TENANT_B, provider: fakeProvider(meta('c')) },
    ]);
    expect(registry.list(TENANT_A)).toHaveLength(2);
    expect(registry.list(TENANT_B)).toHaveLength(1);
    expect(registry.list(TENANT_B).map((p) => p.metadata.id)).toEqual(['c']);
  });
});
