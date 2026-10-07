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
      'gemini',
      'gemini-api',
      'groq',
      'openai',
      'openrouter',
    ]);
    expect(presets.anthropic?.metadata.models.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
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
      'no provider preset "nope" — available: anthropic, gemini-api, gemini, groq, openai, openrouter',
    );
  });
});

describe('kindgi providers presets', () => {
  test('lists each preset with its models and what it needs', async () => {
    const out = await runCli(inputs(['providers', 'presets']));
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject([
      { name: 'anthropic', secret: 'ANTHROPIC_API_KEY' },
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
