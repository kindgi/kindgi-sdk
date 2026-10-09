// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a JVM pack's build leaves for the indexer and the pack service,
 * whichever tool built it (Maven, sbt): the classpath as an `@argfile`
 * (`java.args`), which they pass to `java`, so their commands stay the same
 * while the classpath changes; and the launcher (`kindgi-pack-java`),
 * extracted from the pack's own kindgi-pack jar, so it always matches the
 * service it starts.
 */

import { spawn } from 'node:child_process';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { delimiter } from 'node:path';

import { type JvmPackCode, javaArgsFile, javaLauncher } from './pack-code.js';

/** A classpath as a `java` `@argfile` line: quoted, with `\` and `"` escaped. */
export function argsFileText(classpath: readonly string[]): string {
  const quoted = classpath.join(delimiter).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `-cp "${quoted}"\n`;
}

/**
 * Writes the `@argfile` for `classpath` and, when the classpath changed or
 * the launcher is missing, extracts the launcher with it.
 *
 * @param missingKindgiPack what to say when kindgi-pack isn't on the
 *     classpath (where the pack's build declares its dependency)
 * @returns the build errors to show; empty when both are written
 */
export async function writeJvmRunFiles(opts: {
  readonly code: JvmPackCode;
  readonly packDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly classpath: readonly string[];
  readonly missingKindgiPack: string;
}): Promise<string[]> {
  const argsText = argsFileText(opts.classpath);
  const argsPath = javaArgsFile(opts.code);
  const changed = (await readFile(argsPath, 'utf8').catch(() => '')) !== argsText;
  if (changed) await writeAtomically(argsPath, argsText);
  const launcherPath = javaLauncher(opts.code);
  if (changed || !(await exists(launcherPath))) {
    const launcher = await runProcess(
      opts.code.java,
      [`@${argsPath}`, 'com.kindgi.pack.Main', 'launcher'],
      opts.env,
      opts.packDir,
    );
    if (launcher.code !== 0 || !launcher.stdout.startsWith('#!')) {
      const missing = /ClassNotFoundException|Could not find or load main class/.test(
        launcher.stderr,
      );
      return missing
        ? [opts.missingKindgiPack]
        : [`kindgi-pack's launcher could not be written: ${launcher.stderr.trim()}`];
    }
    await writeAtomically(launcherPath, launcher.stdout);
  }
  return [];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeAtomically(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/**
 * A child process, to its end: its exit code and output. With `timeoutMs`,
 * a child still running then is killed (`SIGTERM`) and its code is null.
 */
export function runProcess(
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
  timeoutMs?: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(program, [...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stderr += `\n(stopped after ${timeoutMs} ms)`;
            child.kill('SIGTERM');
          }, timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (cause) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: cause.message });
    });
    child.once('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}
