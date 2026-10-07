// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The entry a runtime registers: the factory needs a `secret_ref`, and the
 * static check run when a provider registers says the same thing.
 */

import { describe, expect, test } from 'vitest';

import type { ProviderMetadata } from '@kindgi/capabilities';

import { ANTHROPIC_ADAPTER_ID, anthropicAdapterEntry, anthropicCheckConfig } from '../src/index.js';

const metadata: ProviderMetadata = {
  id: 'acme-claude',
  region: 'unspecified',
  models: [
    {
      name: 'claude-sonnet-5-5',
      contextWindow: 1000000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.002, completionUsdPer1kTokens: 0.01 },
    },
  ],
};

describe('anthropicAdapterEntry', () => {
  test('with a secret_ref: no problems, and the factory builds the provider', () => {
    expect(anthropicCheckConfig({ metadata, hasSecretRef: true })).toEqual([]);
    const provider = anthropicAdapterEntry.factory({
      metadata,
      resolveApiKey: async () => 'unused',
    });
    expect(provider.metadata.id).toBe('acme-claude');
  });

  test('without one: the check names secret_ref, and the factory throws the same message', () => {
    const problems = anthropicCheckConfig({ metadata, hasSecretRef: false });
    expect(problems).toEqual([
      {
        path: '/secret_ref',
        message: `${ANTHROPIC_ADAPTER_ID}: provider "acme-claude" needs secret_ref: its Anthropic API key.`,
      },
    ]);
    expect(() => anthropicAdapterEntry.factory({ metadata })).toThrow(problems[0]?.message);
  });

  test('the entry carries the check', () => {
    expect(anthropicAdapterEntry).toMatchObject({
      adapterId: ANTHROPIC_ADAPTER_ID,
      capabilityKind: 'llm-inference',
      checkConfig: anthropicCheckConfig,
    });
  });
});
