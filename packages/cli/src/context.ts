// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type KindgiClient, createClient } from '@kindgi/client';

import { ownAddressKeyRefusal } from './api-address.js';
import type { BuildRunners } from './build/runners.js';
import type { RegistryAuthSeam } from './commands/auth.js';
import type { ConnectionsSeam } from './commands/connections.js';
import type { DoctorSeam } from './commands/doctor.js';
import type { EnvInitInputSeam } from './commands/env.js';
import type { SecretsValueInputSeam } from './commands/secrets.js';
import type { ResolvedConfig } from './config.js';
import type { DeployRunners } from './deploy/runners.js';
import type { DevRunners } from './dev/runners.js';
import type { EnvRunners } from './env/runners.js';
import type { ExportsSeam } from './exports/create.js';
import type { FeedbackSeam } from './feedback/run.js';
import type { KeyRunners } from './key/runners.js';
import type { LicenseCommandDeps } from './license/renew.js';
import type { OpenUrl } from './open-url.js';
import type { PackageManager } from './package-manager.js';
import type { GlobalFlags, OptionValue } from './parse.js';
import type { RateLimitWaitSeam } from './rate-limit-wait.js';
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
  readonly options: Readonly<Record<string, OptionValue>>;
  /** The resolved config: without a `kindgi dev` runtime's .kindgirc.json when `hosted`. */
  readonly config: ResolvedConfig;
  /**
   * `--hosted`, or the env the command acts in has `build: 'hosted'`
   * (api-address.ts `hostedScope`): the command goes to the CLI's own
   * address, never a `kindgi dev` runtime's.
   */
  readonly hosted: boolean;
  /**
   * Create an SDK client using the resolved config. Throws if apiUrl / token
   * are missing, or the token is a stored key that isn't for apiUrl.
   */
  readonly client: () => KindgiClient;
  /** Create an SDK client bound to arbitrary apiUrl + token (used by `kindgi dev`). */
  readonly clientFor: (apiUrl: string, token: string) => KindgiClient;
  /** Base URL, if resolved — used by non-SDK direct fetch (health, whoami). */
  readonly apiUrl: () => string;
  /**
   * Bearer token, if resolved — used by non-SDK direct fetch to `apiUrl()`.
   * Throws when it's a stored key that isn't for that address
   * (api-address.ts): before anything is sent.
   */
  readonly token: () => string;
  /**
   * A command that reads its key with its address (`kindgi deploy`,
   * api-address.ts) sends it to the CLI's own address: main's line about
   * a `kindgi dev` runtime goes first, as it does for `token()`.
   */
  readonly noteOwnAddressKey: () => void;
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
   * Optional signal that stops long-lived commands (`kindgi dev`'s watch
   * loop, a download, a deploy's waits). Tests pass an
   * `AbortController.signal` so a graceful shutdown path can be
   * exercised without process signals. Production callers wire this to
   * SIGINT/SIGTERM/SIGHUP in `cli.ts`.
   */
  readonly stopSignal: AbortSignal | undefined;
  /**
   * Where a command says how it's going while it runs (`kindgi build`'s
   * lines): the CLI's stderr, each line as it comes (`cli.ts`). Undefined
   * when `runCli` is given none (tests): the command then returns those
   * lines with its result.
   */
  readonly progress: ((text: string) => void) | undefined;
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
  /** Injectable seams for `kindgi license renew` (its clock, its fetch): tests only. */
  readonly licenseDeps?: LicenseCommandDeps;
  /** Injectable seams for `kindgi feedback` (its clock, the doctor, the platform, the prompt): tests only. */
  readonly feedbackSeam?: FeedbackSeam;
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
  /**
   * Injectable seams for `kindgi auth registry`: the `docker` runner, the
   * stdin reader, the hidden prompt and the image checked. Tests pass
   * fixtures so the login and the check run without Docker or a
   * terminal; production leaves this undefined (the real ones).
   */
  readonly registryAuthSeam: RegistryAuthSeam | undefined;
  /**
   * `kindgi init`'s read of the host's pnpm version (`pnpm --version` in
   * the new pack). Tests inject it; production leaves it undefined.
   */
  readonly initSeam: InitSeam | undefined;
  /**
   * `kindgi doctor`'s tools, `docker` runner, Node version, image and
   * presets. Tests inject them; production leaves this undefined.
   */
  readonly doctorSeam: DoctorSeam | undefined;
  /**
   * Opens a URL in the browser (`kindgi console`, `kindgi dev --open`).
   * Tests inject it; production leaves it undefined (the system's opener).
   */
  readonly openUrl: OpenUrl | undefined;
  /**
   * The sleep, clock and output the publishing commands wait out the
   * server's rate limits with (`rate-limit-wait.ts`). Tests inject them;
   * production leaves this undefined (a timer, the clock, stderr).
   */
  readonly rateLimitWaits?: RateLimitWaitSeam;
  /** `kindgi exports create`'s output, clock and pauses. Tests inject them; production leaves this undefined. */
  readonly exportsSeam?: ExportsSeam;
  /** `kindgi connections connect`'s terminal, clock and pauses, and the removals' question. Tests inject them; production leaves this undefined. */
  readonly connectionsSeam?: ConnectionsSeam;
}

