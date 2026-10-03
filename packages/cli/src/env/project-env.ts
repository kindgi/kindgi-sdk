// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * CLI side of the pack env files (`@kindgi/secrets-dotenv`'s
 * `readPackEnv`): which files a command reads for an environment, and
 * how their warnings are shown.
 *
 * Warnings name `file:line` and a reason — never the line's text. The
 * files are the project's own `.env`s and a malformed line can be a
 * secret with a typo in it.
 */

import type { EnvDiagnostic } from '@kindgi/dotenv-file';
import { displayEnvPath } from '@kindgi/secrets-dotenv';

import type { CommandContext } from '../context.js';
import { type PackConfigRecord, devEnvFiles, loadPackConfig } from '../pack-config.js';

export type LocalEnvSettings =
  | {
      readonly kind: 'ok';
      /** The loaded config, when there is a valid one. */
      readonly config: PackConfigRecord | undefined;
      /** `dev.envFiles`, when set. */
      readonly localEnvFiles: readonly string[] | undefined;
      /** Set when the config exists but could not be loaded. */
      readonly configProblem: string | undefined;
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Load the pack config and its `dev.envFiles`. A missing or unloadable
 * config yields the defaults (`configProblem` says why, for callers
 * that want to fail or warn); a present-but-malformed `dev.envFiles` is
 * always an error — the author asked for specific files.
 */
export async function loadLocalEnvSettings(
  ctx: Pick<CommandContext, 'buildConfigLoader'>,
  packDir: string,
): Promise<LocalEnvSettings> {
  const outcome = await loadPackConfig(ctx, packDir);
  if (outcome.kind !== 'ok') {
    return {
      kind: 'ok',
      config: undefined,
      localEnvFiles: undefined,
      configProblem: outcome.kind === 'invalid' ? outcome.message : undefined,
    };
  }
  const files = devEnvFiles(outcome.config);
  if (files.kind === 'invalid') return { kind: 'error', message: files.message };
  return {
    kind: 'ok',
    config: outcome.config,
    localEnvFiles: files.files,
    configProblem: undefined,
  };
}

/** One human-readable line per diagnostic, safe to print. */
export function describeEnvDiagnostics(
  packDir: string,
  diagnostics: readonly EnvDiagnostic[],
): string[] {
  return diagnostics.map((d) => {
    const file = displayEnvPath(packDir, d.source);
    switch (d.kind) {
      case 'malformed':
        return `${file}:${d.line}: ignored — ${d.reason}`;
      case 'unresolved':
        return `${file}: ${d.key} references \${${d.ref}}, which no env file (or the environment) defines — expanded to ""`;
      case 'cycle':
        return `${file}: ${d.key} references \${${d.ref}} in a cycle — the reference expanded to ""`;
    }
  });
}
