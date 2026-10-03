// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { matchTuples, route } from '../src/index.js';
import type {
  Capability,
  ModelInfo,
  ModelProvider,
  ProviderMetadata,
  TenantPolicy,
} from '../src/index.js';
import { fakeProvider } from './helpers.js';

const TENANT_A = '00000000-0000-0000-0000-000000000001' as TenantId;

/**
 * Build a `ProviderMetadata` with exactly ONE model so tuple assertions
 * that use `provider.metadata.id` keep meaning "the provider" — the
 * single-model shape is the common case for existing coverage. Tests
 * exercising multi-model + model-level filters build metadata directly.
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

function providersOf(...metas: ProviderMetadata[]): readonly ModelProvider[] {
  return metas.map((m) => fakeProvider(m));
}

describe('matchTuples — capability kind filter', () => {
  test('llm-inference (default) picks llm-inference providers', () => {
    const providers = providersOf(
      meta('llm-a', { provider: { capabilityKind: 'llm-inference' } }),
      meta('embed-a', { provider: { capabilityKind: 'embedding' } }),
    );
    // No kind on capability → defaults to llm-inference.
    const cap: Capability = { needs: [] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['llm-a']);
  });

  test('explicit kind: embedding filters LLM providers out', () => {
    const providers = providersOf(
      meta('llm-a', { provider: { capabilityKind: 'llm-inference' } }),
      meta('embed-a', { provider: { capabilityKind: 'embedding' } }),
    );
    const cap: Capability = { kind: 'embedding', needs: [] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['embed-a']);
  });

  test('provider without capabilityKind is treated as llm-inference', () => {
    // Providers that don't set capabilityKind match llm-inference
    // capability requests.
    const providers = providersOf(meta('plain'));
    const cap: Capability = { kind: 'llm-inference', needs: [] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['plain']);
  });

  test('unknown kind → capability-unsatisfiable with kind diagnostic', () => {
    const providers = providersOf(meta('llm-a', { provider: { capabilityKind: 'llm-inference' } }));
    const cap: Capability = { kind: 'gpu-compute', needs: [] };
    const r = route({ capability: cap, providers });
    expect(r.kind).toBe('err');
    if (r.kind === 'err' && r.error.code === 'capability-unsatisfiable') {
      const kindReason = r.error.reasons.find((x) => x.requirement.includes('capability.kind'));
      expect(kindReason).toBeDefined();
    }
  });
});

describe('matchTuples — feature requirement', () => {
  test('picks tuples whose model supports the required feature', () => {
    const providers = providersOf(
      meta('vision-p', { model: { features: ['vision', 'tool-use'] } }),
      meta('text-p', { model: { features: ['tool-use'] } }),
    );
    const cap: Capability = { needs: [{ feature: 'vision' }] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['vision-p']);
  });
});

describe('matchTuples — contextWindow op comparison', () => {
  test('>= filter passes models with enough context', () => {
    const providers = providersOf(
      meta('small', { model: { contextWindow: 8000 } }),
      meta('big', { model: { contextWindow: 200000 } }),
    );
    const cap: Capability = { needs: [{ contextWindow: { op: '>=', value: 128000 } }] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['big']);
  });
});

describe('matchTuples — region requirement', () => {
  test('exact region match wins', () => {
    const providers = providersOf(
      meta('us', { provider: { region: 'us-east-1' } }),
      meta('eu', { provider: { region: 'eu-west-1' } }),
    );
    const cap: Capability = { needs: [{ region: 'eu-west-1' }] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['eu']);
  });
});

describe('matchTuples — provider allow/deny', () => {
  test('allow list narrows survivors', () => {
    const providers = providersOf(meta('a'), meta('b'), meta('c'));
    const cap: Capability = { needs: [{ providers: { allow: ['a', 'c'] } }] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(new Set(r.value.map((t) => t.provider.metadata.id))).toEqual(new Set(['a', 'c']));
  });

  test('deny list excludes even when everything else matches', () => {
    const providers = providersOf(meta('a'), meta('bad'));
    const cap: Capability = { needs: [{ providers: { deny: ['bad'] } }] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['a']);
  });
});

describe('matchTuples — model allow/deny', () => {
  test('allow list narrows to the named models only', () => {
    // One provider exposing three models — filter by name.
    const multi: ProviderMetadata = {
      id: 'anthropic',
      region: 'us-east-1',
      models: [
        {
          name: 'sonnet',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
        },
        {
          name: 'opus',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.015, completionUsdPer1kTokens: 0.075 },
        },
        {
          name: 'haiku',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.00025, completionUsdPer1kTokens: 0.00125 },
        },
      ],
    };
    const providers: readonly ModelProvider[] = [fakeProvider(multi)];
    const cap: Capability = { needs: [{ models: { allow: ['sonnet', 'haiku'] } }] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(new Set(r.value.map((t) => t.model.name))).toEqual(new Set(['sonnet', 'haiku']));
  });

  test('deny excludes the named model even when other requirements pass', () => {
    const multi: ProviderMetadata = {
      id: 'anthropic',
      region: 'us-east-1',
      models: [
        {
          name: 'sonnet',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
        },
        {
          name: 'opus',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.015, completionUsdPer1kTokens: 0.075 },
        },
      ],
    };
    const providers: readonly ModelProvider[] = [fakeProvider(multi)];
    const cap: Capability = { needs: [{ models: { deny: ['opus'] } }] };
    const r = matchTuples({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.model.name)).toEqual(['sonnet']);
  });
});

describe('matchTuples — tenant policy layering', () => {
  test('tenant providers.deny wins even if capability allows the provider', () => {
    const providers = providersOf(meta('openai'), meta('anthropic'));
    const cap: Capability = {
      needs: [{ providers: { allow: ['openai', 'anthropic'] } }],
    };
    const policy: TenantPolicy = { tenantId: TENANT_A, providers: { deny: ['openai'] } };
    const r = matchTuples({ capability: cap, providers, tenantPolicy: policy });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['anthropic']);
  });

  test('tenant models.deny excludes a specific model within an allowed provider', () => {
    const multi: ProviderMetadata = {
      id: 'anthropic',
      region: 'us-east-1',
      models: [
        {
          name: 'sonnet',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
        },
        {
          name: 'opus',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.015, completionUsdPer1kTokens: 0.075 },
        },
      ],
    };
    const providers: readonly ModelProvider[] = [fakeProvider(multi)];
    const cap: Capability = { needs: [{ feature: 'tool-use' }] };
    const policy: TenantPolicy = { tenantId: TENANT_A, models: { deny: ['opus'] } };
    const r = matchTuples({ capability: cap, providers, tenantPolicy: policy });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.model.name)).toEqual(['sonnet']);
  });

  test('tenant regionAllow narrows to a specific region set', () => {
    const providers = providersOf(
      meta('us1', { provider: { region: 'us-east-1' } }),
      meta('us5', { provider: { region: 'us-east5' } }),
      meta('eu', { provider: { region: 'eu-west-1' } }),
    );
    const cap: Capability = { needs: [{ feature: 'tool-use' }] };
    const policy: TenantPolicy = {
      tenantId: TENANT_A,
      regionAllow: ['us-east5'],
    };
    const r = matchTuples({ capability: cap, providers, tenantPolicy: policy });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['us5']);
  });

  test.each([
    ['providers.allow', { providers: { allow: [] } }],
    ['models.allow', { models: { allow: [] } }],
    ['regionAllow', { regionAllow: [] }],
  ] as const)('an empty tenant %s allows nothing (fails closed)', (_, lists) => {
    const providers = providersOf(meta('openai'), meta('anthropic'));
    const cap: Capability = { needs: [{ feature: 'tool-use' }] };
    const policy: TenantPolicy = { tenantId: TENANT_A, ...lists };
    const r = matchTuples({ capability: cap, providers, tenantPolicy: policy });
    expect(r.kind).toBe('err');
  });

  test('an empty tenant deny list denies nothing', () => {
    const providers = providersOf(meta('openai'), meta('anthropic'));
    const cap: Capability = { needs: [{ feature: 'tool-use' }] };
    const policy: TenantPolicy = { tenantId: TENANT_A, providers: { deny: [] } };
    const r = matchTuples({ capability: cap, providers, tenantPolicy: policy });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.map((t) => t.provider.metadata.id)).toEqual(['openai', 'anthropic']);
  });
});

describe('route — preference ranking', () => {
  test('ranks tuples by summed matched preference weights', () => {
    const providers = providersOf(
      meta('cheap', { provider: { attributes: ['lower-cost'] } }),
      meta('smart', { provider: { attributes: ['higher-accuracy'] } }),
    );
    const cap: Capability = {
      needs: [{ feature: 'tool-use' }],
      prefer: [
        { feature: 'higher-accuracy', weight: 3 },
        { feature: 'lower-cost', weight: 1 },
      ],
    };
    const r = route({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.provider.metadata.id).toBe('smart');
    expect(r.value.alternates.map((t) => t.provider.metadata.id)).toEqual(['cheap']);
  });
});

describe('route — preferredModel soft hint', () => {
  test('preferredModel alone promotes any tuple with that model name', () => {
    const providers = providersOf(
      meta('anthropic', { model: { name: 'sonnet', features: ['tool-use'] } }),
      meta('openrouter', { model: { name: 'sonnet', features: ['tool-use'] } }),
      meta('local', { model: { name: 'llama3', features: ['tool-use'] } }),
    );
    const cap: Capability = { needs: [{ feature: 'tool-use' }] };
    const r = route({ capability: cap, providers, preferredModel: 'sonnet' });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    // Either sonnet-bearing tuple should be on top; the local llama3 pushes to the back.
    expect(r.value.model.name).toBe('sonnet');
    const modelsInOrder = [r.value.model.name, ...r.value.alternates.map((t) => t.model.name)];
    expect(modelsInOrder[modelsInOrder.length - 1]).toBe('llama3');
  });

  test('preferredProvider + preferredModel together promote the exact tuple', () => {
    const providers = providersOf(
      meta('anthropic', { model: { name: 'sonnet', features: ['tool-use'] } }),
      meta('openrouter', { model: { name: 'sonnet', features: ['tool-use'] } }),
    );
    const cap: Capability = { needs: [{ feature: 'tool-use' }] };
    const r = route({
      capability: cap,
      providers,
      preferredProvider: 'openrouter',
      preferredModel: 'sonnet',
    });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.provider.metadata.id).toBe('openrouter');
    expect(r.value.model.name).toBe('sonnet');
  });
});

describe('route — fallback providers', () => {
  const cap: Capability = { needs: [{ feature: 'tool-use' }] };

  test('a fallback serves only when no other provider satisfies the capability', () => {
    // `dev-echo` sorts before `gemini`: without the fallback rule it wins the tie.
    const providers = providersOf(
      meta('dev-echo', { provider: { fallback: true } }),
      meta('gemini'),
    );
    const r = route({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.provider.metadata.id).toBe('gemini');
    expect(r.value.fallback).toBe(false);
    // Never an alternate to a regular pick: failover must not land on it.
    expect(r.value.alternates.map((t) => t.provider.metadata.id)).toEqual([]);
  });

  test('with only fallbacks satisfying it, the pick is a fallback and says so', () => {
    const providers = providersOf(
      meta('dev-echo', { provider: { fallback: true } }),
      meta('embedder', { model: { features: ['streaming'] } }),
    );
    const r = route({ capability: cap, providers });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.provider.metadata.id).toBe('dev-echo');
    expect(r.value.fallback).toBe(true);
    expect(r.value.reason).toContain('fallback');
  });

  test('a regular provider the capability rejects does not hide the fallback', () => {
    const providers = providersOf(
      meta('dev-echo', { provider: { fallback: true } }),
      meta('acme', { provider: { region: 'eu-west-1' } }),
    );
    const r = route({
      capability: { needs: [{ feature: 'tool-use' }, { region: 'us-east-1' }] },
      providers,
    });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.provider.metadata.id).toBe('dev-echo');
  });

  test('a preferredProvider hint does not lift a fallback over a regular provider', () => {
    const providers = providersOf(
      meta('dev-echo', { provider: { fallback: true } }),
      meta('anthropic'),
    );
    const r = route({ capability: cap, providers, preferredProvider: 'dev-echo' });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.provider.metadata.id).toBe('anthropic');
  });

  test('a regular pick reports fallback: false', () => {
    const r = route({ capability: cap, providers: providersOf(meta('anthropic')) });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.fallback).toBe(false);
  });
});

describe('route — capability-unsatisfiable', () => {
  test('empty result surfaces per-requirement diagnostic', () => {
    const providers = providersOf(meta('only-us', { provider: { region: 'us-east-1' } }));
    const cap: Capability = { needs: [{ region: 'eu-west-1' }] };
    const r = route({ capability: cap, providers });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('capability-unsatisfiable');
      if (r.error.code === 'capability-unsatisfiable') {
        expect(r.error.reasons[0]?.requirement).toBe('region=eu-west-1');
        // Rejection id is a `<providerId>/<modelName>` tuple key.
        expect(r.error.reasons[0]?.rejectingProviders[0]?.id).toBe('only-us/only-us/model-v1');
      }
    }
  });

  test('empty provider slice rejects everything', () => {
    const cap: Capability = { needs: [{ feature: 'tool-use' }] };
    const r = route({ capability: cap, providers: [] });
    expect(r.kind).toBe('err');
  });
});

describe('route — structured RejectionReason', () => {
  test('missing-feature reason carries the feature name for programmatic matching', () => {
    const providers = providersOf(meta('text-only', { model: { features: [] } }));
    const cap: Capability = { needs: [{ feature: 'vision' }] };
    const r = route({ capability: cap, providers });
    expect(r.kind).toBe('err');
    if (r.kind === 'err' && r.error.code === 'capability-unsatisfiable') {
      const reject = r.error.reasons[0]?.rejectingProviders[0]?.reason;
      expect(reject?.code).toBe('missing-feature');
      if (reject?.code === 'missing-feature') expect(reject.feature).toBe('vision');
    }
  });

  test('region-mismatch reason carries observed + wanted', () => {
    const providers = providersOf(meta('us-only', { provider: { region: 'us-east-1' } }));
    const cap: Capability = { needs: [{ region: 'eu-west-1' }] };
    const r = route({ capability: cap, providers });
    if (r.kind === 'err' && r.error.code === 'capability-unsatisfiable') {
      const reject = r.error.reasons[0]?.rejectingProviders[0]?.reason;
      expect(reject?.code).toBe('region-mismatch');
      if (reject?.code === 'region-mismatch') {
        expect(reject.observed).toBe('us-east-1');
        expect(reject.wanted).toBe('eu-west-1');
      }
    }
  });

  test('capability-kind-mismatch reason carries observed + wanted', () => {
    const providers = providersOf(meta('llm-a', { provider: { capabilityKind: 'llm-inference' } }));
    const cap: Capability = { kind: 'gpu-compute', needs: [] };
    const r = route({ capability: cap, providers });
    if (r.kind === 'err' && r.error.code === 'capability-unsatisfiable') {
      const reject = r.error.reasons[0]?.rejectingProviders[0]?.reason;
      expect(reject?.code).toBe('capability-kind-mismatch');
      if (reject?.code === 'capability-kind-mismatch') {
        expect(reject.observed).toBe('llm-inference');
        expect(reject.wanted).toBe('gpu-compute');
      }
    }
  });

  test('model-on-denylist reason carries the model name', () => {
    const multi: ProviderMetadata = {
      id: 'anthropic',
      region: 'us-east-1',
      models: [
        {
          name: 'opus',
          contextWindow: 200000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.015, completionUsdPer1kTokens: 0.075 },
        },
      ],
    };
    const providers: readonly ModelProvider[] = [fakeProvider(multi)];
    const cap: Capability = { needs: [{ models: { deny: ['opus'] } }] };
    const r = route({ capability: cap, providers });
    if (r.kind === 'err' && r.error.code === 'capability-unsatisfiable') {
      const reject = r.error.reasons[0]?.rejectingProviders[0]?.reason;
      expect(reject?.code).toBe('model-on-denylist');
      if (reject?.code === 'model-on-denylist') expect(reject.modelName).toBe('opus');
    }
  });
});
