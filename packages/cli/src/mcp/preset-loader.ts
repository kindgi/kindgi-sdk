// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Load `kindgi mcp` presets from JSON files on disk. Presets ship
 * inside the CLI package (`packages/cli/src/mcp/presets/`) and are
 * copied to `dist/mcp/presets/` by `copy-build-assets.mjs` so the
 * published tarball is self-contained.
 *
 * Test-friendly: `loadPresets(dir, reader)` accepts an explicit
 * directory + reader pair so tests can point at fixture dirs. The
 * default resolves to `<this-file's-dir>/presets/`.
 */

import { readFile as nodeReadFile, readdir as nodeReaddir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type ConnectionPreset,
  type LaunchedPreset,
  type Preset,
  type PresetSummary,
  isConnectionPreset,
} from './preset-types.js';

// Colocated with this loader — `src/mcp/presets/*.json` at source,
// `dist/mcp/presets/*.json` at built time.
const __dirname = dirname(fileURLToPath(import.meta.url));

export function defaultPresetsRoot(): string {
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

export type LoadPresetsResult =
  | { readonly kind: 'ok'; readonly presets: Readonly<Record<string, Preset>> }
  | { readonly kind: 'err'; readonly message: string };

/**
 * Read every `*.json` file in the presets directory, parse + validate
 * each, and key the resulting map by preset `kind`. Malformed files
 * accumulate into an error rather than being silently skipped — a
 * broken preset should fail loudly in dev so we catch schema drift
 * during authoring, not in production.
 */
export async function loadPresets(
  dir: string = defaultPresetsRoot(),
  io: PresetIO = DEFAULT_IO,
): Promise<LoadPresetsResult> {
  let entries: readonly string[];
  try {
    entries = await io.readdir(dir);
  } catch (err) {
    return { kind: 'err', message: `Failed to read presets dir ${dir}: ${(err as Error).message}` };
  }
  const jsonFiles = entries.filter((n) => n.endsWith('.json')).sort();
  const presets: Record<string, Preset> = {};
  const errors: string[] = [];
  for (const file of jsonFiles) {
    const path = join(dir, file);
    let raw: string;
    try {
      raw = await io.readFile(path);
    } catch (err) {
      errors.push(`${file}: read failed — ${(err as Error).message}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const validated = validatePreset(parsed);
    if (validated.kind === 'err') {
      errors.push(`${file}: ${validated.message}`);
      continue;
    }
    const preset = validated.preset;
    // Sanity-check the filename matches `kind` — catches renames that
    // leave the JSON out of sync.
    const expectedStem = file.replace(/\.json$/, '');
    if (preset.kind !== expectedStem) {
      errors.push(
        `${file}: preset kind "${preset.kind}" does not match filename stem "${expectedStem}"`,
      );
      continue;
    }
    if (presets[preset.kind] !== undefined) {
      errors.push(`${file}: duplicate preset kind "${preset.kind}"`);
      continue;
    }
    presets[preset.kind] = preset;
  }
  if (errors.length > 0) {
    return { kind: 'err', message: `Preset load errors:\n  ${errors.join('\n  ')}` };
  }
  return { kind: 'ok', presets };
}

/**
 * Convenience — `null` when the preset doesn't exist. Callers surface
 * the message with the available list.
 */
export function getPreset(presets: Readonly<Record<string, Preset>>, kind: string): Preset | null {
  return presets[kind] ?? null;
}

/** Summary rows for `kindgi mcp presets`. */
export function listPresetSummaries(
  presets: Readonly<Record<string, Preset>>,
): readonly PresetSummary[] {
  return Object.values(presets)
    .map<PresetSummary>((p) =>
      isConnectionPreset(p)
        ? {
            kind: p.kind,
            auth: p.auth,
            app: p.app,
            url: p.url,
            ...(p.description !== undefined && { description: p.description }),
          }
        : {
            kind: p.kind,
            runtime: p.runtime,
            package: p.package,
            ...(p.description !== undefined && { description: p.description }),
            audit: p.audit,
          },
    )
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------
// Validation — narrow JSON.parse's `unknown` to Preset
// ---------------------------------------------------------------------

type ValidateResult =
  | { readonly kind: 'ok'; readonly preset: Preset }
  | { readonly kind: 'err'; readonly message: string };

function validatePreset(input: unknown): ValidateResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { kind: 'err', message: 'preset must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== 'string' || kind === '') {
    return { kind: 'err', message: 'preset.kind must be a non-empty string' };
  }
  if (obj.auth !== undefined) return validateConnectionPreset(obj, kind);
  return validateLaunchedPreset(obj, kind);
}

/** The id of an app's entry in `@kindgi/connections`, as `defineApp` takes it. */
const APP_ID = /^[a-z][a-z0-9-]{1,31}$/;

function validateConnectionPreset(obj: Record<string, unknown>, kind: string): ValidateResult {
  if (obj.auth !== 'connection') {
    return {
      kind: 'err',
      message: `preset.auth = "${String(obj.auth)}" unsupported (only "connection" is recognized)`,
    };
  }
  for (const field of ['runtime', 'package', 'envMap', 'defaultArgs', 'hostRemap', 'audit']) {
    if (obj[field] !== undefined) {
      return {
        kind: 'err',
        message: `preset.${field} is for a preset the launcher runs; a "connection" preset has none`,
      };
    }
  }
  const app = obj.app;
  if (typeof app !== 'string' || !APP_ID.test(app)) {
    return { kind: 'err', message: "preset.app must be an app's entry id (`hubspot`)" };
  }
  const name = obj.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return { kind: 'err', message: 'preset.name must be a non-empty string' };
  }
  const url = obj.url;
  if (typeof url !== 'string' || !isHttpsUrl(url)) {
    return { kind: 'err', message: 'preset.url must be an https URL' };
  }
  const description = typeof obj.description === 'string' ? obj.description : undefined;
  const preset: ConnectionPreset = {
    kind,
    ...(description !== undefined && { description }),
    auth: 'connection',
    app,
    name,
    url,
  };
  return { kind: 'ok', preset };
}

function isHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function validateLaunchedPreset(obj: Record<string, unknown>, kind: string): ValidateResult {
  const runtime = obj.runtime;
  if (runtime !== 'npx' && runtime !== 'docker') {
    return { kind: 'err', message: 'preset.runtime must be "npx" or "docker"' };
  }
  const pkg = obj.package;
  if (typeof pkg !== 'string' || pkg === '') {
    return { kind: 'err', message: 'preset.package must be a non-empty string' };
  }
  const envMapRaw = obj.envMap;
  if (!Array.isArray(envMapRaw)) {
    return { kind: 'err', message: 'preset.envMap must be an array' };
  }
  const envMap: Array<LaunchedPreset['envMap'][number]> = [];
  for (const [i, entry] of envMapRaw.entries()) {
    if (entry === null || typeof entry !== 'object') {
      return { kind: 'err', message: `preset.envMap[${i}] must be an object` };
    }
    const e = entry as Record<string, unknown>;
    const child = e.child;
    const from = e.from;
    if (typeof child !== 'string' || child === '') {
      return { kind: 'err', message: `preset.envMap[${i}].child must be a non-empty string` };
    }
    if (typeof from !== 'string' || from === '') {
      return { kind: 'err', message: `preset.envMap[${i}].from must be a non-empty string` };
    }
    // Only `$SECRET` is supported today. Reject unknowns loudly so we
    // catch typos or future forms that haven't been implemented.
    if (from !== '$SECRET') {
      return {
        kind: 'err',
        message: `preset.envMap[${i}].from = "${from}" unsupported (only "$SECRET" is recognized)`,
      };
    }
    envMap.push({ child, from });
  }
  const defaultArgsRaw = obj.defaultArgs ?? [];
  if (!Array.isArray(defaultArgsRaw) || !defaultArgsRaw.every((a) => typeof a === 'string')) {
    return { kind: 'err', message: 'preset.defaultArgs must be an array of strings' };
  }
  const defaultArgs = defaultArgsRaw as readonly string[];
  const hostRemapRaw = obj.hostRemap;
  let hostRemap: LaunchedPreset['hostRemap'];
  if (hostRemapRaw !== undefined) {
    if (hostRemapRaw !== 'docker-desktop') {
      return {
        kind: 'err',
        message: `preset.hostRemap = "${String(hostRemapRaw)}" unsupported (only "docker-desktop" is recognized)`,
      };
    }
    hostRemap = 'docker-desktop';
  }
  const audit = obj.audit;
  const auditValidated = validateAudit(audit);
  if (auditValidated.kind === 'err') return auditValidated;

  const description = typeof obj.description === 'string' ? obj.description : undefined;

  const preset: LaunchedPreset = {
    kind,
    ...(description !== undefined && { description }),
    runtime,
    package: pkg,
    envMap,
    defaultArgs,
    ...(hostRemap !== undefined && { hostRemap }),
    audit: auditValidated.audit,
  };
  return { kind: 'ok', preset };
}

type ValidateAuditResult =
  | { readonly kind: 'ok'; readonly audit: LaunchedPreset['audit'] }
  | { readonly kind: 'err'; readonly message: string };

function validateAudit(input: unknown): ValidateAuditResult {
  if (input === null || typeof input !== 'object') {
    return { kind: 'err', message: 'preset.audit must be an object' };
  }
  const obj = input as Record<string, unknown>;
  const leak = obj.urlLeakInErrors;
  if (leak !== 'verified-safe' && leak !== 'pending' && leak !== 'known-issue') {
    return {
      kind: 'err',
      message:
        'preset.audit.urlLeakInErrors must be one of "verified-safe" | "pending" | "known-issue"',
    };
  }
  const reviewedAt = obj.reviewedAt;
  if (reviewedAt !== null && typeof reviewedAt !== 'string') {
    return { kind: 'err', message: 'preset.audit.reviewedAt must be null or a string' };
  }
  const version = obj.version;
  if (version !== null && typeof version !== 'string') {
    return { kind: 'err', message: 'preset.audit.version must be null or a string' };
  }
  const notes = obj.notes;
  if (notes !== undefined && typeof notes !== 'string') {
    return { kind: 'err', message: 'preset.audit.notes must be a string when present' };
  }
  return {
    kind: 'ok',
    audit: {
      urlLeakInErrors: leak,
      reviewedAt,
      version,
      ...(notes !== undefined && { notes }),
    },
  };
}
