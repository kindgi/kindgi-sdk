// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Provider presets — `kindgi providers register --preset=<name>`.
 *
 * A preset is a vendor's registration body with the models, context
 * windows and prices filled in (`src/providers/presets/<name>.json`,
 * copied to `dist/providers/presets/` at build): its adapter, the secret
 * its credential lives in (if any), the adapter settings it fixes itself
 * (e.g. an OpenAI-compatible endpoint's `baseURL`) or needs from the
 * caller (e.g. Gemini's `--project`), and `metadata`. Prices change
 * with the vendors' — `pricesCheckedAt` says when they were last read.
 *
 * The settings a preset can ask its caller for are one table,
 * `PRESET_SETTINGS`: `providers register` takes each as a flag, and a
 * pack's `providers` declarations as a key (`kindgi dev`). A preset that
 * names a setting the table doesn't have fails to load.
 */

import { readFile as nodeReadFile, readdir as nodeReaddir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RegisterProviderInput } from '@kindgi/client';

export interface ProviderPreset {
  /** Matches the JSON filename stem; `--preset=<name>`. */
  readonly name: string;
  /** One line for `kindgi providers presets`. */
  readonly description: string;
  readonly adapterId: string;
  /** The secret holding the credential; absent when the adapter finds its own. */
  readonly secret?: string;
  /**
   * Settings the caller supplies (each a `PRESET_SETTINGS` key): into
   * `adapter_config`, or, marked `"in": "metadata"`, into `metadata`.
   */
  readonly adapterConfig?: readonly PresetSetting[];
  /** Adapter settings the preset fixes, e.g. `{ "baseURL": "https://api.openai.com/v1" }`. */
  readonly adapterConfigValues?: Readonly<Record<string, string | number | boolean>>;
  /** When the models' prices were last checked against the vendor's. */
  readonly pricesCheckedAt: string;
  readonly metadata: PresetMetadata;
}

export interface PresetSetting {
  /** A `PRESET_SETTINGS` key. */
  readonly key: string;
  readonly description: string;
  /** Where the value goes: `adapter_config` (absent), or `metadata` (Bedrock's `region`). */
  readonly in?: 'metadata';
}

/**
 * Every setting a preset can ask its caller for, by its key in a pack's
 * `providers` declarations (`kindgi.config.ts`, `pyproject.toml`): the
 * `providers register` flag that takes it, and that flag's help. The
 * register flags, `kindgi dev`'s declaration keys and the presets list all
 * read this table. `KindgiPresetSettingValues` has a field for each key, and
 * each preset's `adapterConfig` is its `PRESET_DECLARATION_SETTINGS` row
 * (tests hold them equal). A `map` setting is a map in a declaration
 * (`{ "gpt-6.1-sol": "gpt-6-1-sol" }`) and `key=value,…` on the flag and the
 * wire.
 */
export const PRESET_SETTINGS = {
  project: {
    flag: 'project',
    description:
      'For a preset that needs one (`gemini`), the Google Cloud project Vertex AI runs and bills in.',
  },
  resourceName: {
    flag: 'resource-name',
    description: 'For `azure-openai`: the Azure OpenAI resource, as in `<name>.openai.azure.com`.',
  },
  deployments: {
    flag: 'deployments',
    description:
      'For `azure-openai`: the deployment serving each model, `model=deployment,…` (e.g. `gpt-6.1-sol=gpt-6-1-sol`).',
    map: { keysAreModels: true, example: '{ "gpt-6.1-sol": "gpt-6-1-sol" }' },
  },
  region: {
    flag: 'region',
    description: 'For `bedrock`: the AWS region Bedrock runs in (e.g. `us-east-2`).',
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly flag: string;
      readonly description: string;
      /**
       * A map in a declaration: `keysAreModels` when each key is a model the declaration
       * registers (every one of them, and no other); `example`, for the messages.
       */
      readonly map?: { readonly keysAreModels: boolean; readonly example: string };
    }
  >
>;

export type PresetSettingKey = keyof typeof PRESET_SETTINGS;

const isPresetSettingKey = (key: string): key is PresetSettingKey =>
  Object.hasOwn(PRESET_SETTINGS, key);

/** A map setting's rule in a declaration (`deployments`), `key=value,…` on the flag; else undefined. */
export const mapSettingOf = (
  key: PresetSettingKey,
): { readonly keysAreModels: boolean; readonly example: string } | undefined => {
  const setting = PRESET_SETTINGS[key];
  return 'map' in setting ? setting.map : undefined;
};

/** Whether a setting is a map in a declaration (`deployments`), `key=value,…` on the flag. */
export const isMapSetting = (key: PresetSettingKey): boolean => mapSettingOf(key) !== undefined;

/** A `map` setting's declared map as its flag's and the wire's `key=value,…`. */
export const presetSettingMapValue = (map: Readonly<Record<string, string>>): string =>
  Object.entries(map)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

/** A setting's `providers register` flag, as a message names it: `--resource-name`. */
export const presetSettingFlag = (key: string): string =>
  `--${isPresetSettingKey(key) ? PRESET_SETTINGS[key].flag : key}`;

type PresetMetadata = RegisterProviderInput['metadata'];

const __dirname = dirname(fileURLToPath(import.meta.url));

export function defaultProviderPresetsRoot(): string {
  return join(__dirname, 'presets');
}

export interface PresetIO {
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
}

const DEFAULT_IO: PresetIO = {
  readdir: async (path) => nodeReaddir(path),
  readFile: async (path) => nodeReadFile(path, 'utf8'),
};

/** Every preset, by name. A malformed file fails the load, naming the file. */
export async function loadProviderPresets(
  dir: string = defaultProviderPresetsRoot(),
  io: PresetIO = DEFAULT_IO,
): Promise<Readonly<Record<string, ProviderPreset>>> {
  const files = (await io.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const presets: Record<string, ProviderPreset> = {};
  for (const file of files) {
    const problem = (message: string): Error => new Error(`provider preset ${file}: ${message}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await io.readFile(join(dir, file)));
    } catch (err) {
      throw problem(`invalid JSON — ${(err as Error).message}`);
    }
    const preset = checkPreset(parsed);
    if (typeof preset === 'string') throw problem(preset);
    if (preset.name !== file.replace(/\.json$/, '')) {
      throw problem(`name "${preset.name}" does not match the file name`);
    }
    presets[preset.name] = preset;
  }
  return presets;
}

function checkPreset(input: unknown): ProviderPreset | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'must be a JSON object';
  }
  const p = input as Record<string, unknown>;
  for (const key of ['name', 'description', 'adapterId', 'pricesCheckedAt'] as const) {
    if (typeof p[key] !== 'string' || p[key] === '') return `"${key}" must be a non-empty string`;
  }
  if (p.secret !== undefined && (typeof p.secret !== 'string' || p.secret === '')) {
    return '"secret" must be a non-empty string';
  }
  const configProblem = adapterConfigProblem(p);
  if (configProblem !== undefined) return configProblem;
  const metadata = p.metadata as { readonly id?: unknown; readonly models?: unknown } | undefined;
  if (
    metadata === undefined ||
    typeof metadata.id !== 'string' ||
    !Array.isArray(metadata.models) ||
    metadata.models.length === 0 ||
    !metadata.models.every((m) => typeof (m as { name?: unknown }).name === 'string')
  ) {
    return '"metadata" must have an id and at least one named model';
  }
  const region = regionProblem(p, (metadata as { readonly region?: unknown }).region);
  if (region !== undefined) return region;
  const defaultModel = (metadata as { readonly defaultModel?: unknown }).defaultModel;
  if (
    defaultModel !== undefined &&
    !metadata.models.some((m) => (m as { name: string }).name === defaultModel)
  ) {
    return '"metadata.defaultModel" must name one of its models';
  }
  return input as ProviderPreset;
}

/**
 * The region is the preset's own, or the caller's (`--region`) and then never the preset's, so
 * nobody takes a value that's never sent for a fallback.
 */
function regionProblem(p: Readonly<Record<string, unknown>>, region: unknown): string | undefined {
  const fromCaller = ((p.adapterConfig ?? []) as readonly PresetSetting[]).some(
    (s) => s.key === 'region' && s.in === 'metadata',
  );
  if (fromCaller && region !== undefined) {
    return '"metadata.region" comes from --region (its "adapterConfig" setting): leave it out';
  }
  if (!fromCaller && (typeof region !== 'string' || region === '')) {
    return '"metadata.region" must be a non-empty string, or an "adapterConfig" setting "region" with "in": "metadata"';
  }
  return undefined;
}

/** What's wrong with a preset's `adapterConfig` / `adapterConfigValues`, if anything. */
function adapterConfigProblem(p: Readonly<Record<string, unknown>>): string | undefined {
  if (
    p.adapterConfig !== undefined &&
    (!Array.isArray(p.adapterConfig) ||
      !p.adapterConfig.every(
        (s) =>
          s !== null &&
          typeof s === 'object' &&
          typeof (s as PresetSetting).key === 'string' &&
          typeof (s as PresetSetting).description === 'string',
      ))
  ) {
    return '"adapterConfig" must be a list of { key, description }';
  }
  for (const setting of (p.adapterConfig ?? []) as readonly PresetSetting[]) {
    if (!isPresetSettingKey(setting.key)) {
      return `"adapterConfig" names "${setting.key}", which isn't a setting the CLI takes: add it to PRESET_SETTINGS (a flag, and a key in KindgiProviderDeclaration)`;
    }
    if (setting.in !== undefined && !(setting.in === 'metadata' && setting.key === 'region')) {
      return `"adapterConfig" setting "${setting.key}": "in" may only be "metadata", for "region"`;
    }
  }
  const values = p.adapterConfigValues;
  if (
    values !== undefined &&
    (values === null ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      !Object.values(values).every((v) => ['string', 'number', 'boolean'].includes(typeof v)))
  ) {
    return '"adapterConfigValues" must be an object of string, number or boolean values';
  }
  return undefined;
}

export interface PresetChoices {
  /** A subset of the preset's model names; all of them when absent. */
  readonly models?: readonly string[];
  /** Overrides the preset's secret name. */
  readonly secret?: string;
  /** The secret's environment (`local` in `kindgi dev`). */
  readonly envName: string;
  /** The values of the preset's `adapterConfig` settings, by key. */
  readonly settings: Readonly<Record<string, string | undefined>>;
  /**
   * Each registered model's output cap, in place of the preset's (the
   * model's own limit): what one answer may use, thinking included.
   */
  readonly maxOutputTokens?: number;
}

/** The registration body for a preset, or why the choices don't fit it. */
export function presetRegistration(
  preset: ProviderPreset,
  choices: PresetChoices,
):
  | { readonly kind: 'ok'; readonly input: RegisterProviderInput }
  | {
      readonly kind: 'err';
      readonly message: string;
    } {
  const all = preset.metadata.models;
  const unknown = (choices.models ?? []).filter((name) => !all.some((m) => m.name === name));
  if (unknown.length > 0) {
    return {
      kind: 'err',
      message: `preset "${preset.name}" has no model ${unknown.join(', ')} — it has ${all.map((m) => m.name).join(', ')}`,
    };
  }
  const chosen =
    choices.models === undefined ? all : all.filter((m) => choices.models?.includes(m.name));
  const cap = choices.maxOutputTokens;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
    return {
      kind: 'err',
      message: `--max-output-tokens must be a whole number of at least 1, got ${cap}`,
    };
  }
  const models = cap === undefined ? chosen : chosen.map((m) => ({ ...m, maxOutputTokens: cap }));
  const missing = (preset.adapterConfig ?? []).filter((s) => choices.settings[s.key] === undefined);
  if (missing.length > 0) {
    return {
      kind: 'err',
      message: `preset "${preset.name}" needs ${missing.map((s) => `${presetSettingFlag(s.key)}=<…> (${s.description})`).join(', ')}`,
    };
  }
  const secret = choices.secret ?? preset.secret;
  const settingsFor = (where: 'metadata' | 'adapterConfig') =>
    Object.fromEntries(
      (preset.adapterConfig ?? [])
        .filter((s) => (s.in === 'metadata') === (where === 'metadata'))
        .map((s) => [s.key, choices.settings[s.key] as string]),
    );
  const adapterConfig = { ...preset.adapterConfigValues, ...settingsFor('adapterConfig') };
  // The preset's default, when it's among the models registered.
  const { defaultModel, ...rest } = preset.metadata;
  const keepDefault = defaultModel !== undefined && models.some((m) => m.name === defaultModel);
  return {
    kind: 'ok',
    input: {
      metadata: {
        ...rest,
        ...settingsFor('metadata'),
        models,
        ...(keepDefault && { defaultModel }),
      },
      adapter_id: preset.adapterId,
      ...(secret !== undefined && { secret_ref: { envName: choices.envName, name: secret } }),
      ...(Object.keys(adapterConfig).length > 0 && { adapter_config: adapterConfig }),
    },
  };
}
