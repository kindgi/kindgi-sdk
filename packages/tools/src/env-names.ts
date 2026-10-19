// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { compileInlineSchema } from '@kindgi/schema';
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

/**
 * Whether a schema says, in so many words, that it accepts `null`: `type`
 * is or includes `'null'`, `enum` lists it, `const` is it, or a branch of
 * `anyOf`/`oneOf` does. An unconstrained schema (`{}`) accepts null too,
 * but says nothing. The first half of the runtime's rule (`acceptsNull`).
 */
function namesNull(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const s = schema as Readonly<Record<string, unknown>>;
  if (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  if ('const' in s && s.const === null) return true;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.some(namesNull)) return true;
  }
  return false;
}

/**
 * The secrets a tool's code declares (`needsSpec.secrets`) that a call runs
 * without, by name: those whose schema says it accepts `null`, and does
 * (runtime 0.1.6 or later). One that was never stored is left out of
 * `ctx.secrets`; a revoked one still refuses the call. Sorted.
 */
export function toolOptionalSecretNames(manifest: Pick<ToolManifest, 'needsSpec'>): string[] {
  return Object.entries(manifest.needsSpec?.secrets ?? {})
    .filter(([, schema]) => acceptsNull(schema))
    .map(([name]) => name)
    .sort();
}

/**
 * The runtime's rule for an optional secret: its schema names `null`, and
 * `null` validates against it. A schema that doesn't compile is required.
 */
function acceptsNull(schema: JsonSchema): boolean {
  if (!namesNull(schema)) return false;
  const compiled = compileInlineSchema(schema);
  return compiled.kind === 'ok' && compiled.value.validate(null).kind === 'ok';
}
