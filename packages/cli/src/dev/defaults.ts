// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Production wiring for `kindgi dev` — the `DevRunners` implementation
 * the CLI uses when no test override is present.
 *
 * `startApiServer` runs the Kindgi runtime as a container
 * (`runtime-container.ts`), configured by `runtime.env`, with the pack
 * directory mounted. `runIndexer` wraps
 * `@kindgi/handler-runtime.runIndexer` + reads back the emitted
 * `index.json`. `watchPack` wraps `node:fs.watch({ recursive: true })`
 * on the four discovery folders with a caller-supplied debounce (default
 * 200ms). All three are named + separated so the test seam swaps them
 * individually.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { stat as fsStat, mkdir, readFile, rename, watch, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DISCOVERY,
  type IndexerReport,
  PACK_ENV_CHECK_VAR,
  PACK_ENV_FILTER_VAR,
  createGlobMatcher,
  discoveryRoots,
  runIndexer as runIndexerReal,
} from '@kindgi/handler-runtime';
import { createPackServiceSupervisor } from '@kindgi/handler-runtime/pack-service';

import { createDevPackBuilder } from './bundler.js';
import { createJavaPackBuilder } from './java-builder.js';
import { lineReader } from './lines.js';
import {
  type JvmPackCode,
  type PackCode,
  checkPackJvm,
  checkPackPython,
  isJvmPackCode,
  javaArgsFile,
  javaEnv,
  javaLauncher,
} from './pack-code.js';
import { devBundleMapPath, devIndexPath, devIndexerDir } from './paths.js';
import { runtimePortInUseReal } from './port.js';
import {
  type DockerRunner,
  type PostgresContainerSpec,
  hostPortOf,
  postgresSpecFromCompose,
  startPostgresContainer,
} from './postgres-container.js';
import { bundledSqlRunner, createProjectDatabases } from './project-database.js';
import { createPythonPackBuilder } from './python-builder.js';
import type {
  DevPackService,
  DevPackServiceOptions,
  DevRunners,
  IndexResult,
  IndexerRunOptions,
  PackBuilder,
  RunningApiServer,
  StartApiServerOptions,
  StartServicesResult,
  StartedServicesHandle,
  WatchHandle,
} from './runners.js';
import {
  type DockerOutcome,
  IMAGE_API_PORT,
  type RuntimeNetwork,
  RuntimeStartStopped,
  detectRuntimeNetwork,
  docker,
  ensureRuntimeImage,
  pauseUnlessStopped,
  startRuntimeContainer,
} from './runtime-container.js';
import {
  RUNTIME_EXPORT_SIGNING_KEY,
  RUNTIME_GOOGLE_CREDENTIALS,
  RUNTIME_PACK_DIR,
  RUNTIME_PUBLIC_TOKEN_KEY,
  buildRuntimeEnv,
  runtimeEnvPath,
  shellReferencesOf,
  writeRuntimeEnv,
} from './runtime-env.js';
import { probeReal } from './sandbox/detect.js';
import {
  type ActiveDevSandbox,
  detectDevSandbox,
  sandboxTmpDir,
  sandboxedCommand,
} from './sandbox/index.js';
import { createScalaPackBuilder } from './scala-builder.js';
import {
  DEFAULT_SCAN_INTERVAL_MS,
  type ScanBackstop,
  scanSignature,
  startScanBackstop,
} from './scan-backstop.js';
import { SHARE_WATCH_BY_DEFAULT, type WatchEvents, directoryWatches } from './shared-watch.js';

const DEFAULT_DEBOUNCE_MS = 200;

/**
 * Absolute path to `@kindgi/handler-runtime`'s pack-service entrypoint —
 * the same process a deployment's pack image runs. `import.meta.resolve`
 * because the package is ESM-only. Throws if unresolvable; that's a
 * broken install, not a runtime fallback.
 */
function resolvePackServiceEntrypoint(): string {
  return fileURLToPath(import.meta.resolve('@kindgi/handler-runtime/pack-service-main'));
}

/**
 * The pack-service process for the pack's code: the Node pack service
 * (loading the bundles in `.kindgi/dev/dist`, stack traces mapped back to
 * the sources), `python -m kindgi.pack serve` with the pack's Python, or,
 * for a JVM pack (Java or Scala), `com.kindgi.pack.Main serve` through the
 * launcher with the pack's classpath (its `@argfile`, which the build
 * rewrites).
 */
export function packServiceCommand(code: PackCode): readonly [string, ...string[]] {
  if (code.language === 'python') return [...code.python, '-m', 'kindgi.pack', 'serve'];
  if (isJvmPackCode(code)) {
    return ['sh', javaLauncher(code), `@${javaArgsFile(code)}`, 'com.kindgi.pack.Main', 'serve'];
  }
  return [process.execPath, '--enable-source-maps', resolvePackServiceEntrypoint()];
}

/**
 * The pack service as a child process behind the supervisor's front. The
 * runtime calls the front over HTTP, the same address however often the
 * code is swapped (it retries while the front answers 503 mid-swap).
 */
