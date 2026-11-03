// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Production wiring for `kindgi test`. Uses `pnpm exec vitest` when
 * the pack root has a `pnpm-workspace.yaml` or `pnpm-lock.yaml` above
 * it, otherwise falls back to `npx --no-install vitest`. Either way,
 * the runner used is the pack's OWN installed vitest — the CLI never
 * forces a version through.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { programPath } from '../program-path.js';
import {
  type RunTestsOptions,
  type RunTestsResult,
  type TestRunners,
  VITEST_CONFIG_FILENAMES,
} from './runners.js';

export const REAL_TEST_RUNNERS: TestRunners = {
  hasVitestConfig: async ({ packDir }) => {
    for (const name of VITEST_CONFIG_FILENAMES) {
      const abs = join(packDir, name);
      try {
        const s = await stat(abs);
        if (s.isFile()) return true;
      } catch {
        // try next
      }
    }
    return false;
  },
  runTests: async (opts): Promise<RunTestsResult> => spawnRunner(opts),
};

async function spawnRunner(opts: RunTestsOptions): Promise<RunTestsResult> {
  // Prefer `pnpm exec` when a lockfile shape suggests pnpm; else npx.
  const usePnpm = await hasFile(opts.packDir, ['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
  const binary = usePnpm ? 'pnpm' : 'npx';
  const args = usePnpm
    ? ['exec', 'vitest', ...opts.args]
    : ['--no-install', 'vitest', ...opts.args];
  const env = { ...process.env, ...opts.env } as NodeJS.ProcessEnv;
  // The runner on PATH, never one in the pack's folder. Its miss reads as
  // the spawn's own error below would.
  let file: string;
  try {
    file = await programPath(binary, env);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      spawned: false,
      exitCode: 1,
      reason: code === 'ENOENT' ? 'runner-binary-not-found' : 'runner-spawn-error',
      resolvedBinary: binary,
    };
  }

  return new Promise<RunTestsResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.packDir,
        env,
        stdio: ['inherit', 'pipe', 'pipe'],
        ...(opts.signal !== undefined && { signal: opts.signal }),
      });
    } catch (err) {
      resolvePromise({
        spawned: false,
        exitCode: 1,
        reason: 'runner-spawn-error',
        resolvedBinary: binary,
      });
      // Note the closure — err isn't surfaced structurally here; the
      // command's stderr hint is generic. If we ever need typed spawn
      // errors, extend RunTestsResult with an `errorMessage` field.
      void err;
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      opts.onLog?.(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      opts.onLog?.(chunk.toString('utf8'));
    });
    child.on('error', (err) => {
      // ENOENT surfaces here (binary not found on PATH).
      const code = (err as NodeJS.ErrnoException).code;
      resolvePromise({
        spawned: false,
        exitCode: 1,
        reason: code === 'ENOENT' ? 'runner-binary-not-found' : 'runner-spawn-error',
        resolvedBinary: binary,
      });
    });
    child.on('close', (code) => {
      resolvePromise({
        spawned: true,
        exitCode: code ?? 1,
        resolvedBinary: binary,
      });
    });
  });
}

async function hasFile(dir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) return true;
    } catch {
      // try next
    }
  }
  return false;
}