export interface InitSeam {
  readonly pnpmVersion?: (dir: string) => Promise<string>;
  /** Whether a package manager runs here (`<pm> --version`). Default: the real probe. */
  readonly packageManagerRuns?: (pm: PackageManager) => Promise<boolean>;
}

export interface BuildContextInputs {
  readonly globals: GlobalFlags;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly config: ResolvedConfig;
  /** See `CommandContext.hosted`. Default: `false`. */
  readonly hosted?: boolean;
  /** Why there's no API address, when `config` has none: said in place of the general line. */
  readonly noAddress?: string;
  /** Called on each `token()` that returns a key, and on `noteOwnAddressKey()`, before it's sent: main's line ahead of it. */
  readonly onToken?: () => void;
  /** The command as typed (`kindgi runs list`), for a refusal to name. Default: `kindgi`. */
  readonly commandLabel?: string;
  readonly fetchImpl?: typeof fetch;
  readonly clientFactory?: (apiUrl: string, token: string) => KindgiClient;
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly devRunners?: DevRunners;
  readonly stopSignal?: AbortSignal;
  readonly progress?: ((text: string) => void) | undefined;
  readonly buildRunners?: BuildRunners;
  readonly buildConfigLoader?: (packDir: string) => Promise<{ readonly [k: string]: unknown }>;
  readonly deployRunners?: DeployRunners;
  readonly testRunners?: TestRunners;
  readonly envRunners?: EnvRunners;
  readonly keyRunners?: KeyRunners;
  readonly licenseDeps?: LicenseCommandDeps;
  readonly feedbackSeam?: FeedbackSeam;
  readonly secretsInputSeam?: SecretsValueInputSeam;
  readonly envInitInputSeam?: EnvInitInputSeam;
  readonly registryAuthSeam?: RegistryAuthSeam;
  readonly initSeam?: InitSeam;
  readonly doctorSeam?: DoctorSeam;
  readonly openUrl?: OpenUrl;
  readonly rateLimitWaits?: RateLimitWaitSeam;
  readonly exportsSeam?: ExportsSeam;
  readonly connectionsSeam?: ConnectionsSeam;
}

export function buildContext(inputs: BuildContextInputs): CommandContext {
  const apiUrl = (): string => {
    if (inputs.config.apiUrl === undefined) {
      throw new Error(
        inputs.noAddress ??
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
    // A stored key goes only to the address stored with it.
    const refusal = ownAddressKeyRefusal(inputs.commandLabel ?? 'kindgi', inputs.config);
    if (refusal !== undefined) throw new Error(refusal);
    inputs.onToken?.();
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
    hosted: inputs.hosted ?? false,
    client: () => factory(apiUrl(), token()),
    clientFor: (url, tok) => factory(url, tok),
    apiUrl,
    token,
    noteOwnAddressKey: () => inputs.onToken?.(),
    fetch: inputs.fetchImpl ?? fetch,
    home: inputs.home,
    cwd: inputs.cwd ?? process.cwd(),
    env: inputs.env ?? {},
    devRunners: inputs.devRunners,
    stopSignal: inputs.stopSignal,
    progress: inputs.progress,
    buildRunners: inputs.buildRunners,
    buildConfigLoader: inputs.buildConfigLoader,
    deployRunners: inputs.deployRunners,
    testRunners: inputs.testRunners,
    envRunners: inputs.envRunners,
    keyRunners: inputs.keyRunners,
    ...(inputs.licenseDeps !== undefined && { licenseDeps: inputs.licenseDeps }),
    ...(inputs.feedbackSeam !== undefined && { feedbackSeam: inputs.feedbackSeam }),
    secretsInputSeam: inputs.secretsInputSeam,
    envInitInputSeam: inputs.envInitInputSeam,
    registryAuthSeam: inputs.registryAuthSeam,
    initSeam: inputs.initSeam,
    doctorSeam: inputs.doctorSeam,
    openUrl: inputs.openUrl,
    ...(inputs.rateLimitWaits !== undefined && { rateLimitWaits: inputs.rateLimitWaits }),
    ...(inputs.exportsSeam !== undefined && { exportsSeam: inputs.exportsSeam }),
    ...(inputs.connectionsSeam !== undefined && { connectionsSeam: inputs.connectionsSeam }),
  };
}
