// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Injectable seams for `kindgi test`. The test-runner shellout
 * flows through this shape so tests inspect the invocation without
 * spawning real vitest.
 */

export interface RunTestsOptions {
  /** Absolute pack directory the runner spawns in. */
  readonly packDir: string;
  /** Which runner to invoke. v0.1 only `vitest` is supported. */
  readonly runner: 'vitest';
  /**
   * Arguments to append to the runner invocation. `--watch` /
   * `--reporter <name>` / any pass-through `-- ...` tokens land here.
   */
  readonly args: readonly string[];
  /** Env vars threaded to the child process. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Abort signal to forward to the child process. Watch-mode test
   * runs listen on this to exit gracefully.
   */
  readonly signal?: AbortSignal;
  /**
   * Optional log sink for the child's stdout/stderr. Production wiring
   * pipes directly to the current process; tests capture into an array.
   */
  readonly onLog?: (chunk: string) => void;
}

export interface RunTestsResult {
  /** Runner exit code — 0 on success, non-zero on failed tests. */
  readonly exitCode: number;
  /**
   * `true` if the runner binary was resolved + spawned. `false` when
   * the CLI probed for the local install and came back empty; the
   * caller surfaces the missing-binary hint in that path.
   */
  readonly spawned: boolean;
  /** When `spawned=false`, a machine-readable code explaining why. */
  readonly reason?: 'runner-binary-not-found' | 'runner-spawn-error';
  /** Runner binary path (or command name) resolved by the runner. */
  readonly resolvedBinary?: string;
}

export interface HasVitestConfigOptions {
  readonly packDir: string;
}

export interface TestRunners {
  /**
   * Check whether the pack ships a vitest config. `kindgi test`
   * refuses to spawn without one — a bare `vitest` invocation would
   * either sweep the whole repo (dev machines) or fail cryptically
   * (fresh clones).
   */
  readonly hasVitestConfig: (opts: HasVitestConfigOptions) => Promise<boolean>;
  /**
   * Spawn the runner. Blocks until the runner exits; forwards logs to
   * `opts.onLog` line-by-line.
   */
  readonly runTests: (opts: RunTestsOptions) => Promise<RunTestsResult>;
}
