// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type KindgiClient, createClient } from '@kindgi/client';

import type { BuildRunners } from './build/runners.js';
import type { EnvInitInputSeam } from './commands/env.js';
import type { SecretsValueInputSeam } from './commands/secrets.js';
import type { ResolvedConfig } from './config.js';
import type { DeployRunners } from './deploy/runners.js';
import type { DevRunners } from './dev/runners.js';
import type { EnvRunners } from './env/runners.js';
import type { KeyRunners } from './key/runners.js';
import type { GlobalFlags } from './parse.js';
import type { TestRunners } from './test/runners.js';

/**
 * Loader hook the `kindgi build` command consumes when reading
 * `kindgi.config.ts`. Production leaves this undefined; the command
 * falls back to a plain dynamic `import()` (Node 22
 * `--experimental-strip-types` handles the `.ts` variant natively).
 * Tests inject an in-memory function to bypass the filesystem.
 */
export type BuildConfigLoader = (packDir: string) => Promise<unknown>;

/**
 * Runtime context passed to every command handler. Holds the resolved
 * config, the SDK client (lazily created), and the effective output
 * format.
 */
export interface CommandContext {
  readonly globals: GlobalFlags;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
  readonly config: ResolvedConfig;
  /** Create an SDK client using the resolved config. Throws if apiUrl / token are missing. */
  readonly client: () => KindgiClient;
  /** Create an SDK client bound to arbitrary apiUrl + token (used by `kindgi dev`). */
  readonly clientFor: (apiUrl: string, token: string) => KindgiClient;
  /** Base URL, if resolved — used by non-SDK direct fetch (health, whoami). */
  readonly apiUrl: () => string;
  /** Bearer token, if resolved — used by non-SDK direct fetch. */
  readonly token: () => string;
  /** fetch impl (injectable for tests). */
  readonly fetch: typeof fetch;
  /** Home directory used by `auth login` when persisting `~/.kindgi/config.json`. */
  readonly home: string | undefined;
  /** Working directory (injectable for tests; defaults to process.cwd()). */
  readonly cwd: string;
  /**
   * Environment variables the CLI was booted with. Populated verbatim
   * from `runCli({ env })`; production callers pass `process.env`.
   * Consumed by commands (e.g. `kindgi dev`'s `KINDGI_DATABASE_URL`
   * fallback) so tests can drive the resolution deterministically.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Injectable dev-mode runners (api-server factory + indexer + watcher).
   * Present iff the CLI was booted via `runCli({ devRunners })` — used
   * exclusively by `kindgi dev` so tests can hand in mock server /
   * indexer / watcher without touching Postgres or the filesystem.
   * Production callers leave this undefined; `kindgi dev` then wires
   * the real runtime container / `runIndexer` / `fs.watch` from
   * `dev/defaults.ts`.
   */
  readonly devRunners: DevRunners | undefined;
  /**
   * Optional signal that terminates long-lived commands (currently just
   * `kindgi dev` — the watch loop). Tests pass an
   * `AbortController.signal` so a graceful shutdown path can be
   * exercised without process signals. Production callers wire this to
   * SIGINT/SIGTERM in `main.ts`.
   */
  readonly stopSignal: AbortSignal | undefined;
  /**
   * Injectable build-pipeline seams used exclusively by `kindgi
   * build`. Absent for every other command. Tests hand
   * in fixture implementations so the pipeline exercises without
   * spawning real esbuild, real tar, real fetch, or docker; production
   * lazy-loads `build/defaults.ts` on dispatch.
   */
  readonly buildRunners: BuildRunners | undefined;
  /**
   * Optional loader hook for `kindgi.config.ts`. Tests inject an
   * in-memory function; production leaves this undefined and the
   * command falls back to a plain dynamic `import()`.
   */
  readonly buildConfigLoader:
    | ((packDir: string) => Promise<{ readonly [k: string]: unknown }>)
    | undefined;
  /**
   * Injectable deploy-pipeline seams used exclusively by `kindgi
   * deploy`. Absent for every other command. Tests hand
   * in fixture implementations so the pipeline exercises without
   * reading a real envelope file or hitting a live api-server;
   * production lazy-loads `deploy/defaults.ts` on dispatch.
   */
  readonly deployRunners: DeployRunners | undefined;
  /**
   * Injectable seams for `kindgi test`. Absent for
   * every other command. Tests hand in fixture implementations so the
   * command flow exercises without spawning real vitest; production
   * lazy-loads `test/defaults.ts` on dispatch.
   */
  readonly testRunners: TestRunners | undefined;
  /**
   * Injectable filesystem seams for `kindgi env`.
   * Absent for every other command. Tests substitute in-memory stubs
   * so `.env.<envName>` reads/writes never touch disk; production
   * lazy-loads `env/defaults.ts` on dispatch.
   */
  readonly envRunners: EnvRunners | undefined;
  /**
   * Injectable seams for `kindgi key`. Absent for
   * every other command. Tests substitute stubs so the crypto +
   * filesystem paths under `~/.kindgi/keys/` never touch disk; production
   * lazy-loads `key/defaults.ts` on dispatch.
   */
  readonly keyRunners: KeyRunners | undefined;
  /**
   * Injectable value-input seams for `kindgi secrets set` /
   * `rotate`. Tests pass fixtures so the TTY prompt / stdin reader /
   * file reader / fs.stat mode check exercise without a real terminal
   * or disk. Production leaves this undefined; the command falls back
   * to real `readline` / `process.stdin` / `node:fs`.
   */
  readonly secretsInputSeam: SecretsValueInputSeam | undefined;
  /**
   * Injectable prompt / TTY-check seam for `kindgi env init`. Tests
   * inject a fixture `promptChoice`; production leaves undefined and
   * `env init` spins up a real `readline.Interface`.
   */
  readonly envInitInputSeam: EnvInitInputSeam | undefined;
}

