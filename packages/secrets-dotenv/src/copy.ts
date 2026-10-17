// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi secrets copy`: gives Kindgi its own copy, in `.kindgi/secrets.env`,
 * of keys that sit in the app's env files.
 *
 * It never edits or deletes anything in the app's files: they're the
 * person's, and the app may use a key itself (a provider's SDK reads
 * `ANTHROPIC_API_KEY` from the environment with no mention of it in the
 * app's code). Whether a key stays there is the person's call.
 *
 *   - A name not in Kindgi's file is written there with the app's value
 *     (its highest-precedence one). Merge only: every other line of
 *     Kindgi's file stays, and it's written 0600.
 *   - A name Kindgi's file already holds keeps that value. With a
 *     different one, the app and Kindgi each have their own key (Kindgi
 *     reads its own file first).
 *   - An app file that can't be read is skipped and named.
 *
 * A key is copied as its line is written (`KEY=${OTHER}` stays a reference,
 * resolved over the same files as before), never expanded into a value.
 * The outcome carries names and files only, never a value.
 */

import { type EnvLine, envLinesToRecord, parseEnvFile } from '@kindgi/dotenv-file';

import { LOCAL_ENV_NAME, readFileOrNull, resolvePackEnvFiles } from './pack-env.js';
import { SECRETS_FILE_MODE, writeAtomic } from './write-file.js';

export interface CopyToKindgiFileInput {
  /** Pack root — the directory holding `kindgi.config.ts`. */
  readonly packDir: string;
  /** `dev.envFiles`; default `.env`, `.env.local`. */
  readonly localEnvFiles?: readonly string[];
  /** The names to give Kindgi its own copy of. */
  readonly names: readonly string[];
}

export interface CopiedName {
  readonly name: string;
  /** The app's files that hold it (absolute, lowest precedence first); empty when none does. */
  readonly appFiles: readonly string[];
  /** Copied into Kindgi's file now. */
  readonly copied: boolean;
  /** Kindgi's file already held it: `same` value as the app's, or `different` (its own key). */
  readonly alreadyInKindgiFile?: 'same' | 'different';
}

export interface CopyToKindgiFileResult {
  /** Kindgi's file (absolute). */
  readonly kindgiFile: string;
  readonly names: readonly CopiedName[];
  /** App files that couldn't be read (skipped), with the reason. */
  readonly skipped: readonly { readonly file: string; readonly reason: string }[];
}

export async function copyToKindgiFile(
  input: CopyToKindgiFileInput,
): Promise<CopyToKindgiFileResult> {
  const files = resolvePackEnvFiles({
    packDir: input.packDir,
    envName: LOCAL_ENV_NAME,
    ...(input.localEnvFiles !== undefined && { localEnvFiles: input.localEnvFiles }),
  });
  const kindgiFile = files.write;

  const apps: {
    readonly file: string;
    readonly lines: readonly EnvLine[];
    readonly entries: Readonly<Record<string, string>>;
  }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const file of files.app) {
    try {
      const contents = await readFileOrNull(file);
      if (contents === null) continue;
      const lines = parseEnvFile(contents);
      apps.push({ file, lines, entries: envLinesToRecord(lines) });
    } catch (err) {
      skipped.push({ file, reason: reasonOf(err) });
    }
  }
  // Kindgi's own file must be readable: a copy that can't see it could
  // overwrite a value there.
  let kindgiContents = (await readFileOrNull(kindgiFile)) ?? '';
  const kindgiEntries = envLinesToRecord(parseEnvFile(kindgiContents));

  const names: CopiedName[] = [];
  for (const name of input.names) {
    const holding = apps.filter((a) => Object.hasOwn(a.entries, name));
    const appValue = holding[holding.length - 1]?.entries[name];
    const appFiles = holding.map((a) => a.file);
    if (appValue === undefined) {
      names.push({ name, appFiles, copied: false });
    } else if (Object.hasOwn(kindgiEntries, name)) {
      const already = kindgiEntries[name] === appValue ? 'same' : 'different';
      names.push({ name, appFiles, copied: false, alreadyInKindgiFile: already });
    } else {
      // The line exactly as the app's file has it (the last one, as dotenv reads).
      const from = holding[holding.length - 1];
      const line = from?.lines.filter((l) => l.kind === 'entry' && l.key === name).at(-1);
      kindgiContents = appendLine(kindgiContents, line?.raw ?? `${name}=${appValue}`);
      names.push({ name, appFiles, copied: true });
    }
  }
  if (names.some((n) => n.copied)) {
    await writeAtomic(kindgiFile, kindgiContents, SECRETS_FILE_MODE);
  }
  return { kindgiFile, names, skipped };
}

/**
 * The names among `names` that the app's own env files hold (each file read
 * on its own, so a name Kindgi's file shadows is still found), and whether
 * Kindgi's file holds them too.
 */
export async function namesInAppFiles(input: CopyToKindgiFileInput): Promise<
  readonly {
    readonly name: string;
    readonly files: readonly string[];
    readonly inKindgiFile: boolean;
  }[]
> {
  const files = resolvePackEnvFiles({
    packDir: input.packDir,
    envName: LOCAL_ENV_NAME,
    ...(input.localEnvFiles !== undefined && { localEnvFiles: input.localEnvFiles }),
  });
  const entriesOf = async (file: string): Promise<Readonly<Record<string, string>>> => {
    try {
      const contents = await readFileOrNull(file);
      return contents === null ? {} : envLinesToRecord(parseEnvFile(contents));
    } catch {
      return {}; // `kindgi dev` and doctor say which files they couldn't read.
    }
  };
  const kindgi = files.kindgi === undefined ? {} : await entriesOf(files.kindgi);
  const held = new Map<string, string[]>();
  for (const file of files.app) {
    const entries = await entriesOf(file);
    for (const name of input.names) {
      if (Object.hasOwn(entries, name)) held.set(name, [...(held.get(name) ?? []), file]);
    }
  }
  return input.names.flatMap((name) => {
    const at = held.get(name);
    return at === undefined ? [] : [{ name, files: at, inKindgiFile: Object.hasOwn(kindgi, name) }];
  });
}

/** `contents` with `raw` as its last line. */
function appendLine(contents: string, raw: string): string {
  const head = contents === '' || contents.endsWith('\n') ? contents : `${contents}\n`;
  return `${head}${raw}\n`;
}

function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission denied' : (err as Error).message;
}
