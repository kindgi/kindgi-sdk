// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The entry a runtime registers: the factory takes models named by their
 * `MODEL_SPECS` key, and the static check run when a provider registers
 * refuses any other name with the factory's own message.
 */

import { describe, expect, test } from 'vitest';

import type { ProviderMetadata } from '@kindgi/capabilities';

import {
  DEFAULT_LOCAL_MODEL,
  IN_PROCESS_ADAPTER_ID,
  MODEL_SPECS,
  inProcessAdapterEntry,
  inProcessCheckConfig,
} from '../src/index.js';

const metadata = (...names: string[]): ProviderMetadata => ({
  id: 'acme-local',
  region: 'local',
  models: names.map((name) => ({
    name,
    contextWindow: 8192,
    features: [],
    cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
  })),
});

describe('inProcessAdapterEntry', () => {
  test('known models: no problems, and the factory builds the provider (no download)', () => {
    const input = { metadata: metadata(DEFAULT_LOCAL_MODEL) };
    expect(inProcessCheckConfig({ ...input, hasSecretRef: false })).toEqual([]);
    expect(inProcessAdapterEntry.factory(input).metadata.id).toBe('acme-local');
  });

  test.each([['gpt-9'], ['constructor'], ['__proto__']])(
    'an unknown model (%s): the check names metadata.models, and the factory throws the same message',
    (name) => {
      const input = { metadata: metadata(DEFAULT_LOCAL_MODEL, name) };
      const problems = inProcessCheckConfig({ ...input, hasSecretRef: false });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.field).toBe('metadata.models');
      expect(problems[0]?.message).toBe(
        `${IN_PROCESS_ADAPTER_ID}: unknown model "${name}" in provider "acme-local". Valid values: ${Object.keys(MODEL_SPECS).join(', ')}.`,
      );
      expect(() => inProcessAdapterEntry.factory(input)).toThrow(problems[0]?.message);
    },
  );

  test('the entry carries the check and the model download', () => {
    expect(inProcessAdapterEntry).toMatchObject({
      adapterId: IN_PROCESS_ADAPTER_ID,
      capabilityKind: 'llm-inference',
      checkConfig: inProcessCheckConfig,
    });
    expect(typeof inProcessAdapterEntry.prepare).toBe('function');
  });
});
