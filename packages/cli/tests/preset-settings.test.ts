// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The settings a preset asks its caller for (`PRESET_SETTINGS`), one table for every place
 * that takes them: `providers register`'s flags, a pack's `providers` declarations
 * (`kindgi dev`), `KindgiProviderDeclaration`, the presets list and doctor's hints. Exercised on
 * the two presets that brought the table in: `azure-openai` (`--resource-name`,
 * `--deployments`) and `bedrock` (`--region`, into `metadata`). Their prices are the vendors'
 * (checked 2026-10-09).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type KindgiPresetDeclaration,
  type KindgiPresetSettingValues,
  PRESET_DECLARATION_SETTINGS,
  loadKindgiConfig,
} from '@kindgi/handler-runtime';
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';

import { declaredProviders } from '../src/dev/providers.js';
import type { RunCliInputs } from '../src/main.js';
import { runCli } from '../src/main.js';
import {
  PRESET_SETTINGS,
  type PresetSettingKey,
  type ProviderPreset,
  loadProviderPresets,
} from '../src/providers/preset-loader.js';

let packDir: string;
const registered: {
  metadata: { region: string };
  adapter_config?: unknown;
  secret_ref?: unknown;
}[] = [];

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-preset-settings-'));
  await writeFile(
    join(packDir, 'pyproject.toml'),
    '[project]\nname = "ledger"\nversion = "0.1.0"\n\n[tool.kindgi.pack]\nid = "ledger"\nversion = "0.1.0"\n',
  );
  registered.length = 0;
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

function inputs(argv: readonly string[]): RunCliInputs {
  return {
    argv,
    env: { KINDGI_API_URL: 'http://127.0.0.1:4000', KINDGI_API_TOKEN: 'kgi_bt_test' },
    cwd: packDir,
    home: packDir,
    clientFactory: () =>
      ({
        providers: {
          register: vi.fn(
            async (input: (typeof registered)[number] & { metadata: { id: string } }) => {
              registered.push(input);
              return { providerId: input.metadata.id };
            },
          ),
        },
      }) as never,
  };
}

const DEPLOYMENTS = 'gpt-6.1-sol=gpt-6-1-sol,gpt-6-luna=luna-prod';
const DEPLOYMENTS_MAP = { 'gpt-6.1-sol': 'gpt-6-1-sol', 'gpt-6-luna': 'luna-prod' };

