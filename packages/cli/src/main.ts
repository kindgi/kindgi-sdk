// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { resolve } from 'node:path';

import type { KindgiClient } from '@kindgi/client';

import type { BuildRunners } from './build/runners.js';
import { cliPinWarning, readCliPin } from './cli-pin.js';
import type { RegistryAuthSeam } from './commands/auth.js';
import type { DoctorSeam } from './commands/doctor.js';
import type { EnvInitInputSeam } from './commands/env.js';
import { ROOT_COMMANDS, findCommand } from './commands/index.js';
import type { SecretsValueInputSeam } from './commands/secrets.js';
import type { Command } from './commands/types.js';
import { type ResolvedConfig, loadConfig } from './config.js';
import type { InitSeam } from './context.js';
import { buildContext } from './context.js';
import type { DeployRunners } from './deploy/runners.js';
import type { DevRunners } from './dev/runners.js';
import type { EnvRunners } from './env/runners.js';
import { formatThrown } from './errors.js';
import { commandHelpText, rootHelpText } from './help.js';
import type { KeyRunners } from './key/runners.js';
import { GLOBAL_OPTION_SPEC, parseCommand } from './parse.js';
import type { TestRunners } from './test/runners.js';
import { CLI_VERSION } from './version-info.js';

export interface RunCliInputs {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly home?: string;
  readonly fetchImpl?: typeof fetch;
  readonly clientFactory?: (apiUrl: string, token: string) => KindgiClient;
  readonly configReadFile?: (path: string) => Promise<string | null>;
  /**
   * Injectable seams used exclusively by `kindgi dev` — the runtime,
   * indexer, and pack-folder watcher. Tests hand in fixture
   * implementations so the command flow exercises without Docker or
   * Postgres. When absent, `kindgi dev` uses production wiring from
   * `packages/cli/src/dev/defaults.ts` (loaded lazily, so other commands
   * don't load the dev loop's dependencies).
   */
  readonly devRunners?: DevRunners;
  /**
   * Optional signal that terminates long-running commands (the
   * `kindgi dev` watch loop). Production callers wire this to
   * SIGINT/SIGTERM in the `cli.js` bin; tests pass an
   * `AbortController.signal`.
   */
  readonly stopSignal?: AbortSignal;
  /**
   * Injectable seams used exclusively by `kindgi build` — the local
   * indexer, esbuild bundler, Containerfile writer, tar producer, POST
   * /v1/build client, SSE log reader, docker-pull-and-extract, and
   * Ed25519 signer. Tests substitute fixture implementations so the
   * pipeline exercises without spawning esbuild / real docker / a live
   * build server. When absent, `kindgi build` lazy-loads production
   * wiring from `packages/cli/src/build/defaults.ts`.
   */
  readonly buildRunners?: BuildRunners;
  /**
   * Optional loader for `kindgi.config.ts`. Tests hand in an
   * in-memory function; production uses a plain dynamic `import()`.
   */
  readonly buildConfigLoader?: (packDir: string) => Promise<{ readonly [k: string]: unknown }>;
  /**
   * Injectable seams used exclusively by `kindgi deploy` — the
   * envelope loader + POST /v1/deployments client + optional inline-
   * build runner. Tests substitute fixture implementations so the
   * pipeline exercises without reading a real envelope from disk or
   * hitting a live api-server. Production lazy-loads
   * `packages/cli/src/deploy/defaults.ts` on dispatch.
   */
  readonly deployRunners?: DeployRunners;
  /**
   * Injectable seams used exclusively by `kindgi test` — the
   * vitest config probe + runner spawn. Tests substitute stubs so
   * the command exercises without spawning real vitest. Production
   * lazy-loads `packages/cli/src/test/defaults.ts` on dispatch.
   */
  readonly testRunners?: TestRunners;
  /**
   * Injectable filesystem seams used exclusively by `kindgi env` —
   * `.env.<envName>` reads/writes. Tests substitute in-memory stubs
   * so no real env files touch disk. Production lazy-loads
   * `packages/cli/src/env/defaults.ts` on dispatch.
   */
  readonly envRunners?: EnvRunners;
  /**
   * Injectable seams used exclusively by `kindgi key` — the crypto
   * generator + `~/.kindgi/keys/` fs surface. Tests substitute stubs so
   * no real key files touch disk. Production lazy-loads
   * `packages/cli/src/key/defaults.ts` on dispatch.
   */
  readonly keyRunners?: KeyRunners;
  /**
   * Injectable value-input seams for `kindgi secrets set` /
   * `rotate`. Tests substitute stubs so the TTY / stdin / file paths
   * exercise without a real terminal.
   */
  readonly secretsInputSeam?: SecretsValueInputSeam;
  /**
   * Injectable prompt / TTY-check seam for `kindgi env init`. Tests
   * substitute a fixture `promptChoice`.
   */
  readonly envInitInputSeam?: EnvInitInputSeam;
  /**
   * Injectable seams for `kindgi auth registry`: the `docker` runner, the
   * stdin reader, the hidden prompt and the image checked. Tests
   * substitute fixtures so no real `docker login` runs.
   */
  readonly registryAuthSeam?: RegistryAuthSeam;
  readonly initSeam?: InitSeam;
  /** `kindgi doctor`'s seams (tools, docker, Node version, image, presets). */
  readonly doctorSeam?: DoctorSeam;
}

