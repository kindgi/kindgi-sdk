// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Provider, ProviderPage, RegisterProviderInput } from '@kindgi/client';
import { type KindgiConfig, packLanguage } from '@kindgi/handler-runtime';
import { LOCAL_ENV_NAME, displayEnvPath, packValues, readPackEnv } from '@kindgi/secrets-dotenv';

import type { CommandContext } from '../context.js';
import { loadLocalEnvSettings } from '../env/project-env.js';
import { renderJson } from '../output.js';
import { binDisplay, detectBinRunner } from '../package-manager.js';
import {
  type ProviderPreset,
  loadProviderPresets,
  presetRegistration,
} from '../providers/preset-loader.js';
import {
  type TableSpec,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/** `providers list --table`. */
const PROVIDERS_TABLE: TableSpec<ProviderPage, Provider> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (provider) => provider.id },
    { header: 'REGION', get: (provider) => provider.region },
    { header: 'MODELS', get: (provider) => provider.models.map((m) => m.name).join(', ') },
    { header: 'FALLBACK', get: (provider) => (provider.fallback === true ? 'yes' : '') },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List model providers.',
  usage: 'kindgi providers list [--feature=<name>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    feature: {
      type: 'string',
      description: 'Only the providers with a model that has this feature (e.g. `tool-use`).',
    },
    limit: {
      type: 'string',
      description: 'The most providers to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'providers list',
      async () => {
        const feature = stringFlag(ctx, 'feature');
        const cursor = stringFlag(ctx, 'cursor');
        const limitStr = stringFlag(ctx, 'limit');
        const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined;
        if (limit !== undefined && Number.isNaN(limit)) {
          throw new Error(`--limit must be an integer, got "${limitStr}"`);
        }
        return await ctx.client().providers.list({
          ...(feature !== undefined && { feature }),
          ...(cursor !== undefined && { cursor }),
          ...(limit !== undefined && { limit }),
        });
      },
      PROVIDERS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a provider by id.',
  usage: 'kindgi providers get <provider-id>',
  run: (ctx) =>
    runSdk(ctx, 'providers get', async () => {
      const providerId = requiredPositional(ctx, 0, 'provider-id');
      return await ctx.client().providers.get(providerId);
    }),
};

const register: LeafCommand = {
  kind: 'leaf',
  name: 'register',
  description: 'Register a model provider — from a spec, or a preset (`kindgi providers presets`).',
  usage:
    'kindgi providers register (--spec=<json-or-@file> | --preset=<name> [--models=<a,b>] [--project=<id>] [--secret=<NAME>] [--env=<name>] [--max-output-tokens=<n>])',
  optionSpec: {
    spec: {
      type: 'string',
      description:
        'The registration body as JSON, or `@<file>` to read it from a file. Give `--spec` or `--preset`.',
    },
    preset: {
      type: 'string',
      description: 'Register a built-in preset by name; `kindgi providers presets` lists them.',
    },
    'max-output-tokens': {
      type: 'string',
      description:
        "With `--preset`, each model's output cap (thinking included), in place of the preset's: the model's own limit.",
    },
    models: {
      type: 'string',
      description:
        'With `--preset`, register only these of its models, comma-separated (default: all).',
    },
    project: {
      type: 'string',
      description:
        'For a preset that needs one (`gemini`), the Google Cloud project Vertex AI runs and bills in.',
    },
    secret: {
      type: 'string',
      description:
        "With `--preset`, the name of the secret holding the API key, in place of the preset's own.",
    },
    env: {
      type: 'string',
      description:
        "With `--preset`, the environment of the key's secret (default `local`; in a pack, the key must already be in its env files).",
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'providers register', async () => {
      const specText = stringFlag(ctx, 'spec');
      const presetName = stringFlag(ctx, 'preset');
      if ((specText === undefined) === (presetName === undefined)) {
        throw new Error('one of --spec=<json-or-@file> or --preset=<name> is required');
      }
      if (specText !== undefined) {
        const spec = (await readJsonInput(specText)) as RegisterProviderInput;
        return renderJson(await ctx.client().providers.register(spec), ctx.globals.format);
      }
      const input = await presetInput(ctx, presetName as string);
      const outcome = await ctx.client().providers.register(input);
      const models = input.metadata.models.map((m) => m.name).join(', ');
      const key =
        input.secret_ref !== undefined
          ? ` — key ${input.secret_ref.name} (env ${input.secret_ref.envName})`
          : '';
      return {
        stdout: renderJson(outcome, ctx.globals.format).stdout,
        stderr: `✓ Registered ${input.metadata.id}: ${models}${key}\n`,
      };
    }),
};

/**
 * The registration body for `--preset=<name>`. In `kindgi dev`'s
 * environment (`local`) inside a pack, the preset's secret must already
 * be in the pack's env files — the dev secret binding reads it from
 * there at turn time, so a missing key is caught here rather than on the
 * first agent turn.
 */
async function presetInput(ctx: CommandContext, name: string): Promise<RegisterProviderInput> {
  const presets = await loadProviderPresets();
  const preset = presets[name];
  if (preset === undefined) {
    throw new Error(`no provider preset "${name}" — available: ${Object.keys(presets).join(', ')}`);
  }
  const modelsFlag = stringFlag(ctx, 'models');
  const project = stringFlag(ctx, 'project');
  const secret = stringFlag(ctx, 'secret');
  const envName = stringFlag(ctx, 'env') ?? LOCAL_ENV_NAME;
  const maxOutput = stringFlag(ctx, 'max-output-tokens');
  if (maxOutput !== undefined && !/^[1-9]\d*$/.test(maxOutput)) {
    throw new Error(`--max-output-tokens must be a whole number of at least 1, got "${maxOutput}"`);
  }
  const built = presetRegistration(preset, {
    ...(modelsFlag !== undefined && {
      models: modelsFlag
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m !== ''),
    }),
    ...(secret !== undefined && { secret }),
    envName,
    settings: { project },
    ...(maxOutput !== undefined && { maxOutputTokens: Number(maxOutput) }),
  });
  if (built.kind === 'err') throw new Error(built.message);
  const ref = built.input.secret_ref;
  if (ref !== undefined && ref.envName === LOCAL_ENV_NAME) {
    const missing = await missingPackSecret(ctx, ref.name, preset);
    if (missing !== undefined) throw new Error(missing);
  }
  return built.input;
}