describe('one table', () => {
  test('every setting is a key of a pack’s preset declaration, a map where the table says so', () => {
    expectTypeOf<PresetSettingKey>().toEqualTypeOf<keyof KindgiPresetSettingValues>();
    type MapKeys = {
      [K in PresetSettingKey]: (typeof PRESET_SETTINGS)[K] extends { readonly map: true }
        ? K
        : never;
    }[PresetSettingKey];
    type NotStringKeys = {
      [K in keyof KindgiPresetSettingValues]: KindgiPresetSettingValues[K] extends string
        ? never
        : K;
    }[keyof KindgiPresetSettingValues];
    expectTypeOf<MapKeys>().toEqualTypeOf<NotStringKeys>();
    expect(Object.keys(PRESET_SETTINGS)).toEqual([
      'project',
      'resourceName',
      'deployments',
      'region',
    ]);
  });

  test('each bundled preset asks for exactly its PRESET_DECLARATION_SETTINGS row', async () => {
    const presets = await loadProviderPresets();
    expect(Object.keys(PRESET_DECLARATION_SETTINGS).sort()).toEqual(Object.keys(presets).sort());
    for (const [name, preset] of Object.entries(presets)) {
      expect((preset.adapterConfig ?? []).map((s) => s.key).sort(), name).toEqual(
        [...PRESET_DECLARATION_SETTINGS[name as keyof typeof PRESET_DECLARATION_SETTINGS]].sort(),
      );
    }
  });

  test('the declaration type: a preset’s own settings required, another’s refused', () => {
    expectTypeOf({
      preset: 'bedrock',
      region: 'us-east-2',
    } as const).toMatchTypeOf<KindgiPresetDeclaration>();
    expectTypeOf({
      preset: 'azure-openai',
      resourceName: 'acme-openai',
      deployments: DEPLOYMENTS_MAP,
    } as const).toMatchTypeOf<KindgiPresetDeclaration>();
    expectTypeOf({ preset: 'anthropic' } as const).toMatchTypeOf<KindgiPresetDeclaration>();
    // @ts-expect-error bedrock needs its region
    const noRegion: KindgiPresetDeclaration = { preset: 'bedrock' };
    // @ts-expect-error resourceName is azure-openai's, not bedrock's
    const otherVendors: KindgiPresetDeclaration = {
      preset: 'bedrock',
      region: 'us-east-2',
      resourceName: 'acme-openai',
    };
    const asString: KindgiPresetDeclaration = {
      preset: 'azure-openai',
      resourceName: 'acme-openai',
      // @ts-expect-error deployments is a map, not the flag's string
      deployments: DEPLOYMENTS,
    };
    // @ts-expect-error no such preset
    const unknown: KindgiPresetDeclaration = { preset: 'acme' };
    // Not only a literal's extra key: a value built elsewhere can't carry another's field either.
    const built = { preset: 'bedrock', region: 'us-east-2', resourceName: 'acme-openai' } as const;
    // @ts-expect-error resourceName is azure-openai's
    const fromValue: KindgiPresetDeclaration = built;
    expect([noRegion, otherVendors, asString, unknown, fromValue]).toHaveLength(5);
  });

  test('every bundled preset’s settings are in it (a preset naming another fails to load)', async () => {
    const presets = await loadProviderPresets();
    const used = Object.values(presets).flatMap((p) => (p.adapterConfig ?? []).map((s) => s.key));
    expect(used.filter((key) => !Object.hasOwn(PRESET_SETTINGS, key))).toEqual([]);

    const one = (preset: Record<string, unknown>) => ({
      readdir: async () => ['bad.json'],
      readFile: async () =>
        JSON.stringify({
          name: 'bad',
          description: 'd',
          adapterId: 'a',
          pricesCheckedAt: '2026-10-09',
          metadata: { id: 'bad', region: 'us-east-2', models: [{ name: 'm' }] },
          ...preset,
        }),
    });
    await expect(
      loadProviderPresets('/presets', one({ adapterConfig: [{ key: 'zone', description: 'd' }] })),
    ).rejects.toThrow(
      'provider preset bad.json: "adapterConfig" names "zone", which isn\'t a setting the CLI takes: add it to PRESET_SETTINGS',
    );
    await expect(
      loadProviderPresets(
        '/presets',
        one({ adapterConfig: [{ key: 'project', description: 'd', in: 'metadata' }] }),
      ),
    ).rejects.toThrow('"in" may only be "metadata", for "region"');
  });

  test("a preset's region is its own, or the caller's and then never in the file", async () => {
    const file = (preset: Record<string, unknown>) => ({
      readdir: async () => ['bad.json'],
      readFile: async () =>
        JSON.stringify({
          name: 'bad',
          description: 'd',
          adapterId: 'a',
          pricesCheckedAt: '2026-10-09',
          ...preset,
        }),
    });
    const fromCaller = [{ key: 'region', description: 'd', in: 'metadata' }];
    await expect(
      loadProviderPresets(
        '/presets',
        file({
          adapterConfig: fromCaller,
          metadata: { id: 'bad', region: 'us-east-2', models: [{ name: 'm' }] },
        }),
      ),
    ).rejects.toThrow('"metadata.region" comes from --region');
    await expect(
      loadProviderPresets('/presets', file({ metadata: { id: 'bad', models: [{ name: 'm' }] } })),
    ).rejects.toThrow('"metadata.region" must be a non-empty string');
    const { bedrock } = await loadProviderPresets();
    expect(bedrock?.metadata).not.toHaveProperty('region');
  });
});

