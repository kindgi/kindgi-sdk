// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Provider presets — `kindgi providers register --preset=<name>`.
 *
 * A preset is a vendor's registration body with the models, context
 * windows and prices filled in (`src/providers/presets/<name>.json`,
 * copied to `dist/providers/presets/` at build): its adapter, the secret
 * its credential lives in (if any), the adapter settings it needs from
 * the caller (e.g. Gemini's `--project`), and `metadata`. Prices change
 * with the vendors' — `pricesCheckedAt` says when they were last read.
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
  /** Adapter settings the caller supplies, each as `--<key>=<value>`. */
  readonly adapterConfig?: readonly PresetSetting[];
  /** When the models' prices were last checked against the vendor's. */
  readonly pricesCheckedAt: string;
  readonly metadata: PresetMetadata;
}

export interface PresetSetting {
  readonly key: string;
  readonly description: string;
}

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
  return input as ProviderPreset;
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
  const models =
    choices.models === undefined ? all : all.filter((m) => choices.models?.includes(m.name));
  const missing = (preset.adapterConfig ?? []).filter((s) => choices.settings[s.key] === undefined);
  if (missing.length > 0) {
    return {
      kind: 'err',
      message: `preset "${preset.name}" needs ${missing.map((s) => `--${s.key}=<…> (${s.description})`).join(', ')}`,
    };
  }
  const secret = choices.secret ?? preset.secret;
  const adapterConfig = Object.fromEntries(
    (preset.adapterConfig ?? []).map((s) => [s.key, choices.settings[s.key] as string]),
  );
  return {
    kind: 'ok',
    input: {
      metadata: { ...preset.metadata, models },
      adapter_id: preset.adapterId,
      ...(secret !== undefined && { secret_ref: { envName: choices.envName, name: secret } }),
      ...(Object.keys(adapterConfig).length > 0 && { adapter_config: adapterConfig }),
    },
  };
}