export function createPackServiceReal(opts: DevPackServiceOptions): DevPackService {
  // A required env name the pack lacks is a warning in dev (the
  // service still serves), not a refusal as in a deployment. And the
  // service keeps the app's env files' names: in dev the pack reads the
  // app's settings, declared or not.
  const env = async (): Promise<Readonly<Record<string, string>>> => {
    const base: Record<string, string> = {
      ...(await opts.env()),
      [PACK_ENV_CHECK_VAR]: 'warn',
      [PACK_ENV_FILTER_VAR]: 'off',
    };
    if (opts.sandbox !== undefined) {
      base.TMPDIR = opts.sandbox.engine === 'seatbelt' ? sandboxTmpDir(opts.packDir) : '/tmp';
    }
    return isJvmPackCode(opts.code) ? javaEnv(opts.code, base) : base;
  };
  const { sandbox } = opts;
  const command = packServiceCommand(opts.code);
  return createPackServiceSupervisor({
    // Sandboxed: worked out at every start, for what that start runs.
    command:
      sandbox === undefined
        ? command
        : async () =>
            (
              await sandboxedCommand(sandbox, {
                packDir: opts.packDir,
                code: opts.code,
                command,
                env: await env(),
                node: { execPath: process.execPath, entry: resolvePackServiceEntrypoint() },
                ...(opts.onNotice !== undefined && { onNotice: opts.onNotice }),
              })
            ).command,
    moduleRoot: opts.packDir,
    cwd: opts.packDir,
    env,
    onLog: opts.onLog,
    onEvent: opts.onEvent,
    ...(opts.port !== undefined && { port: opts.port }),
    ...(opts.token !== undefined && { token: opts.token }),
  });
}

/** The builder for the pack's code: esbuild bundles (Node), the sources (Python), Maven (Java), sbt (Scala). */
export function createPackBuilderReal(opts: {
  readonly packDir: string;
  readonly patterns: readonly string[];
  readonly configPath?: string;
  readonly code: PackCode;
  readonly env: () => Promise<Readonly<Record<string, string>>>;
}): PackBuilder {
  if (opts.code.language === 'java') {
    return createJavaPackBuilder({ packDir: opts.packDir, code: opts.code, env: opts.env });
  }
  if (opts.code.language === 'scala') {
    return createScalaPackBuilder({ packDir: opts.packDir, code: opts.code, env: opts.env });
  }
  return opts.code.language === 'python'
    ? createPythonPackBuilder({ packDir: opts.packDir, python: opts.code.python, env: opts.env })
    : createDevPackBuilder({
        packDir: opts.packDir,
        patterns: opts.patterns,
        ...(opts.configPath !== undefined && { configPath: opts.configPath }),
      });
}

export interface PythonIndexerOptions {
  readonly packDir: string;
  readonly outputPath: string;
  /** The pack's interpreter (an argv prefix). */
  readonly python: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  /** Pins for a reproducible index (`kindgi build`). */
  readonly artifactVersion?: string;
  readonly publishedAt?: string;
  /** What pack code prints while the indexer loads it (`IndexerRunOptions.onOutput`). */
  readonly onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Run it in `kindgi dev`'s sandbox (`IndexerRunOptions.sandbox`). */
  readonly sandbox?: IndexerSandbox;
}

/** `kindgi dev`'s sandbox for an indexer child, and where its notices go. */
export interface IndexerSandbox {
  readonly sandbox: ActiveDevSandbox;
  readonly onNotice?: (line: string) => void;
}

/**
 * An indexer child's command, inside the sandbox when there is one (its
 * own profile, its own temp folder, the indexer's output folder the one
 * place in `.kindgi` it writes); and its environment.
 */
async function indexerChild(
  command: readonly [string, ...string[]],
  ctx: {
    readonly packDir: string;
    readonly code: PackCode;
    readonly env: Readonly<Record<string, string>>;
    readonly entry: string;
    readonly sandbox: IndexerSandbox | undefined;
  },
): Promise<{
  readonly command: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
}> {
  if (ctx.sandbox === undefined) return { command, env: ctx.env };
  const { sandbox, onNotice } = ctx.sandbox;
  const env = {
    ...ctx.env,
    TMPDIR: sandbox.engine === 'seatbelt' ? sandboxTmpDir(ctx.packDir) : '/tmp',
  };
  const wrapped = await sandboxedCommand(sandbox, {
    packDir: ctx.packDir,
    code: ctx.code,
    command,
    env,
    node: { execPath: process.execPath, entry: ctx.entry },
    process: 'indexer',
    writable: [devIndexerDir(ctx.packDir)],
    ...(onNotice !== undefined && { onNotice }),
  });
  return { command: wrapped.command, env };
}

/**
 * `python -m kindgi.pack index` with the pack's Python and an environment,
 * read back like the Node indexer's: the same one-line outcome, then the
 * written index.
 */
export async function runPythonIndexer(opts: PythonIndexerOptions): Promise<IndexResult> {
  const [program, ...prefix] = opts.python;
  const args = [
    ...prefix,
    '-m',
    'kindgi.pack',
    'index',
    '--pack-dir',
    opts.packDir,
    '--output',
    opts.outputPath,
    ...(opts.artifactVersion !== undefined ? ['--artifact-version', opts.artifactVersion] : []),
    ...(opts.publishedAt !== undefined ? ['--published-at', opts.publishedAt] : []),
    '--json',
  ];
  const child = await indexerChild([program, ...args], {
    packDir: opts.packDir,
    code: { language: 'python', python: opts.python } as PackCode,
    env: opts.env,
    entry: indexChildScript(),
    sandbox: opts.sandbox,
  });
  const [cmd, ...rest] = child.command;
  return indexResultOf(outcomeOfChild(await runChild(cmd, rest, child.env, opts.onOutput)));
}

export interface JavaIndexerOptions {
  readonly packDir: string;
  readonly outputPath: string;
  /** The pack's JDK and build (its classpath `@argfile`, written by a build). */
  readonly code: JvmPackCode;
  readonly env: Readonly<Record<string, string>>;
  /** Pins for a reproducible index (`kindgi build`). */
  readonly artifactVersion?: string;
  readonly publishedAt?: string;
  /** What pack code prints while the indexer loads it (`IndexerRunOptions.onOutput`). */
  readonly onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Run it in `kindgi dev`'s sandbox (`IndexerRunOptions.sandbox`). */
  readonly sandbox?: IndexerSandbox;
}