/**
 * The resolved config. `kindgi doctor` runs on a config file it can't
 * read (malformed JSON), which it reports itself; every other command
 * fails on it.
 */
async function configFor(
  topLevel: string | undefined,
  loading: Promise<ResolvedConfig>,
): Promise<ResolvedConfig> {
  try {
    return await loading;
  } catch (err) {
    if (topLevel !== 'doctor') throw err;
    return { apiUrl: undefined, token: undefined, source: { apiUrl: 'unset', token: 'unset' } };
  }
}

export interface CliOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Entry point invoked by both the compiled `kindgi` bin and the
 * test harness. Isolated from `process.exit` / `process.argv` so tests
 * can drive it directly.
 */
export async function runCli(inputs: RunCliInputs): Promise<CliOutcome> {
  const argv = inputs.argv;

  // Handle top-level version / help before command parsing so
  // `kindgi --version` works without arguments.
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { stdout: rootHelpText(), stderr: '', exitCode: 0 };
  }
  if (argv[0] === '--version') {
    return { stdout: `${CLI_VERSION}\n`, stderr: '', exitCode: 0 };
  }

  const found = findCommand(argv);
  if (found === null) {
    return {
      stdout: '',
      stderr: `Unknown command: ${argv.join(' ')}\n\n${rootHelpText()}`,
      exitCode: 2,
    };
  }
  const { command, consumed } = found;
  const remainingTokens = argv.slice(consumed);

  if (command.kind === 'group') {
    return { stdout: commandHelpText(command, argv.slice(0, consumed)), stderr: '', exitCode: 0 };
  }

  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(remainingTokens, {
      ...(command.optionSpec ?? {}),
      ...GLOBAL_OPTION_SPEC,
    });
  } catch (err) {
    return {
      stdout: '',
      stderr: `Argument error: ${(err as Error).message}\n\n${commandHelpText(command)}`,
      exitCode: 2,
    };
  }

  if (parsed.globals.help) {
    return { stdout: commandHelpText(command), stderr: '', exitCode: 0 };
  }
  if (parsed.globals.version) {
    return { stdout: `${CLI_VERSION}\n`, stderr: '', exitCode: 0 };
  }

  const config = await configFor(
    argv[0],
    loadConfig({
      ...(parsed.globals.url !== undefined ? { flagUrl: parsed.globals.url } : {}),
      ...(parsed.globals.token !== undefined ? { flagToken: parsed.globals.token } : {}),
      ...(inputs.env !== undefined ? { env: inputs.env } : {}),
      ...(inputs.cwd !== undefined ? { cwd: inputs.cwd } : {}),
      ...(inputs.home !== undefined ? { home: inputs.home } : {}),
      ...(inputs.configReadFile !== undefined ? { readFile: inputs.configReadFile } : {}),
    }),
  );

  // Lazily wire dev runners so commands other than `kindgi dev` don't
  // load the dev loop. Tests supplying `inputs.devRunners` always win.
  //
  // Keyed on the TOP-LEVEL command (`argv[0]`), not the resolved leaf:
  // `kindgi env list` resolves to the leaf `list`, so matching on the
  // leaf name never loaded the env / key runners outside tests.
  const topLevel = argv[0];
  const devRunners =
    inputs.devRunners ?? (topLevel === 'dev' ? await loadRealDevRunners() : undefined);
  // Same shape for `kindgi build`: lazy-load the esbuild / tar /
  // docker seams so unrelated commands don't pay the transitive load.
  // `kindgi deploy` needs the build runners too when the envelope
  // is missing and the command auto-runs `kindgi build` inline.
  const needsBuildRunners = topLevel === 'build' || topLevel === 'deploy';
  const buildRunners =
    inputs.buildRunners ?? (needsBuildRunners ? await loadRealBuildRunners() : undefined);
  const deployRunners =
    inputs.deployRunners ?? (topLevel === 'deploy' ? await loadRealDeployRunners() : undefined);
  const testRunners =
    inputs.testRunners ?? (topLevel === 'test' ? await loadRealTestRunners() : undefined);
  const envRunners =
    inputs.envRunners ?? (topLevel === 'env' ? await loadRealEnvRunners() : undefined);
  const keyRunners =
    inputs.keyRunners ?? (topLevel === 'key' ? await loadRealKeyRunners() : undefined);

  const ctx = buildContext({
    globals: parsed.globals,
    positionals: parsed.positionals,
    options: parsed.options,
    config,
    ...(inputs.fetchImpl !== undefined ? { fetchImpl: inputs.fetchImpl } : {}),
    ...(inputs.clientFactory !== undefined ? { clientFactory: inputs.clientFactory } : {}),
    ...(inputs.home !== undefined ? { home: inputs.home } : {}),
    ...(inputs.cwd !== undefined ? { cwd: inputs.cwd } : {}),
    ...(inputs.env !== undefined ? { env: inputs.env } : {}),
    ...(devRunners !== undefined ? { devRunners } : {}),
    ...(inputs.stopSignal !== undefined ? { stopSignal: inputs.stopSignal } : {}),
    ...(buildRunners !== undefined ? { buildRunners } : {}),
    ...(inputs.buildConfigLoader !== undefined
      ? { buildConfigLoader: inputs.buildConfigLoader }
      : {}),
    ...(deployRunners !== undefined ? { deployRunners } : {}),
    ...(testRunners !== undefined ? { testRunners } : {}),
    ...(envRunners !== undefined ? { envRunners } : {}),
    ...(keyRunners !== undefined ? { keyRunners } : {}),
    ...(inputs.secretsInputSeam !== undefined ? { secretsInputSeam: inputs.secretsInputSeam } : {}),
    ...(inputs.envInitInputSeam !== undefined ? { envInitInputSeam: inputs.envInitInputSeam } : {}),
    ...(inputs.registryAuthSeam !== undefined ? { registryAuthSeam: inputs.registryAuthSeam } : {}),
    ...(inputs.initSeam !== undefined ? { initSeam: inputs.initSeam } : {}),
    ...(inputs.doctorSeam !== undefined ? { doctorSeam: inputs.doctorSeam } : {}),
  });

  const label = commandLabel(command, argv, consumed);
  // A Java pack pins the CLI it runs with (`cli-pin.ts`): say when this isn't it.
  // `kindgi dev` runs until stopped, so it hears it now, before it starts.
  const pinWarning = PIN_EXEMPT.has(topLevel ?? '')
    ? undefined
    : await pinWarningFor(ctx.cwd, parsed.options.path);
  if (pinWarning !== undefined && topLevel === 'dev') process.stderr.write(pinWarning);
  const before = topLevel === 'dev' ? '' : (pinWarning ?? '');
  try {
    const result = await command.run(ctx);
    if (result.kind === 'ok') {
      return {
        stdout: result.rendered.stdout,
        stderr: `${before}${result.rendered.stderr}`,
        exitCode: result.exitCode ?? 0,
      };
    }
    return { stdout: '', stderr: `${before}${result.stderr}`, exitCode: result.exitCode };
  } catch (err) {
    const formatted = formatThrown(err, { commandLabel: label, verbose: parsed.globals.verbose });
    return { stdout: '', stderr: formatted.stderr, exitCode: formatted.exitCode };
  }
}