export interface BuildContextInputs {
  readonly globals: GlobalFlags;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
  readonly config: ResolvedConfig;
  readonly fetchImpl?: typeof fetch;
  readonly clientFactory?: (apiUrl: string, token: string) => KindgiClient;
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly devRunners?: DevRunners;
  readonly stopSignal?: AbortSignal;
  readonly buildRunners?: BuildRunners;
  readonly buildConfigLoader?: (packDir: string) => Promise<{ readonly [k: string]: unknown }>;
  readonly deployRunners?: DeployRunners;
  readonly testRunners?: TestRunners;
  readonly envRunners?: EnvRunners;
  readonly keyRunners?: KeyRunners;
  readonly secretsInputSeam?: SecretsValueInputSeam;
  readonly envInitInputSeam?: EnvInitInputSeam;
}

export function buildContext(inputs: BuildContextInputs): CommandContext {
  const apiUrl = (): string => {
    if (inputs.config.apiUrl === undefined) {
      throw new Error(
        'API URL not configured. Set KINDGI_API_URL, pass --url=..., or run `kindgi auth login`.',
      );
    }
    return inputs.config.apiUrl;
  };
  const token = (): string => {
    if (inputs.config.token === undefined) {
      throw new Error(
        'API token not configured. Set KINDGI_API_TOKEN, pass --token=..., or run `kindgi auth login`.',
      );
    }
    return inputs.config.token;
  };
  const factory =
    inputs.clientFactory ??
    ((url: string, tok: string) =>
      createClient({ apiUrl: url, auth: { kind: 'apiToken', token: tok } }));
  return {
    globals: inputs.globals,
    positionals: inputs.positionals,
    options: inputs.options,
    config: inputs.config,
    client: () => factory(apiUrl(), token()),
    clientFor: (url, tok) => factory(url, tok),
    apiUrl,
    token,
    fetch: inputs.fetchImpl ?? fetch,
    home: inputs.home,
    cwd: inputs.cwd ?? process.cwd(),
    env: inputs.env ?? {},
    devRunners: inputs.devRunners,
    stopSignal: inputs.stopSignal,
    buildRunners: inputs.buildRunners,
    buildConfigLoader: inputs.buildConfigLoader,
    deployRunners: inputs.deployRunners,
    testRunners: inputs.testRunners,
    envRunners: inputs.envRunners,
    keyRunners: inputs.keyRunners,
    secretsInputSeam: inputs.secretsInputSeam,
    envInitInputSeam: inputs.envInitInputSeam,
  };
}