/**
 * `com.kindgi.pack.Main index` with the pack's JDK and classpath, read back
 * like the other indexers: the same one-line outcome, then the written
 * index.
 */
export async function runJavaIndexer(opts: JavaIndexerOptions): Promise<IndexResult> {
  const args = [
    `@${javaArgsFile(opts.code)}`,
    'com.kindgi.pack.Main',
    'index',
    '--pack-dir',
    opts.packDir,
    '--output',
    opts.outputPath,
    ...(opts.artifactVersion !== undefined ? ['--artifact-version', opts.artifactVersion] : []),
    ...(opts.publishedAt !== undefined ? ['--published-at', opts.publishedAt] : []),
    '--json',
  ];
  const child = await indexerChild([opts.code.java, ...args], {
    packDir: opts.packDir,
    code: opts.code,
    env: javaEnv(opts.code, opts.env),
    entry: indexChildScript(),
    sandbox: opts.sandbox,
  });
  const [cmd, ...rest] = child.command;
  return indexResultOf(outcomeOfChild(await runChild(cmd, rest, child.env, opts.onOutput)));
}

/** The Node indexer child's script: TypeScript from source (tests), else the built one. */
function indexChildScript(): string {
  const fromSource = import.meta.url.endsWith('.ts');
  return fileURLToPath(
    new URL(fromSource ? './index-child.ts' : './index-child.js', import.meta.url),
  );
}

/** The indexer's outcome — in this process, or as a child's JSON line. */
type IndexerOutcome =
  | { readonly kind: 'ok'; readonly value: IndexerReport }
  | {
      readonly kind: 'err';
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly filePath?: string;
      };
    };

/**
 * The indexer in a child process with the pack's environment, importing
 * bundles (see `index-child.ts`). From source (tests) the child runs as
 * TypeScript under Node's type stripping.
 */
async function runIndexerInChild(
  packDir: string,
  outputPath: string,
  env: () => Promise<Readonly<Record<string, string>>>,
  bundleMap: Readonly<Record<string, string>>,
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void,
  sandbox?: IndexerSandbox,
): Promise<IndexerOutcome> {
  const mapPath = devBundleMapPath(packDir);
  await mkdir(dirname(mapPath), { recursive: true });
  await writeFile(mapPath, JSON.stringify(bundleMap), 'utf8');
  const script = indexChildScript();
  const args = [
    '--enable-source-maps',
    script,
    '--pack',
    packDir,
    '--out',
    outputPath,
    '--bundle-map',
    mapPath,
  ];
  const child = await indexerChild([process.execPath, ...args], {
    packDir,
    code: { language: 'node' } as PackCode,
    env: await env(),
    entry: script,
    sandbox,
  });
  const [cmd, ...rest] = child.command;
  return outcomeOfChild(await runChild(cmd, rest, child.env, onOutput));
}

/** The outcome an indexer child printed as its last stdout line. */
function outcomeOfChild(run: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}): IndexerOutcome {
  const line = run.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as IndexerOutcome;
  } catch {
    const detail = run.stderr.trim().split('\n').slice(-5).join(' | ');
    return {
      kind: 'err',
      error: {
        code: 'index-child-failed',
        message: `The indexer process exited (${run.code}) without a result${detail.length > 0 ? `: ${detail}` : ''}`,
      },
    };
  }
}

/**
 * Run an indexer child to the end: its output, and each line of it to
 * `onOutput` as it comes, except its last stdout line when that's the
 * indexer's result (held back until the next line shows it isn't).
 */
function runChild(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let held: string | undefined;
    const outLines = lineReader((line) => {
      if (held !== undefined) onOutput?.(held, 'stdout');
      held = line;
    });
    const errLines = lineReader((line) => onOutput?.(line, 'stderr'));
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      outLines.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      errLines.push(chunk);
    });
    child.once('error', (cause) => resolvePromise({ stdout, stderr: cause.message, code: null }));
    child.once('close', (code) => {
      outLines.end();
      errLines.end();
      if (held !== undefined && !isIndexerResult(held)) onOutput?.(held, 'stdout');
      resolvePromise({ stdout, stderr, code });
    });
  });
}

/** Whether a line is an indexer's one-line result (`{"kind":"ok"|"err",…}`). */
function isIndexerResult(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { readonly kind?: unknown };
    return parsed.kind === 'ok' || parsed.kind === 'err';
  } catch {
    return false;
  }
}

/** Swap the staged index in: the dev index changes in one step (a rename). */
export async function publishIndexReal(stagedPath: string, indexPath: string): Promise<void> {
  await rename(stagedPath, indexPath);
}

/**
 * The Kindgi runtime, as a container: pull the image if needed, write
 * `runtime.env`, start it with the pack directory mounted, and wait until
 * it serves. The runtime makes or loads its own public run token key;
 * the developer's key file, if set, and the Google credentials
 * `KINDGI_DEV_GOOGLE_CREDENTIALS` names, if any, are mounted read-only.
 */
