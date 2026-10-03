// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ModelCallInput,
  ModelCallResult,
  ModelProvider,
  ProviderMetadata,
} from '../src/index.js';

/**
 * Test-only provider factory. Produces a `ModelProvider` whose `invoke`
 * returns a canned result and whose metadata matches whatever you pass.
 */
export function fakeProvider(
  metadata: ProviderMetadata,
  overrides: {
    readonly invoke?: (input: ModelCallInput) => Promise<ModelCallResult>;
  } = {},
): ModelProvider {
  const invoke =
    overrides.invoke ??
    (async (input: ModelCallInput): Promise<ModelCallResult> => ({
      message: { role: 'assistant', content: `fake-response-from-${metadata.id}` },
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 },
      costUsd: 0.001,
      durationMs: 100,
      provider: { id: metadata.id, model: input.model },
    }));
  return { metadata, invoke };
}