/** Commands that never warn about the pin: they make it, move it, or don't run against a pack. */
const PIN_EXEMPT: ReadonlySet<string> = new Set(['init', 'upgrade', 'version']);

async function pinWarningFor(cwd: string, pathOption: unknown): Promise<string | undefined> {
  const dir = typeof pathOption === 'string' && pathOption !== '' ? resolve(cwd, pathOption) : cwd;
  const pin = await readCliPin(dir);
  return pin === undefined ? undefined : cliPinWarning(pin, CLI_VERSION);
}

function commandLabel(_command: Command, argv: readonly string[], consumed: number): string {
  return `kindgi ${argv.slice(0, consumed).join(' ')}`;
}

async function loadRealDevRunners(): Promise<DevRunners | undefined> {
  try {
    const mod = await import('./dev/defaults.js');
    return mod.REAL_DEV_RUNNERS;
  } catch {
    // Loading defaults can fail cleanly when a dev-loop dependency
    // isn't installed (e.g. a minimally-built environment). We surface a
    // clear error inside the command handler rather than crash CLI
    // dispatch here.
    return undefined;
  }
}

async function loadRealBuildRunners(): Promise<BuildRunners | undefined> {
  try {
    const mod = await import('./build/defaults.js');
    return mod.REAL_BUILD_RUNNERS;
  } catch {
    // Same pattern as dev — if esbuild / tar / @kindgi/crypto /
    // @kindgi/handler-runtime fail to load, the command handler
    // surfaces a clear error rather than crashing dispatch.
    return undefined;
  }
}