export async function startApiServerContainerReal(
  opts: StartApiServerOptions,
): Promise<RunningApiServer> {
  const progress = opts.onProgress ?? (() => undefined);
  const network = await detectRuntimeNetwork();
  const image = await ensureRuntimeImage(opts.runtimeImage, progress);
  if (image.kind === 'error') throw new Error(image.message);

  const googleCredentials = opts.googleCredentialsPath;
  const env = buildRuntimeEnv({
    ...(network === 'host-network'
      ? { apiPort: opts.port, apiHost: '127.0.0.1' }
      : { apiPort: IMAGE_API_PORT, hostAlias: 'host.docker.internal' }),
    // Where the developer reaches it: the published port, for its banner.
    publicUrl: `http://127.0.0.1:${opts.port}`,
    packDir: RUNTIME_PACK_DIR,
    databaseUrl: databaseUrlFrom(opts.databaseUrl, network),
    tenantId: opts.tenantId,
    token: opts.token,
    seedUserId: opts.userId,
    packService: opts.packService,
    ...(opts.localEnvFiles !== undefined && { localEnvFiles: opts.localEnvFiles }),
    corsOrigins: opts.corsOrigins ?? [],
    ...(opts.publicRunTokenKeyPath !== undefined && {
      publicTokenKeyPath: RUNTIME_PUBLIC_TOKEN_KEY,
    }),
    ...(opts.exportSigningKeyPath !== undefined && {
      exportSigningKeyPath: RUNTIME_EXPORT_SIGNING_KEY,
    }),
    ...(googleCredentials !== undefined && { googleCredentialsPath: RUNTIME_GOOGLE_CREDENTIALS }),
    // kindgi dev reads the container's output as records and shows them.
    log: { ...opts.logLevels, KINDGI_LOG_FORMAT: 'json' },
    shellReferences: await shellReferencesOf({
      packDir: opts.packDir,
      ...(opts.localEnvFiles !== undefined && { localEnvFiles: opts.localEnvFiles }),
      shellEnv: opts.hostEnv,
    }),
  });
  const envFile = runtimeEnvPath(opts.packDir);
  await writeRuntimeEnv(envFile, env);

  const runtime = await startRuntimeContainer({
    image: opts.runtimeImage,
    packDir: opts.packDir,
    envFile,
    network,
    hostPort: opts.port,
    ...(googleCredentials !== undefined && { googleCredentials }),
    ...(opts.publicRunTokenKeyPath !== undefined && {
      publicTokenKey: opts.publicRunTokenKeyPath,
    }),
    ...(opts.exportSigningKeyPath !== undefined && {
      exportSigningKey: opts.exportSigningKeyPath,
    }),
    onLog: opts.onLog ?? (() => undefined),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  try {
    const project = await fetch(`${runtime.baseUrl}/v1/projects/default`, {
      headers: { authorization: `Bearer ${opts.token}` },
    });
    const body = (await project.json()) as { readonly id?: string };
    if (!project.ok || typeof body.id !== 'string') {
      throw new Error(`the runtime has no default project (${project.status})`);
    }
    return {
      baseUrl: runtime.baseUrl,
      port: opts.port,
      tenantId: opts.tenantId,
      userId: opts.userId,
      defaultProjectId: body.id,
      token: opts.token,
      banner: runtime.banner,
      consoleMounted: true,
      shutdown: () => runtime.stop(),
    };
  } catch (err) {
    await runtime.stop();
    throw err;
  }
}

/**
 * A runtime the developer runs themselves (`--runtime-url`), typically
 * from source: write `runtime.env` with this machine's paths (the server
 * binds loopback, no alias), then wait until the runtime at the URL
 * serves and takes this session's dev token. Its lifetime isn't ours:
 * `shutdown` leaves it running.
 */
export async function attachToRuntimeReal(
  opts: StartApiServerOptions & { readonly runtimeUrl: string },
): Promise<RunningApiServer> {
  const progress = opts.onProgress ?? (() => undefined);
  const url = new URL(opts.runtimeUrl);
  const baseUrl = url.origin;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const googleCredentials = opts.googleCredentialsPath;
  const envFile = runtimeEnvPath(opts.packDir);
  await writeRuntimeEnv(
    envFile,
    buildRuntimeEnv({
      apiPort: port,
      apiHost: '127.0.0.1',
      publicUrl: baseUrl,
      packDir: opts.packDir,
      databaseUrl: opts.databaseUrl,
      tenantId: opts.tenantId,
      token: opts.token,
      seedUserId: opts.userId,
      packService: opts.packService,
      ...(opts.localEnvFiles !== undefined && { localEnvFiles: opts.localEnvFiles }),
      corsOrigins: opts.corsOrigins ?? [],
      ...(opts.publicRunTokenKeyPath !== undefined && {
        publicTokenKeyPath: opts.publicRunTokenKeyPath,
      }),
      ...(opts.exportSigningKeyPath !== undefined && {
        exportSigningKeyPath: opts.exportSigningKeyPath,
      }),
      ...(googleCredentials !== undefined && { googleCredentialsPath: googleCredentials }),
      // Its output goes to the developer's terminal, which picks the format.
      ...(opts.logLevels !== undefined && { log: opts.logLevels }),
      shellReferences: await shellReferencesOf({
        packDir: opts.packDir,
        ...(opts.localEnvFiles !== undefined && { localEnvFiles: opts.localEnvFiles }),
        shellEnv: opts.hostEnv,
      }),
    }),
  );
  progress(`Waiting for the Kindgi runtime at ${baseUrl}.`);
  progress(`  Start it with the settings in ${envFile} as its environment.`);
  const deadline = Date.now() + 10 * 60_000;
  let project: Response | undefined;
  for (;;) {
    if (opts.signal?.aborted === true) throw new RuntimeStartStopped();
    const healthy = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (healthy) {
      project = await fetch(`${baseUrl}/v1/projects/default`, {
        headers: { authorization: `Bearer ${opts.token}` },
      });
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`nothing served at ${baseUrl} within 10 minutes`);
    }
    await pauseUnlessStopped(500, opts.signal);
  }
  const body = (await project.json().catch(() => ({}))) as { readonly id?: string };
  if (!project.ok || typeof body.id !== 'string') {
    throw new Error(
      `the runtime at ${baseUrl} doesn't take this session's dev token (${project.status}): start it with the settings in ${envFile}`,
    );
  }
  const consoleServed = await fetch(`${baseUrl}/console/`)
    .then((r) => r.ok)
    .catch(() => false);
  return {
    baseUrl,
    port,
    tenantId: opts.tenantId,
    userId: opts.userId,
    defaultProjectId: body.id,
    token: opts.token,
    banner: '',
    consoleMounted: consoleServed,
    shutdown: async () => undefined,
  };
}

/** The runtime `kindgi dev` talks to: a container, or the developer's own (`--runtime-url`). */
export function startApiServerReal(opts: StartApiServerOptions): Promise<RunningApiServer> {
  return opts.runtimeUrl !== undefined
    ? attachToRuntimeReal({ ...opts, runtimeUrl: opts.runtimeUrl })
    : startApiServerContainerReal(opts);
}

/**
 * Postgres as the container reaches it. Through the alias the container
 * can't see the host's loopback, and a database connection isn't HTTP
 * (the runtime's alias covers HTTP only), so a loopback host becomes
 * `host.docker.internal` here.
 */
export function databaseUrlFrom(url: string, network: RuntimeNetwork): string {
  if (network === 'host-network') return url;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString();
}

/**
 * Run the indexer against a pack root. `runIndexer` writes an
 * `index.json` on the pack root by default; we tolerate the write and
 * read the bytes back so callers get the parsed manifest without a
 * second walk. Failures are captured as typed `IndexFailure` — the
 * function never throws.
 */
export async function runIndexerReadReal(
  packDir: string,
  outputPath: string = devIndexPath(packDir),
  options: IndexerRunOptions = {},
): Promise<IndexResult> {
  if (options.sandbox === undefined) return runIndexerUnsandboxed(packDir, outputPath, options);
  // Sandboxed, the child writes the index to the one folder in `.kindgi` it
  // may write; it's moved to where it's read from out here.
  const childOutput = join(devIndexerDir(packDir), 'index.json');
  const result = await runIndexerUnsandboxed(packDir, childOutput, {
    ...options,
    // Always a child: the in-process indexer would run the pack's code here.
    env: options.env ?? (async () => ({})),
  });
  if (result.kind !== 'ok') return result;
  await mkdir(dirname(outputPath), { recursive: true });
  await rename(childOutput, outputPath);
  return result;
}

async function runIndexerUnsandboxed(
  packDir: string,
  outputPath: string,
  options: IndexerRunOptions,
): Promise<IndexResult> {
  const code = options.code;
  const sandbox: IndexerSandbox | undefined =
    options.sandbox === undefined
      ? undefined
      : {
          sandbox: options.sandbox,
          ...(options.onNotice !== undefined && { onNotice: options.onNotice }),
        };
  if (code?.language === 'python') {
    return runPythonIndexer({
      packDir,
      outputPath,
      python: code.python,
      env: options.env !== undefined ? await options.env() : {},
      ...(options.onOutput !== undefined && { onOutput: options.onOutput }),
      ...(sandbox !== undefined && { sandbox }),
    });
  }
  if (isJvmPackCode(code)) {
    return runJavaIndexer({
      packDir,
      outputPath,
      code,
      env: options.env !== undefined ? await options.env() : {},
      ...(options.onOutput !== undefined && { onOutput: options.onOutput }),
      ...(sandbox !== undefined && { sandbox }),
    });
  }
  return indexResultOf(
    options.env !== undefined
      ? await runIndexerInChild(
          packDir,
          outputPath,
          options.env,
          options.bundleMap ?? {},
          options.onOutput,
          sandbox,
        )
      : await runIndexerReal({ packDir, outputPath }),
  );
}

/** An indexer outcome as `kindgi` reports it: counts, file errors and the written index. */
async function indexResultOf(outcome: IndexerOutcome): Promise<IndexResult> {
  if (outcome.kind === 'err') {
    const err = outcome.error;
    return {
      kind: 'err',
      code: err.code,
      message: err.message,
      ...(err.filePath !== undefined && { filePath: err.filePath }),
    };
  }
  const report = outcome.value;
  let index: unknown;
  try {
    const raw = await readFile(report.outputPath, 'utf8');
    index = JSON.parse(raw);
  } catch (readErr) {
    return {
      kind: 'err',
      code: 'index-read-failed',
      message: `Indexer succeeded but reading ${report.outputPath} failed: ${(readErr as Error).message}`,
    };
  }
  return {
    kind: 'ok',
    packId: report.packId,
    packVersion: report.packVersion,
    counts: report.counts,
    fileErrors: report.fileErrors.map((e) => ({
      code: e.code,
      message: e.message,
      ...(e.filePath !== undefined && { filePath: e.filePath }),
    })),
    // A Python or JVM indexer from an older SDK sends no `warnings`.
    warnings: (report.warnings ?? []).map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.filePath !== undefined && { filePath: w.filePath }),
    })),
    index,
  };
}

