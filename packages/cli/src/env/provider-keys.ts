// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The names model providers resolve their keys from in `local` (the
 * environment `kindgi dev` runs as). `kindgi dev` keeps them out of the
 * pack service's environment, whatever file holds them, and `kindgi
 * secrets copy` copies them from the app's env files into Kindgi's own.
 *
 * Three sources, unioned:
 *
 *   - the providers `kindgi.config` declares (`providers`): their
 *     `secret_ref`, known before the runtime starts;
 *   - the runtime's providers: `GET /v1/providers/:id/check` carries
 *     each one's `secretRef`, by name only (a runtime from 0.1.6 on);
 *   - a runtime provider whose check carries none (an older runtime) and
 *     whose id is a preset's: that preset's key name.
 *
 * `kindgi dev` records the last names it learned from the runtime in
 * `.kindgi/dev/provider-keys.json` (names only), so the pack service it
 * starts before the runtime answers already leaves them out.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCAL_ENV_NAME } from '@kindgi/secrets-dotenv';

import type { KindgiClient, Provider } from '@kindgi/client';

import type { DeclaredProvider } from '../dev/providers.js';
import type { ProviderPreset } from '../providers/preset-loader.js';

/** Every provider of the tenant, all pages. */
export async function listAllProviders(client: KindgiClient): Promise<readonly Provider[]> {
  const providers: Provider[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.providers.list({
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    providers.push(...page.data);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return providers;
}

/** The names the runtime's providers resolve their keys from in `local`, through `client`. */
export async function providerKeyNamesFromRuntime(
  client: KindgiClient,
  presets: Readonly<Record<string, ProviderPreset>>,
): Promise<Set<string>> {
  return runtimeProviderKeyNames({
    providers: await listAllProviders(client),
    check: (id) => client.providers.check(id),
    presets,
  });
}

/** A provider's key reference, by name. */
export interface ProviderKeyRef {
  readonly envName: string;
  readonly name: string;
}

/** The names the declared providers' keys resolve from in `local`. */
export function declaredProviderKeyNames(declared: readonly DeclaredProvider[]): Set<string> {
  const names = new Set<string>();
  for (const p of declared) {
    const ref = p.input.secret_ref;
    if (ref !== undefined && ref.envName === LOCAL_ENV_NAME) names.add(ref.name);
  }
  return names;
}

export interface RuntimeProviderKeyNamesInput {
  /** The tenant's providers (every page). */
  readonly providers: readonly { readonly id: string }[];
  /** `GET /v1/providers/:id/check`; a failure counts as "no `secretRef`". */
  readonly check: (providerId: string) => Promise<{ readonly secretRef?: ProviderKeyRef }>;
  /** The presets, by name: the fallback for a provider whose check carries no `secretRef`. */
  readonly presets: Readonly<Record<string, ProviderPreset>>;
}

/** The names the runtime's providers resolve their keys from in `local`. */
export async function runtimeProviderKeyNames(
  input: RuntimeProviderKeyNamesInput,
): Promise<Set<string>> {
  const presetKeyById = new Map<string, string>();
  for (const preset of Object.values(input.presets)) {
    if (preset.secret !== undefined) presetKeyById.set(preset.metadata.id, preset.secret);
  }
  const names = new Set<string>();
  await Promise.all(
    input.providers.map(async (p) => {
      let ref: ProviderKeyRef | undefined;
      try {
        ref = (await input.check(p.id)).secretRef;
      } catch {
        ref = undefined;
      }
      if (ref !== undefined) {
        if (ref.envName === LOCAL_ENV_NAME) names.add(ref.name);
        return;
      }
      const preset = presetKeyById.get(p.id);
      if (preset !== undefined) names.add(preset);
    }),
  );
  return names;
}

/** Where `kindgi dev` records the names it learned from the runtime. */
export function providerKeysRecordPath(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'provider-keys.json');
}

/** The recorded names; empty when there's no record (or it can't be read). */
export async function readProviderKeysRecord(packDir: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(providerKeysRecordPath(packDir), 'utf8'));
    const names = (parsed as { names?: unknown }).names;
    return new Set(Array.isArray(names) ? names.filter((n) => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Record the names (sorted, names only); best effort. */
export async function writeProviderKeysRecord(
  packDir: string,
  names: ReadonlySet<string>,
): Promise<void> {
  try {
    await writeFile(
      providerKeysRecordPath(packDir),
      `${JSON.stringify({ names: [...names].sort() }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // The record only saves the next boot a pack service restart.
  }
}