async function loadRealDeployRunners(): Promise<DeployRunners | undefined> {
  try {
    const mod = await import('./deploy/defaults.js');
    return mod.REAL_DEPLOY_RUNNERS;
  } catch {
    // If the envelope loader / post module fails to load, surface a
    // clean error from the command handler rather than crashing
    // dispatch — mirrors dev + build.
    return undefined;
  }
}

async function loadRealTestRunners(): Promise<TestRunners | undefined> {
  try {
    const mod = await import('./test/defaults.js');
    return mod.REAL_TEST_RUNNERS;
  } catch {
    // Should never fail (only node:child_process + node:fs), but keep
    // the same shape as every other lazy-load path so a broken import
    // surfaces via the command handler.
    return undefined;
  }
}

async function loadRealEnvRunners(): Promise<EnvRunners | undefined> {
  try {
    const mod = await import('./env/defaults.js');
    return mod.REAL_ENV_RUNNERS;
  } catch {
    return undefined;
  }
}

async function loadRealKeyRunners(): Promise<KeyRunners | undefined> {
  try {
    const mod = await import('./key/defaults.js');
    return mod.REAL_KEY_RUNNERS;
  } catch {
    // `@kindgi/crypto` transitively pulls in `node:crypto`, always
    // available under Node 22. If this ever fails, the fault is a
    // build-time mispackage.
    return undefined;
  }
}

export { ROOT_COMMANDS };
