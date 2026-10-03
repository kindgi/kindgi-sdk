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
import { loadProviderPresets, presetRegistration } from '../src/providers/preset-loader.js';

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
    expect(Object.keys(presets).sort()).toEqual(['anthropic', 'gemini']);
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
    expect(out.stderr).toContain('kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant');
    expect(registered).toHaveLength(0);
  });

  test('--spec and --preset: exactly one', async () => {
    const both = await runCli(inputs(['providers', 'register', '--preset=anthropic', '--spec={}']));
    expect(both.stderr).toContain('one of --spec=<json-or-@file> or --preset=<name> is required');
    const unknown = await runCli(inputs(['providers', 'register', '--preset=openai']));
    expect(unknown.stderr).toContain('no provider preset "openai" — available: anthropic, gemini');
  });
});

describe('kindgi providers presets', () => {
  test('lists each preset with its models and what it needs', async () => {
    const out = await runCli(inputs(['providers', 'presets']));
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject([
      { name: 'anthropic', secret: 'ANTHROPIC_API_KEY' },
      { name: 'gemini', needs: ['--project'], models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
    ]);
  });
});
