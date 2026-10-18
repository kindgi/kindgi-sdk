// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { JsonSchema, ToolManifest } from './types.js';

/** A declared env value's `default`, when it's a string (env values are strings; `defineTool` checks it). */
export function envDefaultOf(schema: JsonSchema): string | undefined {
  const fallback = (schema as { readonly default?: unknown }).default;
  return typeof fallback === 'string' ? fallback : undefined;
}

/**
 * The env values a tool can't run without, by name: the ones its code
 * declares (`needsSpec.env`) with no `default`. A name no scope sets takes
 * its default, so only these must be set somewhere. Sorted.
 */
export function toolRequiredEnvNames(manifest: Pick<ToolManifest, 'needsSpec'>): string[] {
  return Object.entries(manifest.needsSpec?.env ?? {})
    .filter(([, schema]) => envDefaultOf(schema) === undefined)
    .map(([name]) => name)
    .sort();
}
