// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Layered env files — several dotenv files read as one view, the way
 * an application reads `.env` + `.env.local`.
 *
 * Layers are ordered LOWEST precedence first: a key in a later layer
 * overrides the same key in an earlier one. Raw values are merged
 * first, then expanded once over the merged view, so a reference in
 * `.env` to a name defined in `.env.local` sees the `.env.local` value
 * (matching how Next.js loads its files). Pure — the caller reads the
 * files and passes their contents (`null` for a file that doesn't
 * exist), so this module never touches the filesystem.
 */

import { type ExpandDiagnostic, type ExpandOptions, expandEnv } from './expand.js';
import { parseEnvFile } from './parse.js';

export interface EnvLayer {
  /** Where the contents came from (a path, usually). Reported back in `origin`. */
  readonly source: string;
  /** File contents, or `null` when the file does not exist. */
  readonly contents: string | null;
}

export type EnvDiagnostic =
  | (ExpandDiagnostic & { readonly source: string })
  | {
      readonly kind: 'malformed';
      readonly source: string;
      /** 1-based line number in `source`. */
      readonly line: number;
      /** The line's text. May hold a secret — show `source:line` to users, not this. */
      readonly raw: string;
      readonly reason: string;
    };

export interface LayeredEnv {
  /** Merged, expanded values. */
  readonly values: Readonly<Record<string, string>>;
  /** Merged values as written (before expansion). */
  readonly raw: Readonly<Record<string, string>>;
  /** For each key, the `source` of the layer that supplied it. */
  readonly origin: Readonly<Record<string, string>>;
  /** Sources that exist (non-`null` contents), in layer order. */
  readonly present: readonly string[];
  /** Malformed lines (ignored, as dotenv does), unresolved references, cycles. */
  readonly diagnostics: readonly EnvDiagnostic[];
}

export function readEnvLayers(
  layers: readonly EnvLayer[],
  options: ExpandOptions = {},
): LayeredEnv {
  const raw: Record<string, string> = {};
  const origin: Record<string, string> = {};
  const present: string[] = [];
  const diagnostics: EnvDiagnostic[] = [];

  for (const layer of layers) {
    if (layer.contents === null) continue;
    present.push(layer.source);
    let lineNo = 1;
    for (const line of parseEnvFile(layer.contents)) {
      if (line.kind === 'entry' && line.key !== undefined && line.value !== undefined) {
        raw[line.key] = line.value;
        origin[line.key] = layer.source;
      } else if (line.kind === 'malformed') {
        diagnostics.push({
          kind: 'malformed',
          source: layer.source,
          line: lineNo,
          raw: line.raw,
          reason: line.reason ?? 'not a `KEY=value` line',
        });
      }
      lineNo += line.raw.split('\n').length;
    }
  }

  const expanded = expandEnv(raw, options);
  for (const d of expanded.diagnostics) {
    diagnostics.push({ ...d, source: origin[d.key] ?? '' });
  }
  return { values: expanded.values, raw, origin, present, diagnostics };
}

/** One file's values, parsed and expanded. */
export function readEnv(contents: string, options: ExpandOptions = {}): Record<string, string> {
  return { ...readEnvLayers([{ source: '', contents }], options).values };
}