/**
 * Watch the pack's discovery patterns for changes. Watches each
 * pattern's static prefix (`kindgi/tools` for `kindgi/tools/**\/*.ts`) —
 * never the whole host repo when the pack is embedded in an app — and
 * fires only for paths a pattern matches, so the indexer's own output
 * and unrelated files never trigger a re-index. `patterns` defaults to
 * the indexer's `DEFAULT_DISCOVERY`.
 *
 * Uses `node:fs.watch({ recursive: true })` — dependency-free — with a
 * scan behind it (`scan-backstop.ts`): FSEvents can drop events under
 * load, so the same folders and files are also scanned every second.
 * Windows behavior is a known-good path per the Node docs but not
 * exercised in CI.
 *
 * On macOS (`share`) the events come from one recursive watch on the pack
 * directory, shared with the pack's other watchers (`shared-watch.ts`):
 * closing a handle per root held the event loop for seconds. Elsewhere
 * each discovery root has its own recursive watch and the env files'
 * folders their own; an env file outside the pack directory has its own
 * either way.
 *
 * A single debounce timer is shared across every event → the callback
 * fires at most once per debounce window. Roots that don't exist yet
 * are skipped.
 *
 * `watch` is where the events come from (`node:fs/promises`'s by
 * default); a test passes its own to drive the events deterministically.
 */
