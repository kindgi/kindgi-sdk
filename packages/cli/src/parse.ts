// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { parseArgs } from 'node:util';

import type { OutputFormat } from './output.js';

/**
 * Global flags recognised on every command. Kept small on purpose —
 * per-command flags are declared in each command's handler and merged
 * on parse.
 */
export const GLOBAL_OPTION_SPEC = {
  url: { type: 'string' as const },
  token: { type: 'string' as const },
  verbose: { type: 'boolean' as const, short: 'v' as const },
  help: { type: 'boolean' as const, short: 'h' as const },
  version: { type: 'boolean' as const },
  json: { type: 'boolean' as const },
  table: { type: 'boolean' as const },
  raw: { type: 'boolean' as const },
  quiet: { type: 'boolean' as const },
} as const;

export interface GlobalFlags {
  readonly url?: string;
  readonly token?: string;
  readonly verbose: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly format: OutputFormat;
}

export interface CommandParse {
  readonly globals: GlobalFlags;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
}

/**
 * Parse a token vector against a merged option spec (globals + the
 * command's own options). `parseArgs` is used with `allowPositionals:
 * true` and `strict: true`; unknown flags fail loudly.
 */
export function parseCommand(
  tokens: readonly string[],
  extraOptionSpec: Readonly<Record<string, ParseArgsOption>> = {},
): CommandParse {
  const merged: Record<string, ParseArgsOption> = { ...GLOBAL_OPTION_SPEC, ...extraOptionSpec };
  // `parseArgs` has no optional values: a bare `--name` of such an option
  // (last, or before another flag) becomes `--name=`.
  const optional = new Set(
    Object.entries(merged)
      .filter(([, spec]) => spec.type === 'string' && spec.optionalValue === true)
      .map(([name]) => `--${name}`),
  );
  const args = tokens.map((token, i) => {
    const next = tokens[i + 1];
    return optional.has(token) && (next === undefined || next.startsWith('-'))
      ? `${token}=`
      : token;
  });
  const options = Object.fromEntries(
    Object.entries(merged).map(([name, spec]) => {
      if (spec.type !== 'string') return [name, spec];
      const { optionalValue: _optional, ...rest } = spec;
      return [name, rest];
    }),
  );
  const parsed = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: true,
  });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals ?? [];

  const format = pickFormat(
    values.json === true,
    values.table === true,
    values.raw === true,
    values.quiet === true,
  );
  const globals: GlobalFlags = {
    verbose: values.verbose === true,
    help: values.help === true,
    version: values.version === true,
    format,
    ...(typeof values.url === 'string' ? { url: values.url } : {}),
    ...(typeof values.token === 'string' ? { token: values.token } : {}),
  };
  // Strip global keys from options so command handlers see only their own.
  const own: Record<string, string | boolean | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key in GLOBAL_OPTION_SPEC) continue;
    own[key] = value;
  }
  return { globals, positionals, options: own };
}

type ParseArgsOption =
  | {
      type: 'string';
      multiple?: boolean;
      short?: string;
      default?: string;
      /** See `commands/types.ts`. */
      optionalValue?: boolean;
    }
  | { type: 'boolean'; multiple?: boolean; short?: string; default?: boolean };

function pickFormat(json: boolean, table: boolean, raw: boolean, quiet: boolean): OutputFormat {
  if (quiet) return 'quiet';
  if (raw) return 'raw';
  if (table) return 'table';
  // Default pretty JSON (also selected explicitly by --json).
  if (json) return 'json';
  return 'json';
}