describe('kindgi providers register --preset', () => {
  test('azure-openai: --resource-name and --deployments into adapter_config, with its key', async () => {
    await writeFile(join(packDir, '.env'), 'AZURE_OPENAI_API_KEY=azure-test-key\n');
    const out = await runCli(
      inputs([
        'providers',
        'register',
        '--preset=azure-openai',
        '--resource-name=acme-openai',
        `--deployments=${DEPLOYMENTS}`,
      ]),
    );
    expect(out.exitCode).toBe(0);
    expect(registered[0]).toMatchObject({
      adapter_config: { resourceName: 'acme-openai', deployments: DEPLOYMENTS },
      secret_ref: { envName: 'local', name: 'AZURE_OPENAI_API_KEY' },
    });
  });

  test('azure-openai without its settings: a usage error naming each flag', async () => {
    await writeFile(join(packDir, '.env'), 'AZURE_OPENAI_API_KEY=azure-test-key\n');
    const out = await runCli(inputs(['providers', 'register', '--preset=azure-openai']));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('preset "azure-openai" needs --resource-name=<…>');
    expect(out.stderr).toContain('--deployments=<…>');
    expect(registered).toHaveLength(0);
  });

  test('bedrock: --region into metadata.region; no key, no adapter_config', async () => {
    const out = await runCli(
      inputs(['providers', 'register', '--preset=bedrock', '--region=us-west-2']),
    );
    expect(out.exitCode).toBe(0);
    expect(registered[0]?.metadata.region).toBe('us-west-2');
    expect(registered[0]?.adapter_config).toBeUndefined();
    expect(registered[0]?.secret_ref).toBeUndefined();
  });
});

describe('a pack’s providers declarations (kindgi dev)', () => {
  let presets: Readonly<Record<string, ProviderPreset>>;
  beforeEach(async () => {
    presets = await loadProviderPresets();
  });
  const parse = (providers: unknown) =>
    declaredProviders(
      { pack: { id: 'acme', version: '0.1.0' }, providers },
      'kindgi.config.ts',
      presets,
    );

  test('the same settings by key, into the same places; deployments, a map, as the flag’s string', () => {
    const out = parse([
      { preset: 'azure-openai', resourceName: 'acme-openai', deployments: DEPLOYMENTS_MAP },
      { preset: 'bedrock', region: 'us-east-2', models: ['us.amazon.nova-pro-v1:0'] },
    ]);
    if (out.kind !== 'ok') throw new Error(out.message);
    const [azure, bedrock] = out.providers;
    expect(azure?.input.adapter_config).toEqual({
      resourceName: 'acme-openai',
      deployments: DEPLOYMENTS,
    });
    // The round trip: the wire's string reads back as the declared map.
    const wire = String((azure?.input.adapter_config as { deployments: string }).deployments);
    expect(Object.fromEntries(wire.split(',').map((e) => e.split('=')))).toEqual(DEPLOYMENTS_MAP);
    expect(bedrock?.input.metadata.region).toBe('us-east-2');
    expect(bedrock?.input.adapter_config).toBeUndefined();
  });

  test('a missing setting is named by its key, not its flag; a bad one is refused', () => {
    const missing = parse([{ preset: 'azure-openai', resourceName: 'acme-openai' }]);
    expect(missing.kind === 'invalid' && missing.message).toContain(
      'preset "azure-openai" needs `deployments`',
    );
    const empty = parse([{ preset: 'bedrock', region: '' }]);
    expect(empty.kind === 'invalid' && empty.message).toContain(
      '`region` must be a non-empty string.',
    );
  });

  test.each([
    [{ deployments: DEPLOYMENTS }, '`deployments` must be a map of model to deployment'],
    [{ deployments: {} }, '`deployments` must name at least one model.'],
    [{ deployments: { 'gpt-6.1-sol': '' } }, '`deployments.gpt-6.1-sol` must be a non-empty name'],
    [{ deployments: { 'a,b': 'x' } }, '"a,b" isn\'t a model name'],
    [{ deployments: { 'gpt-6.1-sol': 'x=y' } }, 'without `,` or `=`'],
  ])('azure-openai %j: refused', (settings, words) => {
    const out = parse([{ preset: 'azure-openai', resourceName: 'acme-openai', ...settings }]);
    expect(out.kind === 'invalid' && out.message).toContain(words);
  });

  test('another preset’s setting is refused, naming whose it is', () => {
    const out = parse([{ preset: 'bedrock', region: 'us-east-2', resourceName: 'acme-openai' }]);
    expect(out.kind === 'invalid' && out.message).toContain(
      'preset "bedrock" takes `preset`, `models`, `secret`, `maxOutputTokens`, `region`; not `resourceName` (a setting of azure-openai).',
    );
  });

  test('pyproject.toml: deployments is a table; a model named twice is refused when it loads', async () => {
    const pyproject = (deployments: string) =>
      `[project]\nname = "ledger"\nversion = "0.1.0"\n\n[tool.kindgi.pack]\nid = "ledger"\nversion = "0.1.0"\n\n[[tool.kindgi.providers]]\npreset = "azure-openai"\nresourceName = "acme-openai"\n\n[tool.kindgi.providers.deployments]\n${deployments}\n`;
    await writeFile(
      join(packDir, 'pyproject.toml'),
      pyproject('"gpt-6.1-sol" = "gpt-6-1-sol"\n"gpt-6-luna" = "luna-prod"'),
    );
    const loaded = await loadKindgiConfig(packDir);
    if (loaded.kind !== 'ok') throw new Error(loaded.error.message);
    const out = declaredProviders(loaded.value, 'pyproject.toml', presets);
    if (out.kind !== 'ok') throw new Error(out.message);
    expect(out.providers[0]?.input.adapter_config).toEqual({
      resourceName: 'acme-openai',
      deployments: DEPLOYMENTS,
    });

    await writeFile(
      join(packDir, 'pyproject.toml'),
      pyproject('"gpt-6.1-sol" = "gpt-6-1-sol"\n"gpt-6.1-sol" = "sol-prod"'),
    );
    expect((await loadKindgiConfig(packDir)).kind).toBe('err');
  });
});