export async function watchPackReal(
  packDir: string,
  onChange: () => void,
  opts: {
    readonly debounceMs?: number;
    readonly patterns?: readonly string[];
    readonly files?: readonly string[];
    readonly watch?: WatchEvents;
    /** How often the watched files are also scanned. */
    readonly scanIntervalMs?: number;
    /** Test seam: what the watched files are now (`scanSignature`). */
    readonly scan?: () => Promise<string>;
    /** One watch on the pack directory, shared (default: on macOS). */
    readonly share?: boolean;
    /**
     * A watch failed (its folder removed, too many open files): the scan
     * behind it goes on, and `onChange` fires once so the refresh looks.
     */
    readonly onWatchFailed?: (error: unknown) => void;
  } = {},
): Promise<WatchHandle> {
  const watchEvents = opts.watch ?? watch;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const patterns = opts.patterns ?? Object.values(DEFAULT_DISCOVERY);
  const matches = createGlobMatcher(patterns);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const fire = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) return;
      // Acting on the files as they are now: the scan fires only for later changes.
      void backstop.mark();
      try {
        onChange();
      } catch {
        // onChange is caller-owned; swallow to keep the watcher alive.
      }
    }, debounceMs);
  };

  const roots = discoveryRoots(patterns);
  const backstop: ScanBackstop = await startScanBackstop({
    scan:
      opts.scan ??
      (() =>
        scanSignature({
          folders: roots.map((root) => ({
            abs: root === '' ? packDir : join(packDir, root),
            rel: root,
          })),
          includes: matches,
          files: opts.files ?? [],
        })),
    intervalMs: opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
    onChange: fire,
  });

  const spec: PackWatchSpec = {
    watchEvents,
    packDir,
    roots,
    matches,
    files: opts.files ?? [],
    fire,
    failed: (error) => {
      if (closed) return;
      opts.onWatchFailed?.(error);
      fire();
    },
    isClosed: () => closed,
  };
  const watches = await ((opts.share ?? SHARE_WATCH_BY_DEFAULT) ? watchShared : watchPerRoot)(spec);

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      backstop.stop();
      await watches.close();
    },
  };
}

/** What a pack's watch reports to, and on. */
interface PackWatchSpec {
  readonly watchEvents: WatchEvents;
  readonly packDir: string;
  readonly roots: readonly string[];
  readonly matches: (relPath: string) => boolean;
  /** Single files (the env files). */
  readonly files: readonly string[];
  readonly fire: () => void;
  /** A watch failed: say so (`onWatchFailed`), and fire. */
  readonly failed: (error: unknown) => void;
  readonly isClosed: () => boolean;
}

/** The watches a pack's watcher holds open, closed together. */
interface PackWatches {
  close(): Promise<void>;
}

/**
 * Shared (macOS): the pack directory's one watch (`shared-watch.ts`); the
 * env files in it come with it, one outside it has a watch of its own.
 */
async function watchShared(spec: PackWatchSpec): Promise<PackWatches> {
  const inPack = new Set<string>();
  const outside: string[] = [];
  for (const file of spec.files) {
    const rel = relative(spec.packDir, file);
    if (rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) {
      inPack.add(rel.split(sep).join('/'));
    } else outside.push(file);
  }
  const unsubscribe = directoryWatches(spec.watchEvents).subscribe(
    spec.packDir,
    (rel) => {
      if (
        !spec.isClosed() &&
        packEventCounts(spec.packDir, rel, spec.roots, spec.matches, inPack)
      ) {
        spec.fire();
      }
    },
    spec.failed,
  );
  const single = await watchSingleFiles(spec, outside);
  return {
    async close() {
      unsubscribe();
      await single.close();
    },
  };
}

/** Per root: each discovery root a recursive watch of its own, and the env files' folders. */
async function watchPerRoot(spec: PackWatchSpec): Promise<PackWatches> {
  const controllers: AbortController[] = [];
  const watchers: Promise<void>[] = [];
  for (const root of spec.roots) {
    const abs = root === '' ? spec.packDir : join(spec.packDir, root);
    if (!(await isDirectory(abs))) continue;
    const controller = new AbortController();
    controllers.push(controller);
    watchers.push(
      consumeWatch(
        spec.watchEvents,
        abs,
        root,
        controller.signal,
        spec.matches,
        spec.fire,
        spec.isClosed,
        spec.failed,
      ),
    );
  }
  const single = await watchSingleFiles(spec, spec.files);
  return {
    async close() {
      await Promise.all([abortAll(controllers, watchers), single.close()]);
    },
  };
}

/**
 * Single files (the env files): watch each one's directory, not
 * recursively, and fire for that name only — so an env file that
 * doesn't exist yet counts once it's created.
 */
async function watchSingleFiles(
  spec: PackWatchSpec,
  files: readonly string[],
): Promise<PackWatches> {
  const controllers: AbortController[] = [];
  const watchers: Promise<void>[] = [];
  for (const [dir, names] of filesByDirectory(files)) {
    if (!(await isDirectory(dir))) continue;
    const controller = new AbortController();
    controllers.push(controller);
    watchers.push(
      consumeFileWatch(
        spec.watchEvents,
        dir,
        names,
        controller.signal,
        spec.fire,
        spec.isClosed,
        spec.failed,
      ),
    );
  }
  return { close: () => abortAll(controllers, watchers) };
}

