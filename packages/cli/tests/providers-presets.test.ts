// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi providers register --preset=<name>` and `kindgi providers
 * presets`: the bundled presets, the registration body built from one,
 * and the key check against the pack's env files.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RunCliInputs } from '../src/main.js';
import { runCli } from '../src/main.js';
import { publishedCliSpec } from '../src/package-manager.js';
import { loadProviderPresets, presetRegistration } from '../src/providers/preset-loader.js';
import { CLI_VERSION } from '../src/version-info.js';

let packDir: string;
const registered: unknown[] = [];

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-provider-presets-'));
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
          register: vi.fn(async (input: { metadata: { id: string } }) => {
            registered.push(input);
            return { providerId: input.metadata.id };
          }),
        },
      }) as never,
  };
}

describe('the bundled presets', () => {
  test('load, each named after its file, with models', async () => {
    const presets = await loadProviderPresets();
    expect(Object.keys(presets).sort()).toEqual([
      'anthropic',
      'azure-openai',
      'bedrock',
      'gemini',
      'gemini-api',
      'groq',
      'openai',
      'openrouter',
    ]);
    expect(presets.anthropic?.metadata.models.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-haiku-4-5',
    ]);
  });

  test('a registration body: a model subset, the secret ref, adapter settings', async () => {
    const { anthropic, gemini } = await loadProviderPresets();
    if (anthropic === undefined || gemini === undefined) throw new Error('presets missing');
    const claude = presetRegistration(anthropic, {
      models: ['claude-haiku-4-5'],
      envName: 'local',
      settings: {},
    });
    expect(claude.kind === 'ok' && claude.input).toMatchObject({
      metadata: { id: 'anthropic', models: [{ name: 'claude-haiku-4-5' }] },
      adapter_id: '@kindgi/adapter-model-anthropic',
      secret_ref: { envName: 'local', name: 'ANTHROPIC_API_KEY' },
    });
    expect(
      presetRegistration(anthropic, { models: ['gpt-9'], envName: 'local', settings: {} }),
    ).toMatchObject({ kind: 'err', message: expect.stringContaining('has no model gpt-9') });

    expect(presetRegistration(gemini, { envName: 'local', settings: {} })).toMatchObject({
      kind: 'err',
      message: expect.stringContaining('needs --project=<…>'),
    });
    const vertex = presetRegistration(gemini, { envName: 'local', settings: { project: 'acme' } });
    expect(vertex.kind === 'ok' && vertex.input).toMatchObject({
      adapter_config: { project: 'acme' },
    });
    expect(vertex.kind === 'ok' && vertex.input.secret_ref).toBeUndefined();
  });

  test("the openai preset's GPT-6 rates are OpenAI's prices (pricing page, 2026-10-07)", async () => {
    const { openai } = await loadProviderPresets();
    if (openai === undefined) throw new Error('preset missing');
    // Per 1M tokens: input, cached input, cache writes, output; then past 272K input tokens.
    const table: Record<string, readonly number[]> = {
      'gpt-6-astra': [10, 1, 12.5, 50, 20, 2, 25, 75],
      'gpt-6.1-sol': [2, 0.1, 2.5, 10, 4, 0.2, 5, 15],
      'gpt-6-luna': [0.1, 0.01, 0.125, 0.5, 0.2, 0.02, 0.25, 0.75],
    };
    for (const model of openai.metadata.models) {
      const cost = model.cost as typeof model.cost & {
        readonly cachedPromptMultiplier: number;
        readonly promptCacheCreationMultiplier: number;
        readonly longContext: {
          readonly thresholdTokens: number;
          readonly promptUsdPer1kTokens: number;
          readonly completionUsdPer1kTokens: number;
        };
        readonly dataResidencyMultiplier: number;
      };
      const perM = (per1k: number) => per1k * 1000;
      const long = cost.longContext;
      const prices = [
        perM(cost.promptUsdPer1kTokens),
        perM(cost.promptUsdPer1kTokens) * cost.cachedPromptMultiplier,
        perM(cost.promptUsdPer1kTokens) * cost.promptCacheCreationMultiplier,
        perM(cost.completionUsdPer1kTokens),
        perM(long.promptUsdPer1kTokens),
        perM(long.promptUsdPer1kTokens) * cost.cachedPromptMultiplier,
        perM(long.promptUsdPer1kTokens) * cost.promptCacheCreationMultiplier,
        perM(long.completionUsdPer1kTokens),
      ];
      const expected = table[model.name];
      if (expected === undefined) throw new Error(`no published prices for ${model.name}`);
      prices.forEach((price, i) => expect(price).toBeCloseTo(expected[i] as number, 9));
      expect(long.thresholdTokens).toBe(272000);
      expect(cost.dataResidencyMultiplier).toBe(1.1);
    }
  });

  test("the anthropic preset's rates are Anthropic's prices, cache writes and reads included (pricing page, 2026-10-07)", async () => {
    const { anthropic } = await loadProviderPresets();
    if (anthropic === undefined) throw new Error('preset missing');
    // Per 1M tokens: input, 5-minute cache writes, cache hits, output; then past 100K
    // prompt tokens (Haiku 5.5 only). Cache hits are 0.05x on Opus 5.5 and Sonnet 5.5.
    const table: Record<string, readonly number[]> = {
      'claude-opus-5-5': [4, 5, 0.2, 20],
      'claude-sonnet-5-5': [2, 2.5, 0.1, 10],
      'claude-haiku-5-5': [0.1, 0.125, 0.01, 0.5, 0.5, 0.625, 0.05, 2.5],
      'claude-haiku-4-5': [1, 1.25, 0.1, 5],
    };
    for (const model of anthropic.metadata.models) {
      const cost = model.cost as typeof model.cost & {
        readonly promptCacheCreationMultiplier: number;
        readonly promptCacheReadMultiplier: number;
        readonly longContext?: {
          readonly promptUsdPer1kTokens: number;
          readonly completionUsdPer1kTokens: number;
        };
      };
      const perM = (per1k: number) => per1k * 1000;
      const rates = (prompt: number, completion: number) => [
        perM(prompt),
        perM(prompt) * cost.promptCacheCreationMultiplier,
        perM(prompt) * cost.promptCacheReadMultiplier,
        perM(completion),
      ];
      const prices = [
        ...rates(cost.promptUsdPer1kTokens, cost.completionUsdPer1kTokens),
        ...(cost.longContext === undefined
          ? []
          : rates(
              cost.longContext.promptUsdPer1kTokens,
              cost.longContext.completionUsdPer1kTokens,
            )),
      ];
      const expected = table[model.name];
      if (expected === undefined) throw new Error(`no published prices for ${model.name}`);
      expect(prices).toHaveLength(expected.length);
      prices.forEach((price, i) => expect(price).toBeCloseTo(expected[i] as number, 9));
    }
  });

  test("the openai preset speaks OpenAI's Responses API, the one GPT-6 calls tools through", async () => {
    const { openai } = await loadProviderPresets();
    if (openai === undefined) throw new Error('preset missing');
    const registration = presetRegistration(openai, { envName: 'local', settings: {} });
    expect(registration.kind === 'ok' && registration.input.adapter_config).toEqual({
      baseURL: 'https://api.openai.com/v1',
      api: 'responses',
    });
  });

  test('openai and openrouter: an OpenAI-compatible endpoint the preset fixes, and its key', async () => {
    const { openai, openrouter } = await loadProviderPresets();
    if (openai === undefined || openrouter === undefined) throw new Error('presets missing');
    const gpt = presetRegistration(openai, { envName: 'local', settings: {} });
    expect(gpt.kind === 'ok' && gpt.input).toMatchObject({
      adapter_id: '@kindgi/adapter-model-openai-compat',
      adapter_config: { baseURL: 'https://api.openai.com/v1' },
      secret_ref: { envName: 'local', name: 'OPENAI_API_KEY' },
    });
    const routed = presetRegistration(openrouter, { envName: 'local', settings: {} });
    expect(routed.kind === 'ok' && routed.input).toMatchObject({
      adapter_config: { baseURL: 'https://openrouter.ai/api/v1' },
      secret_ref: { name: 'OPENROUTER_API_KEY' },
    });
    expect(routed.kind === 'ok' && routed.input.metadata.models.map((m) => m.name)).toContain(
      'anthropic/claude-sonnet-5.5',
    );
  });

  test("gemini-api: Gemini on the Developer API with its key; groq: Groq's endpoint", async () => {
    const presets = await loadProviderPresets();
    const gemini = presets['gemini-api'];
    const groq = presets.groq;
    if (gemini === undefined || groq === undefined) throw new Error('presets missing');
    const g = presetRegistration(gemini, { envName: 'local', settings: {} });
    expect(g.kind === 'ok' && g.input).toMatchObject({
      adapter_id: '@kindgi/adapter-model-gemini',
      adapter_config: { api: 'developer' },
      secret_ref: { name: 'GEMINI_API_KEY' },
    });
    const q = presetRegistration(groq, { envName: 'local', settings: {} });
    expect(q.kind === 'ok' && q.input).toMatchObject({
      adapter_id: '@kindgi/adapter-model-openai-compat',
      adapter_config: { baseURL: 'https://api.groq.com/openai/v1' },
      secret_ref: { name: 'GROQ_API_KEY' },
    });
  });

  test('a preset whose fixed settings are not plain values is refused, naming the file', async () => {
    const io = {
      readdir: async () => ['bad.json'],
      readFile: async () =>
        JSON.stringify({
          name: 'bad',
          description: 'd',
          adapterId: 'a',
          pricesCheckedAt: '2026-10-07',
          adapterConfigValues: { baseURL: { nested: true } },
          metadata: { id: 'bad', models: [{ name: 'm' }] },
        }),
    };
    await expect(loadProviderPresets('/presets', io)).rejects.toThrow(
      'provider preset bad.json: "adapterConfigValues" must be an object of string, number or boolean values',
    );
  });

  test("Gemini's models carry their real output limit, and --max-output-tokens replaces it", async () => {
    const { gemini } = await loadProviderPresets();
    if (gemini === undefined) throw new Error('preset missing');
    const caps = (r: ReturnType<typeof presetRegistration>) =>
      r.kind === 'ok' ? r.input.metadata.models.map((m) => [m.name, m.maxOutputTokens]) : r.message;
    expect(
      caps(presetRegistration(gemini, { envName: 'local', settings: { project: 'acme' } })),
    ).toEqual([
      ['gemini-3.8-flash', 65_536],
      ['gemini-3.5-flash-lite', 65_536],
    ]);
    expect(
      caps(
        presetRegistration(gemini, {
          envName: 'local',
          settings: { project: 'acme' },
          models: ['gemini-3.8-flash'],
          maxOutputTokens: 16_384,
        }),
      ),
    ).toEqual([['gemini-3.8-flash', 16_384]]);
    expect(
      caps(
        presetRegistration(gemini, {
          envName: 'local',
          settings: { project: 'acme' },
          maxOutputTokens: 0,
        }),
      ),
    ).toBe('--max-output-tokens must be a whole number of at least 1, got 0');
  });

  test('Gemini models checked live with typed output declare structured-output, so an agent that needs it routes to them', async () => {
    const presets = await loadProviderPresets();
    const typed = (name: 'gemini' | 'gemini-api', settings: Record<string, string>) => {
      const preset = presets[name];
      if (preset === undefined) throw new Error(`preset ${name} missing`);
      const r = presetRegistration(preset, { envName: 'local', settings });
      if (r.kind !== 'ok') throw new Error(r.message);
      return r.input.metadata.models
        .filter((m) => m.features.includes('structured-output'))
        .map((m) => m.name);
    };
    expect(typed('gemini', { project: 'acme' })).toEqual([
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
    ]);
    // gemini-3.1-pro-preview hasn't been checked with typed output.
    expect(typed('gemini-api', {})).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  });
});

describe('kindgi providers register --preset', () => {
  test('registers the preset once its key is in the pack env files', async () => {
    await writeFile(join(packDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test\n');
    const out = await runCli(
      inputs(['providers', 'register', '--preset=anthropic', '--models=claude-haiku-4-5']),
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ providerId: 'anthropic' });
    expect(out.stderr).toContain(
      '✓ Registered anthropic: claude-haiku-4-5 — key ANTHROPIC_API_KEY (env local)',
    );
    expect(registered).toHaveLength(1);
  });

  test('a missing key stops it, saying how to set one — in the pack’s own kindgi', async () => {
    const out = await runCli(inputs(['providers', 'register', '--preset=anthropic']));
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('ANTHROPIC_API_KEY (the anthropic key) is not in .env');
    expect(out.stderr).toContain(
      `npx --yes ${publishedCliSpec(CLI_VERSION)} secrets set ANTHROPIC_API_KEY --env=local --scope=tenant`,
    );
    expect(registered).toHaveLength(0);
  });

  test('--spec and --preset: exactly one', async () => {
    const both = await runCli(inputs(['providers', 'register', '--preset=anthropic', '--spec={}']));
    expect(both.stderr).toContain('one of --spec=<json-or-@file> or --preset=<name> is required');
    const unknown = await runCli(inputs(['providers', 'register', '--preset=nope']));
    expect(unknown.stderr).toContain(
      'no provider preset "nope" — available: anthropic, azure-openai, bedrock, gemini-api, gemini, groq, openai, openrouter',
    );
  });
});

describe('kindgi providers presets', () => {
  test('lists each preset with its models and what it needs', async () => {
    const out = await runCli(inputs(['providers', 'presets']));
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject([
      { name: 'anthropic', secret: 'ANTHROPIC_API_KEY' },
      {
        name: 'azure-openai',
        secret: 'AZURE_OPENAI_API_KEY',
        needs: ['--resource-name', '--deployments'],
        models: ['gpt-6.1-sol', 'gpt-6-luna'],
      },
      {
        name: 'bedrock',
        needs: ['--region'],
        models: [
          'us.anthropic.claude-sonnet-5-5',
          'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          'us.amazon.nova-pro-v1:0',
          'us.openai.gpt-6.1-sol',
          'us.openai.gpt-6-luna',
        ],
      },
      { name: 'gemini-api', secret: 'GEMINI_API_KEY' },
      {
        name: 'gemini',
        needs: ['--project'],
        models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
      },
      { name: 'groq', secret: 'GROQ_API_KEY' },
      {
        name: 'openai',
        secret: 'OPENAI_API_KEY',
        models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
      },
      { name: 'openrouter', secret: 'OPENROUTER_API_KEY' },
    ]);
  });
});

describe('a preset names its default model', () => {
  test('every bundled preset: a mid-priced model it lists, not its flagship', async () => {
    const presets = await loadProviderPresets();
    const defaults = Object.fromEntries(
      Object.values(presets).map((p) => [p.name, p.metadata.defaultModel]),
    );
    expect(defaults).toEqual({
      anthropic: 'claude-sonnet-5-5',
      'azure-openai': 'gpt-6.1-sol',
      bedrock: 'us.amazon.nova-pro-v1:0',
      'gemini-api': 'gemini-3.8-flash',
      gemini: 'gemini-3.8-flash',
      groq: 'openai/gpt-oss-120b',
      openai: 'gpt-6.1-sol',
      openrouter: 'anthropic/claude-sonnet-5.5',
    });
  });

  test('a registration keeps the default when it registers that model, and drops it when not', async () => {
    const { openai } = await loadProviderPresets();
    if (openai === undefined) throw new Error('no openai preset');
    const all = presetRegistration(openai, { envName: 'local', settings: {} });
    expect(all.kind === 'ok' && all.input.metadata.defaultModel).toBe('gpt-6.1-sol');
    const without = presetRegistration(openai, {
      models: ['gpt-6-luna'],
      envName: 'local',
      settings: {},
    });
    expect(without.kind === 'ok' && 'defaultModel' in without.input.metadata).toBe(false);
  });

  function withGet(defaultModel: string | undefined, keepsRules = true): RunCliInputs {
    const base = inputs(['providers', 'register', '--preset=anthropic']);
    return {
      ...base,
      clientFactory: () =>
        ({
          providers: {
            register: vi.fn(async (input: { metadata: { id: string } }) => {
              registered.push(input);
              return { providerId: input.metadata.id };
            }),
            get: vi.fn(async () => ({
              id: 'anthropic',
              models: [
                { name: 'claude-haiku-4-5' },
                {
                  name: 'claude-opus-5-5',
                  ...(keepsRules && {
                    sampling: false,
                    thinking: { mode: 'always', lowest: 'low' },
                  }),
                },
                { name: 'claude-sonnet-5-5', ...(keepsRules && { sampling: false }) },
              ],
              ...(defaultModel !== undefined && { defaultModel }),
            })),
          },
        }) as never,
    };
  }

  test('the line marks the default; a runtime that keeps it says nothing more', async () => {
    await writeFile(join(packDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test\n');
    const out = await runCli(withGet('claude-sonnet-5-5'));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('claude-sonnet-5-5 (default)');
    expect(out.stderr).not.toContain('predates default models');
    expect(out.stderr).not.toContain("doesn't apply");
  });

  test("a runtime that drops the models' sampling and thinking rules: one line says so, naming the models", async () => {
    await writeFile(join(packDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test\n');
    const out = await runCli(withGet('claude-sonnet-5-5', false));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain(
      "This runtime doesn't apply the models' sampling and thinking rules: an agent that sets a temperature on claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 may be refused. Upgrade the runtime to 0.1.4 or later.",
    );
  });

  test('a runtime that predates default models drops it: one line says what an agent gets instead', async () => {
    await writeFile(join(packDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test\n');
    const out = await runCli(withGet(undefined));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain(
      "This runtime predates default models, so it didn't keep one: an agent that chooses none gets claude-haiku-4-5, not claude-sonnet-5-5.",
    );
  });
});
