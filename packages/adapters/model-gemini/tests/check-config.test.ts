// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The static check a runtime runs when a provider registers
 * (`geminiCheckConfig`) agrees with the factory: a registration the check
 * passes builds, and each problem it finds is the error the factory
 * throws, naming the field.
 */

import { describe, expect, test } from 'vitest';

import type { AdapterConfig, ProviderMetadata } from '@kindgi/capabilities';

import { GEMINI_ADAPTER_ID, geminiAdapterEntry, geminiCheckConfig } from '../src/index.js';

const metadata = (region: string): ProviderMetadata => ({
  id: 'acme-gemini',
  region,
  models: [
    {
      name: 'gemini-3.8-flash',
      contextWindow: 1048576,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
    },
  ],
});

/** The check's problems, and what the factory does with the same registration. */
function both(region: string, config: AdapterConfig | undefined, hasSecretRef: boolean) {
  const input = { metadata: metadata(region), ...(config !== undefined && { config }) };
  const problems = geminiCheckConfig({ ...input, hasSecretRef });
  let thrown: string | undefined;
  try {
    geminiAdapterEntry.factory({
      ...input,
      ...(hasSecretRef && { resolveApiKey: async () => 'unused' }),
    });
  } catch (err) {
    thrown = (err as Error).message;
  }
  return { problems, thrown };
}

describe('geminiCheckConfig agrees with the factory', () => {
  test.each([
    ['Vertex, the preset', 'global', { project: 'acme-project' }, false],
    ['Vertex, a region', 'us-central1', { project: 'acme-project', api: 'vertex' }, false],
    [
      'Vertex, a project number and a service-account key',
      'unspecified',
      { project: '123456789012' },
      true,
    ],
    ['the Developer API with its key', 'unspecified', { api: 'developer' }, true],
  ] as const)('%s: no problems, and the factory builds it', (_name, region, config, key) => {
    const { problems, thrown } = both(region, config, key);
    expect(problems).toEqual([]);
    expect(thrown).toBeUndefined();
  });

  test.each([
    [
      'an API it does not speak',
      'global',
      { project: 'acme-project', api: 'aistudio' },
      false,
      '/adapter_config/api',
      'adapter_config.api must be "vertex" or "developer"',
    ],
    [
      'the Developer API without a key',
      'unspecified',
      { api: 'developer' },
      false,
      '/secret_ref',
      'needs secret_ref: its Gemini API key',
    ],
    [
      'Vertex without a project',
      'global',
      undefined,
      false,
      '/adapter_config/project',
      'needs adapter_config.project (the Vertex AI project)',
    ],
    [
      'a project that is not a project id',
      'global',
      { project: 'acme.example.com/x' },
      false,
      '/adapter_config/project',
      'must be a Google Cloud project id or number',
    ],
    [
      'a region that is not a location',
      'evil.example.com',
      { project: 'acme-project' },
      false,
      '/metadata/region',
      'must be a Vertex AI location',
    ],
  ] as const)(
    '%s: the check points at the setting, and the factory throws the same message',
    (_name, region, config, key, path, says) => {
      const { problems, thrown } = both(region, config, key);
      const problem = problems.find((p) => p.path === path);
      expect(problem?.message).toContain(says);
      expect(problem?.message.startsWith(`${GEMINI_ADAPTER_ID}: provider "acme-gemini"`)).toBe(
        true,
      );
      expect(thrown).toBeDefined();
      expect(problems.map((p) => p.message)).toContain(thrown);
    },
  );

  test('a bad project and a bad region are both reported', () => {
    const { problems } = both('evil.example.com', { project: 'x' }, false);
    expect(problems.map((p) => p.path)).toEqual(['/adapter_config/project', '/metadata/region']);
  });

  test('the entry a runtime registers carries the check', () => {
    expect(geminiAdapterEntry).toMatchObject({
      adapterId: GEMINI_ADAPTER_ID,
      capabilityKind: 'llm-inference',
      checkConfig: geminiCheckConfig,
    });
  });
});
