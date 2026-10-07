// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import {
  PROVIDER_LABELS_MAX_KEYS,
  PROVIDER_LABEL_MANAGED_BY,
  createProviderRegistry,
  validateProviderLabels,
} from '../src/index.js';
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

  test('defaultModel: one of its models is kept; another name is refused', () => {
    const { registry, register } = createProviderRegistry();
    const models = [
      {
        name: 'sonnet',
        contextWindow: 200000,
        features: ['tool-use' as const],
        cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
      },
    ];
    const ok = register(
      TENANT_A,
      fakeProvider({ id: 'a', region: 'us', models, defaultModel: 'sonnet' }),
    );
    expect(ok.kind).toBe('ok');
    expect(registry.get(TENANT_A, 'a')?.metadata.defaultModel).toBe('sonnet');
    const bad = register(
      TENANT_A,
      fakeProvider({ id: 'b', region: 'us', models, defaultModel: 'opus' }),
    );
    expect(bad.kind).toBe('err');
    if (bad.kind === 'err' && bad.error.code === 'invalid-provider') {
      expect(bad.error.reason).toBe('unknown-default-model');
    }
  });

  test('sampling: a boolean is kept; anything else is refused', () => {
    const { registry, register } = createProviderRegistry();
    const model = {
      name: 'sonnet',
      contextWindow: 200000,
      features: ['tool-use' as const],
      cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
    };
    expect(
      register(
        TENANT_A,
        fakeProvider({ id: 'a', region: 'us', models: [{ ...model, sampling: false }] }),
      ).kind,
    ).toBe('ok');
    expect(registry.get(TENANT_A, 'a')?.metadata.models[0]?.sampling).toBe(false);
    const bad = register(
      TENANT_A,
      fakeProvider({ id: 'b', region: 'us', models: [{ ...model, sampling: 'no' as never }] }),
    );
    expect(bad.kind).toBe('err');
    if (bad.kind === 'err' && bad.error.code === 'invalid-provider') {
      expect(bad.error.reason).toBe('invalid-sampling');
    }
  });

  test('labels: kept as given, and out-of-bounds labels are refused', () => {
    const { registry, register } = createProviderRegistry();
    const labels = {
      [PROVIDER_LABEL_MANAGED_BY]: 'kindgi-dev:acme.pack',
      'acme.com/team': 'search',
    };
    expect(register(TENANT_A, fakeProvider(meta('ok', { provider: { labels } }))).kind).toBe('ok');
    expect(registry.get(TENANT_A, 'ok')?.metadata.labels).toEqual(labels);

    const tooMany = Object.fromEntries(
      Array.from({ length: PROVIDER_LABELS_MAX_KEYS + 1 }, (_, i) => [`k${i}`, 'v']),
    );
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ Team: 'search' }, 'key "Team" must be 1-63 lowercase letters and digits'],
      [{ '-team': 'search' }, 'key "-team"'],
      [{ [`k${'x'.repeat(63)}`]: 'v' }, 'must be 1-63'],
      [{ team: 7 }, 'value of "team" must be a string'],
      [{ team: 'x'.repeat(257) }, 'value of "team" may be at most 256 characters (got 257)'],
      [tooMany, 'may have at most 32 keys (got 33)'],
    ];
    for (const [bad, message] of cases) {
      const result = register(
        TENANT_A,
        fakeProvider(meta('bad', { provider: { labels: bad as Record<string, string> } })),
      );
      expect(result.kind).toBe('err');
      if (result.kind === 'err' && result.error.code === 'invalid-provider') {
        expect(result.error.reason).toBe('invalid-labels');
        expect(result.error.message).toContain(message);
      }
    }
    expect(validateProviderLabels('p', ['a'])?.message).toBe(
      'provider "p" labels must be an object of string keys to string values',
    );
    expect(validateProviderLabels('p', undefined)).toBeUndefined();
    expect(registry.has(TENANT_A, 'bad')).toBe(false);
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