/** Why `name` can't be resolved from the pack's env files, or `undefined` when it can (or this isn't a pack). */
async function missingPackSecret(
  ctx: CommandContext,
  name: string,
  preset: ProviderPreset,
): Promise<string | undefined> {
  const settings = await loadLocalEnvSettings(ctx, ctx.cwd);
  if (settings.kind === 'error' || settings.config === undefined) return undefined;
  const env = await readPackEnv({
    packDir: ctx.cwd,
    envName: LOCAL_ENV_NAME,
    ...(settings.localEnvFiles !== undefined && { localEnvFiles: settings.localEnvFiles }),
    env: ctx.env,
  });
  if (Object.hasOwn(packValues(env.values), name)) return undefined;
  const runner = await detectBinRunner(
    ctx.cwd,
    packLanguage(settings.config as KindgiConfig),
    undefined,
    ctx.env,
  );
  const files = env.files.read.map((p) => displayEnvPath(ctx.cwd, p)).join(', ');
  return [
    `${name} (the ${preset.name} key) is not in ${files}. Set it first, then register again:`,
    `  ${binDisplay(runner, 'kindgi', ['secrets', 'set', name, `--env=${LOCAL_ENV_NAME}`, '--scope=tenant'])}   # a no-echo prompt`,
    `or add ${name}=… to .env yourself.`,
  ].join('\n');
}

const presets: LeafCommand = {
  kind: 'leaf',
  name: 'presets',
  description: 'List the provider presets `register --preset` takes.',
  usage: 'kindgi providers presets',
  run: (ctx) =>
    runSdk(ctx, 'providers presets', async () => {
      const all = await loadProviderPresets();
      return Object.values(all).map((p) => ({
        name: p.name,
        description: p.description,
        adapterId: p.adapterId,
        models: p.metadata.models.map((m) => m.name),
        ...(p.secret !== undefined && { secret: p.secret }),
        ...(p.adapterConfig !== undefined && {
          needs: p.adapterConfig.map((s) => `--${s.key}`),
        }),
        pricesCheckedAt: p.pricesCheckedAt,
      }));
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description: 'Unregister a model provider.',
  usage: 'kindgi providers unregister <provider-id>',
  run: (ctx) =>
    runSdk(ctx, 'providers unregister', async () => {
      const providerId = requiredPositional(ctx, 0, 'provider-id');
      return await ctx.client().providers.unregister(providerId);
    }),
};

export const providersCommand: Command = {
  kind: 'group',
  name: 'providers',
  description: 'Manage model providers.',
  subcommands: [list, get, register, presets, unregister],
};