async function abortAll(
  controllers: readonly AbortController[],
  watchers: readonly Promise<void>[],
): Promise<void> {
  for (const c of controllers) {
    try {
      c.abort();
    } catch {
      // Older Node builds may throw synchronously — ignore.
    }
  }
  await Promise.allSettled(watchers);
}

export type { WatchEvents } from './shared-watch.js';

/**
 * Whether an event on the pack directory's shared watch counts: an env
 * file, or under a discovery root (the cheap check, first: the shared
 * watch also sees `node_modules`, `.git` and the dev index), a file a
 * pattern matches or a folder moved in or out. An event without a file
 * name counts, as in `consumeWatch`.
 */
function packEventCounts(
  packDir: string,
  rel: string | undefined,
  roots: readonly string[],
  matches: (relPath: string) => boolean,
  envFiles: ReadonlySet<string>,
): boolean {
  if (rel === undefined) return true;
  if (envFiles.has(rel)) return true;
  if (!roots.some((root) => root === '' || rel === root || rel.startsWith(`${root}/`))) {
    return false;
  }
  if (matches(rel)) return true;
  return isFolderName(rel) && !isRootEcho(packDir, rel);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fsStat(path)).isDirectory();
  } catch {
    return false;
  }
}

function filesByDirectory(files: readonly string[]): Map<string, Set<string>> {
  const byDir = new Map<string, Set<string>>();
  for (const file of files) {
    const names = byDir.get(dirname(file)) ?? new Set<string>();
    names.add(basename(file));
    byDir.set(dirname(file), names);
  }
  return byDir;
}

