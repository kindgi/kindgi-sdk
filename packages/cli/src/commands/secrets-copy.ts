// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi secrets copy [NAME…]` — give Kindgi its own copy, in
 * `.kindgi/secrets.env`, of keys that sit in the app's env files.
 *
 * Without names, the keys the runtime's model providers use (and the ones
 * `kindgi.config` declares), as far as they're in the app's env files.
 * It never edits or deletes anything in the app's files: whether a key
 * stays there is the person's call, since the app may use it itself.
 * Output names keys and files, never a value.
 */

import { execFile } from 'node:child_process';

import {
  type CopyToKindgiFileResult,
  LOCAL_ENV_NAME,
  copyToKindgiFile,
  displayEnvPath,
  namesInAppFiles,
  resolvePackEnvFiles,
} from '@kindgi/secrets-dotenv';

import type { CommandContext } from '../context.js';
import { declaredProviders } from '../dev/providers.js';
import { loadLocalEnvSettings } from '../env/project-env.js';
import {
  declaredProviderKeyNames,
  providerKeyNamesFromRuntime,
  readProviderKeysRecord,
} from '../env/provider-keys.js';
import { renderJson } from '../output.js';
import { loadProviderPresets } from '../providers/preset-loader.js';
import type { CommandResult, LeafCommand } from './types.js';

/** Whether git tracks `file` (`git ls-files --error-unmatch`); `false` outside a repository or without git. */
const gitTracked = (file: string, cwd: string): Promise<boolean> =>
  new Promise((resolvePromise) => {
    execFile('git', ['ls-files', '--error-unmatch', '--', file], { cwd, timeout: 5000 }, (err) =>
      resolvePromise(err === null),
    );
  });

export const secretsCopyCmd: LeafCommand = {
  kind: 'leaf',
  name: 'copy',
  description:
    "Copy model providers' keys (or the NAMEs given) from your app's env files into Kindgi's own .kindgi/secrets.env, which Kindgi reads first. Never edits your app's files.",
  usage: 'kindgi secrets copy [NAME…]',
  optionSpec: {},
  run: async (ctx): Promise<CommandResult> => {
    const packDir = ctx.cwd;
    const settings = await loadLocalEnvSettings(ctx, packDir);
    if (settings.kind === 'error') {
      return { kind: 'error', stderr: `kindgi secrets copy: ${settings.message}\n`, exitCode: 1 };
    }
    const localEnvFiles = settings.localEnvFiles;
    const files = resolvePackEnvFiles({
      packDir,
      envName: LOCAL_ENV_NAME,
      ...(localEnvFiles !== undefined && { localEnvFiles }),
    });
    const shown = (f: string): string => displayEnvPath(packDir, f);
    const appFilesLabel = files.app.map(shown).join(', ');

    let names = [...ctx.positionals];
    const notes: string[] = [];
    if (names.length === 0) {
      const found = await providerKeyNames(ctx, packDir, settings.config);
      if (found.note !== undefined) notes.push(found.note);
      const held = await namesInAppFiles({
        packDir,
        ...(localEnvFiles !== undefined && { localEnvFiles }),
        names: [...found.names].sort(),
      });
      names = held.map((h) => h.name);
      if (names.length === 0) {
        return {
          kind: 'ok',
          rendered: {
            stdout: renderJson({ kindgiFile: shown(files.write), names: [] }, ctx.globals.format)
              .stdout,
            stderr: `${notes.map((n) => `\n  ${n}`).join('')}\n  No model provider's key is in your app's env files (${appFilesLabel}): nothing to copy.\n\n`,
          },
        };
      }
    }

    let result: CopyToKindgiFileResult;
    try {
      result = await copyToKindgiFile({
        packDir,
        ...(localEnvFiles !== undefined && { localEnvFiles }),
        names,
      });
    } catch (err) {
      return {
        kind: 'error',
        stderr: `kindgi secrets copy: couldn't read or write ${shown(files.write)}: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }

    const tracked = new Map<string, boolean>();
    for (const n of result.names) {
      for (const f of n.appFiles) {
        if (!tracked.has(f)) tracked.set(f, await gitTracked(f, packDir));
      }
    }
    const kindgiFile = shown(result.kindgiFile);
    const lines: string[] = [...notes.map((n) => `  ${n}`)];
    for (const s of result.skipped) {
      lines.push(`  ! Couldn't read ${shown(s.file)} (${s.reason}): skipped.`);
    }
    for (const n of result.names) {
      const where = n.appFiles.map(shown).join(' and ');
      if (n.appFiles.length === 0) {
        lines.push(
          `  · ${n.name} isn't in your app's env files (${appFilesLabel}): nothing to copy.`,
        );
        continue;
      }
      if (n.copied) {
        lines.push(`  ✓ Copied ${n.name} from ${where} to ${kindgiFile}.`);
      } else if (n.alreadyInKindgiFile === 'different') {
        lines.push(
          `  · ${n.name}: Kindgi has its own key in ${kindgiFile} and uses it first; your app keeps the one in ${where}.`,
        );
      } else {
        lines.push(`  · ${n.name} is already in ${kindgiFile}.`);
      }
      if (n.alreadyInKindgiFile !== 'different') {
        lines.push(
          `    It's still in ${where}: removing it is your call, since it's your app's file.`,
          `    If your app uses ${n.name} itself, keep it there. You can give Kindgi its own key in ${kindgiFile}, which Kindgi uses first.`,
        );
      }
      for (const f of n.appFiles) {
        if (tracked.get(f) === true) {
          lines.push(
            `    ⚠ ${shown(f)} is tracked by git, so ${n.name} is in your repository's history: rotate it with its provider.`,
          );
        }
      }
    }

    const summary = {
      kindgiFile,
      names: result.names.map((n) => ({
        name: n.name,
        appFiles: n.appFiles.map(shown),
        copied: n.copied,
        ...(n.alreadyInKindgiFile !== undefined && { alreadyInKindgiFile: n.alreadyInKindgiFile }),
        trackedByGit: n.appFiles.filter((f) => tracked.get(f) === true).map(shown),
      })),
      ...(result.skipped.length > 0 && {
        skipped: result.skipped.map((s) => ({ file: shown(s.file), reason: s.reason })),
      }),
    };
    return {
      kind: 'ok',
      rendered: {
        stdout: renderJson(summary, ctx.globals.format).stdout,
        stderr: `\n${lines.join('\n')}\n\n`,
      },
    };
  },
};

/**
 * The names the model providers' keys resolve from: the ones
 * `kindgi.config` declares, and the runtime's (or, when it can't be
 * reached, the ones `kindgi dev` last saw).
 */
async function providerKeyNames(
  ctx: CommandContext,
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
): Promise<{ readonly names: ReadonlySet<string>; readonly note?: string }> {
  const presets = await loadProviderPresets();
  const declared = declaredProviders(config, 'kindgi.config', presets);
  const names = declaredProviderKeyNames(declared.kind === 'ok' ? declared.providers : []);
  try {
    for (const n of await providerKeyNamesFromRuntime(ctx.client(), presets)) names.add(n);
    return { names };
  } catch {
    const recorded = await readProviderKeysRecord(packDir);
    for (const n of recorded) names.add(n);
    return {
      names,
      note: `Couldn't reach Kindgi's runtime to ask which keys its providers use: ${recorded.size > 0 ? 'used the ones `kindgi dev` last saw' : 'start `kindgi dev`, or name the keys (`kindgi secrets copy ANTHROPIC_API_KEY`)'}.`,
    };
  }
}
