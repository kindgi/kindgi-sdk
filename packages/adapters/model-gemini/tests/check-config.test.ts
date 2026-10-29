// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The static check a runtime runs when a provider registers
 * (`geminiCheckConfig`) agrees with the factory: a registration the check
 * passes builds, and each problem it finds is the error the factory
 * throws, naming the field.
 */

import { describe, expect, test } from 'vitest';

import {
  type AdapterConfig,
  type ProviderMetadata,
  adapterConfigError,
  adapterConfigKeyProblems,
} from '@kindgi/capabilities';

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
function both(
  region: string,
  config: AdapterConfig | undefined,
  hasSecretRef: boolean,
  serverCredentials?: boolean,
) {
  const input = {
    metadata: metadata(region),
    ...(config !== undefined && { config }),
    ...(serverCredentials !== undefined && { serverCredentials }),
  };
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
      expect(problem?.message).not.toContain(GEMINI_ADAPTER_ID);
      expect(thrown).toBeDefined();
      expect(
        problems.map((p) => adapterConfigError(GEMINI_ADAPTER_ID, 'acme-gemini', p).message),
      ).toContain(thrown);
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

describe("a deployment that refuses the server's own credentials (serverCredentials: false)", () => {
  test('Vertex without a key: the check points at secret_ref, and the factory throws the same message', () => {
    const { problems, thrown } = both('global', { project: 'acme-project' }, false, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: '/secret_ref' });
    expect(problems[0]?.message).toContain('Application Default Credentials');
    expect(problems[0]?.message).toContain('KINDGI_TENANT_HOST_ACCESS');
    expect(thrown).toBe(adapterConfigError(GEMINI_ADAPTER_ID, 'acme-gemini', problems[0]!).message);
  });

  test.each([
    ['Vertex with a service-account key', { project: 'acme-project' }],
    ['the Developer API with its key', { api: 'developer' }],
  ] as const)('%s: no problems, and the factory builds it', (_name, config) => {
    const { problems, thrown } = both('global', config, true, false);
    expect(problems).toEqual([]);
    expect(thrown).toBeUndefined();
  });

  test('allowed (true), Vertex without a key builds, as when nothing is said', () => {
    expect(both('global', { project: 'acme-project' }, false, true)).toEqual({
      problems: [],
      thrown: undefined,
    });
  });

  test('a bad project is reported with the missing key', () => {
    const { problems } = both('global', { project: 'x' }, false, false);
    expect(problems.map((p) => p.path)).toEqual(['/adapter_config/project', '/secret_ref']);
  });
});

describe('the keys it takes', () => {
  test("api and project; any other is the registration's to refuse, naming them", () => {
    expect(
      adapterConfigKeyProblems(geminiAdapterEntry, { api: 'vertex', project: 'acme-project' }),
    ).toEqual([]);
    expect(
      adapterConfigKeyProblems(geminiAdapterEntry, {
        project: 'acme-project',
        location: 'us-central1',
      }),
    ).toEqual([
      {
        path: '/adapter_config/location',
        message: "adapter_config.location isn't a setting of this adapter: it takes api, project.",
      },
    ]);
  });

  test('thinkingLevels moved: a new registration is refused, naming where the setting is now', () => {
    expect(
      adapterConfigKeyProblems(geminiAdapterEntry, {
        project: 'acme-project',
        thinkingLevels: 'gemini-3.8-flash=high',
      }),
    ).toEqual([
      {
        path: '/adapter_config/thinkingLevels',
        message:
          "adapter_config.thinkingLevels isn't read here: its setting is metadata.models[].thinking.default.",
      },
    ]);
  });

  test.each([
    ['a key it never took', { project: 'acme-project', location: 'us-central1' }],
    ['the moved thinkingLevels', { project: 'acme-project', thinkingLevels: 'gemini-3.8-flash=x' }],
  ] as const)(
    'a stored registration with %s: its check leaves it be, and it builds',
    (_n, config) => {
      const { problems, thrown } = both('global', config, true, false);
      expect(problems).toEqual([]);
      expect(thrown).toBeUndefined();
    },
  );
});