/** Consume one directory watch in the background, firing for `names` only. */
async function consumeFileWatch(
  watchEvents: WatchEvents,
  dir: string,
  names: ReadonlySet<string>,
  signal: AbortSignal,
  fire: () => void,
  isClosed: () => boolean,
  failed: (error: unknown) => void,
): Promise<void> {
  try {
    for await (const evt of watchEvents(dir, { signal })) {
      if (evt.filename !== null && evt.filename !== undefined && names.has(evt.filename)) fire();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ABORT_ERR' && code !== 'ERR_ABORT' && !isClosed()) failed(err);
  }
}

/**
 * Consume one recursive watch in the background. An event fires only
 * when its path (relative to the pack root) matches a discovery
 * pattern; an event without a filename fires conservatively.
 */
/** An event named after the watched folder itself, for no child of that name. */
function isRootEcho(abs: string, filename: string): boolean {
  return filename === basename(abs) && !existsSync(join(abs, filename));
}

/** A path whose last segment has no extension: a folder (or one that was there). */
function isFolderName(relPath: string): boolean {
  const last = relPath.split('/').at(-1) ?? '';
  return last !== '' && !last.includes('.');
}

async function consumeWatch(
  watchEvents: WatchEvents,
  abs: string,
  root: string,
  signal: AbortSignal,
  matches: (relPath: string) => boolean,
  fire: () => void,
  isClosed: () => boolean,
  failed: (error: unknown) => void,
): Promise<void> {
  try {
    for await (const evt of watchEvents(abs, { recursive: true, signal })) {
      if (evt.filename === null || evt.filename === undefined) {
        fire();
        continue;
      }
      const rel = [root, evt.filename.split(sep).join('/')].filter((p) => p !== '').join('/');
      // A folder moved in or out (an editor's delete moves it to the
      // trash) is one event for the folder, not one per file: fire for
      // those too. The callback re-collects the entries and does nothing
      // when they didn't change. macOS also reports the watched folder's
      // own creation, named after it; that one isn't a primitive folder.
      if (matches(rel)) fire();
      else if (isFolderName(rel) && !isRootEcho(abs, evt.filename)) fire();
    }
  } catch (err) {
    // AbortError is expected on close(); anything else is a real
    // filesystem failure we surface via a synthetic change so the
    // command's re-index reports it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ABORT_ERR' && code !== 'ERR_ABORT' && !isClosed()) failed(err);
  }
}

// -----------------------------------------------------------------------------
// Auto-start services (`kindgi dev` — no KINDGI_DATABASE_URL set path)
// -----------------------------------------------------------------------------

/**
 * Absolute path to the bundled `docker-compose.dev.yml` shipped with
 * `@kindgi/cli`. Resolved from `import.meta.url` so it works both when
 * loaded from `dist/` in a published package and from `src/` during
 * development.
 */
function bundledComposeFilePath(): string {
  // `import.meta.url` here resolves to `dist/dev/defaults.js` (built)
  // or `src/dev/defaults.ts` (dev). The compose file lives alongside
  // this module in both locations.
  return fileURLToPath(new URL('./docker-compose.dev.yml', import.meta.url));
}

/**
 * Detect whether `docker compose` is invokable. Returns `undefined`
 * when available; a human-readable reason otherwise. Used to decide
 * between `docker compose` and plain `docker` for the bundled services.
 */
async function detectDockerCompose(run: DockerRunner): Promise<string | undefined> {
  const version = await run(['compose', 'version']);
  if (version.code === 0) return undefined;
  if (version.code === null) return `docker CLI not available: ${version.stderr}`;
  return `\`docker compose version\` exited with code ${version.code}`;
}

/**
 * Whether plain `docker` works: the CLI is installed and the engine
 * answers. Returns `undefined` when it does; why not otherwise.
 */
async function detectDocker(run: DockerRunner): Promise<string | undefined> {
  const version = await run(['version', '--format', '{{.Server.Version}}']);
  if (version.code === 0) return undefined;
  const detail = version.stderr.trim().split('\n').at(-1) ?? '';
  return `Docker isn't available${detail === '' ? '' : `: ${detail}`}`;
}

/** The compose project every `kindgi dev` shares; its named volumes hold the dev data. */
const COMPOSE_PROJECT = 'kindgi-dev';

/** The services `up --wait` waits on: Postgres only (OpenFGA and MinIO aren't wired in dev). */
const LONG_RUNNING_SERVICES = ['postgres'] as const;

/** Run `docker compose` against the bundled compose file, in the `kindgi-dev` project. */
function compose(run: DockerRunner, args: readonly string[]): Promise<DockerOutcome> {
  return run(['compose', '-f', bundledComposeFilePath(), '-p', COMPOSE_PROJECT, ...args]);
}

function composeFailure(step: string, outcome: DockerOutcome): string {
  const detail = outcome.stderr.trim().split('\n').slice(-5).join('\n');
  return `\`docker compose ${step}\` failed (exit ${outcome.code ?? 'spawn error'})${detail === '' ? '' : `: ${detail}`}`;
}

/** The bundled Postgres's URL, on this machine, at its published host port. */
function bundledDatabaseUrl(port: number): string {
  return `postgres://kindgi:kindgi_dev_only@127.0.0.1:${port}/kindgi?sslmode=disable`;
}

/**
 * Boot the bundled services with plain `docker compose`, in the
 * `kindgi-dev` project:
 *
 *   1. `up -d --wait` Postgres, which waits for its healthcheck;
 *   2. read its published port back.
 *
 * Without compose (a Docker engine without the plugin), the same
 * Postgres starts with plain `docker` (`postgres-container.ts`): the
 * same names, so the data is shared whichever way it was started.
 * `unavailable` only when docker itself doesn't work.
 *
 * Not testcontainers: its reaper (Ryuk) is handed the compose project
 * and, when the process exits, deletes everything labelled with it —
 * the named volumes too — so every restart came up empty. The data in
 * the named volumes now survives `kindgi dev` restarts, as the
 * monorepo's own dev services do (`docker compose up -d --wait`).
 * Every `kindgi dev` on the machine shares them, so nothing here removes
 * them; to wipe all dev data, `docker compose -p kindgi-dev down -v`.
 * Containers left running by a killed `kindgi dev` are picked up by the
 * next boot.
 */
export async function startServicesReal(
  options: { readonly recreate: boolean },
  run: DockerRunner = docker,
): Promise<StartServicesResult> {
  const reason = await detectDockerCompose(run);
  if (reason !== undefined) {
    const noDocker = await detectDocker(run);
    if (noDocker !== undefined) return { kind: 'unavailable', reason: noDocker };
    return startPostgresWithDocker(options, run);
  }

  // An existing container is reused as it is unless asked: recreating it
  // (a changed definition) drops every other kindgi dev's connection.
  const up = await compose(run, [
    'up',
    '-d',
    '--wait',
    ...(options.recreate ? [] : ['--no-recreate']),
    ...LONG_RUNNING_SERVICES,
  ]);
  if (up.code !== 0) return { kind: 'error', message: composeFailure('up', up) };
  const published = await compose(run, ['port', 'postgres', '5432']);
  const port = published.code === 0 ? hostPortOf(published.stdout) : undefined;
  if (port === undefined) {
    return { kind: 'error', message: composeFailure('port postgres 5432', published) };
  }

  const handle: StartedServicesHandle = {
    databaseUrl: bundledDatabaseUrl(port),
    services: ['postgres'],
    startedWith: 'docker compose',
    projectDatabases: createProjectDatabases({
      run: bundledSqlRunner(run),
      baseUrl: bundledDatabaseUrl(port),
    }),
  };

  return { kind: 'ok', handle };
}

/**
 * The bundled Postgres with plain `docker`, as the compose file defines
 * it. An existing container is reused as it is, so `--recreate-services`
 * (a compose feature) can't apply: the developer is told how to recreate
 * it by hand.
 */
async function startPostgresWithDocker(
  options: { readonly recreate: boolean },
  run: DockerRunner,
): Promise<StartServicesResult> {
  let spec: PostgresContainerSpec;
  try {
    spec = postgresSpecFromCompose(
      await readFile(bundledComposeFilePath(), 'utf8'),
      COMPOSE_PROJECT,
    );
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  const started = await startPostgresContainer(spec, run);
  if (started.kind === 'error') return started;
  const notes =
    options.recreate && started.container !== 'created'
      ? [
          `--recreate-services needs docker compose: the existing ${spec.name} is reused as it is. To recreate it, remove it (docker rm -f ${spec.name}; its data stays in the ${spec.volume.name} volume) and run kindgi dev again.`,
        ]
      : [];
  return {
    kind: 'ok',
    handle: {
      databaseUrl: bundledDatabaseUrl(started.port),
      services: ['postgres'],
      startedWith: 'docker',
      ...(notes.length > 0 && { notes }),
      projectDatabases: createProjectDatabases({
        run: bundledSqlRunner(run),
        baseUrl: bundledDatabaseUrl(started.port),
      }),
    },
  };
}

/** Default wiring used by the `kindgi dev` command in production. */
export const REAL_DEV_RUNNERS: DevRunners = {
  startApiServer: startApiServerReal,
  runIndexer: runIndexerReadReal,
  createPackBuilder: createPackBuilderReal,
  createPackService: createPackServiceReal,
  detectSandbox: () => detectDevSandbox(process.platform, probeReal),
  checkPackPython,
  checkPackJvm,
  publishIndex: publishIndexReal,
  watchPack: watchPackReal,
  startServices: startServicesReal,
  runtimePortInUse: runtimePortInUseReal,
};

// Named re-export for tests that want to poke a single seam.
export const _internals = {
  fsWatch: watch,
  runIndexer: runIndexerReal,
} as const;

// re-export FSWatcher type for callers that want to name it.
export type { FSWatcher };