describe('the vendors’ prices (checked 2026-10-09)', () => {
  /** Per 1M tokens: input, cached input, cache writes, output; then past 272K input tokens, when it has a tier. */
  const pricesOf = (preset: ProviderPreset | undefined) =>
    Object.fromEntries(
      (preset?.metadata.models ?? []).map((model) => {
        const cost = model.cost as typeof model.cost & {
          readonly cachedPromptMultiplier: number;
          readonly promptCacheCreationMultiplier: number;
          readonly longContext?: {
            readonly thresholdTokens: number;
            readonly promptUsdPer1kTokens: number;
            readonly completionUsdPer1kTokens: number;
          };
        };
        const perM = (per1k: number) => Math.round(per1k * 1000 * 1e6) / 1e6;
        const long = cost.longContext;
        return [
          model.name,
          [
            perM(cost.promptUsdPer1kTokens),
            perM(cost.promptUsdPer1kTokens * cost.cachedPromptMultiplier),
            perM(cost.promptUsdPer1kTokens * cost.promptCacheCreationMultiplier),
            perM(cost.completionUsdPer1kTokens),
            ...(long === undefined
              ? []
              : [
                  long.thresholdTokens,
                  perM(long.promptUsdPer1kTokens),
                  perM(long.completionUsdPer1kTokens),
                ]),
          ],
        ];
      }),
    );

  test("azure-openai: Azure's Global Standard prices (Azure Retail Prices API, Azure OpenAI GPT6)", async () => {
    const { 'azure-openai': azure } = await loadProviderPresets();
    // 272K: OpenAI's threshold for these models (Azure's pages don't state one).
    expect(pricesOf(azure)).toEqual({
      'gpt-6.1-sol': [2, 0.1, 2.5, 10, 272000, 4, 15],
      'gpt-6-luna': [0.1, 0.01, 0.125, 0.5, 272000, 0.2, 0.75],
    });
  });

  test("bedrock: AWS's on-demand prices for the US cross-region profiles (Price List API, model cards)", async () => {
    const { bedrock } = await loadProviderPresets();
    // Sonnet 5.5 has no long-context tier: Anthropic bills its whole 1M window at the standard
    // rates (its pricing page, "Long context pricing"), and Bedrock's US profiles are those rates
    // plus the 10% regional premium. GPT-6's cache writes are 1.25x input, as OpenAI lists them.
    // Each was read on 2026-10-09.
    expect(pricesOf(bedrock)).toEqual({
      'us.anthropic.claude-sonnet-5-5': [2.2, 0.11, 2.75, 11],
      'us.amazon.nova-pro-v1:0': [0.8, 0.2, 0, 3.2],
      'us.openai.gpt-6.1-sol': [2.2, 0.11, 2.75, 11, 272000, 4.4, 16.5],
      'us.openai.gpt-6-luna': [0.11, 0.011, 0.1375, 0.55, 272000, 0.22, 0.825],
    });
  });
});
