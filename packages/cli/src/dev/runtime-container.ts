// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi runtime as a container under `kindgi dev`: one
 * container per pack directory, started with `docker run`, configured
 * only by `runtime.env`, with the pack directory mounted at `/pack`.
 *
 * Nothing it serves is reachable from the network:
 *   - Docker Desktop (`alias`): the API is published on the host's
 *     `127.0.0.1` only, and loopback calls from the container (the pack
 *     service, the app's webhooks) go to `host.docker.internal`.
 *   - Linux (`host-network`): the container shares the host's network,
 *     binds `127.0.0.1`, and runs as the developer's user, so files it
 *     writes into the pack stay theirs.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { lineReader } from './lines.js';
import { textLines } from './log-view.js';
import {
  RUNTIME_GOOGLE_CREDENTIALS,
  RUNTIME_PACK_DIR,
  RUNTIME_PUBLIC_TOKEN_KEY,
} from './runtime-env.js';
import {
  credentialHelperFailure,
  credentialHelperHint,
  isRegistryAuthFailure,
  registryLoginCommand,
} from './runtime-registry.js';

export type RuntimeNetwork = 'alias' | 'host-network';

/** The port the image's server listens on (its `KINDGI_API_PORT`). */
export const IMAGE_API_PORT = 4000;

export interface DockerOutcome {
  /** The exit code; `null` when `docker` couldn't be spawned. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockerRunOptions {
  /**
   * Written to the command's stdin, which is then closed. A secret (a
   * registry token) goes here, never in the arguments or the environment.
   */
  readonly stdin?: string;
}

/** Runs one `docker` command to completion: `docker` below, or a fake in tests. */
export type DockerRunner = (
  args: readonly string[],
  options?: DockerRunOptions,
) => Promise<DockerOutcome>;

/** Run one `docker` command to completion. */
export function docker(
  args: readonly string[],
  options: DockerRunOptions = {},
): Promise<DockerOutcome> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, {
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (err) => resolve({ code: null, stdout, stderr: err.message }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) {
      // `docker` may exit without reading it (a bad flag, or no `docker`
      // at all): the write's EPIPE is reported by the exit, not thrown.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}

function lastLines(text: string, n = 5): string {
  return text.trim().split('\n').slice(-n).join('\n');
}

/**
 * How this machine's Docker reaches the host: Docker Desktop (any OS)
 * can't see the host's loopback; a Linux engine can share the host
 * network.
 */
export async function detectRuntimeNetwork(): Promise<RuntimeNetwork> {
  if (process.platform !== 'linux') return 'alias';
  const info = await docker(['info', '--format', '{{.OperatingSystem}}']);
  return info.code === 0 && /Docker Desktop/i.test(info.stdout) ? 'alias' : 'host-network';
}

/** The container for this pack directory: one per pack, so two packs can run side by side. */
export function runtimeContainerName(packDir: string): string {
  return `kindgi-dev-runtime-${createHash('sha256').update(packDir).digest('hex').slice(0, 12)}`;
}

/**
 * Make sure the image is here, pulling it if not. A private image needs
 * a registry login first (`kindgi auth registry`); the error says so.
 */
export async function ensureRuntimeImage(
  image: string,
  onProgress: (line: string) => void,
): Promise<{ readonly kind: 'ok' } | { readonly kind: 'error'; readonly message: string }> {
  const present = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  if (present.code === 0) return { kind: 'ok' };
  if (present.code === null) {
    return { kind: 'error', message: `Docker isn't available: ${present.stderr}` };
  }
  onProgress(`Pulling the Kindgi runtime image ${image} (first run only)...`);
  const pulled = await docker(['pull', image]);
  if (pulled.code === 0) return { kind: 'ok' };
  const detail = lastLines(pulled.stderr);
  const helper = credentialHelperFailure(pulled.stderr);
  const auth =
    helper !== undefined
      ? `\n  ${credentialHelperHint(helper.helper)}`
      : isRegistryAuthFailure(pulled.stderr)
        ? `\n  The runtime image is in private preview: request access at contact@kindgi.com, log in with the pull credentials you receive (${registryLoginCommand(image)}), then run kindgi dev again.`
        : '';
  return { kind: 'error', message: `Couldn't pull ${image}: ${detail}${auth}` };
}

export interface RuntimeContainerOptions {
  readonly image: string;
  /** The pack directory on the host, mounted at `/pack`. */
  readonly packDir: string;
  /** The `runtime.env` file (`docker run --env-file`). */
  readonly envFile: string;
  readonly network: RuntimeNetwork;
  /** The host port the API is reached on (always on `127.0.0.1`). */
  readonly hostPort: number;
  /** Credential files mounted read-only, by host path. */
  readonly googleCredentials?: string;
  readonly publicTokenKey?: string;
  /** Every line the runtime writes, with the stream it came on. */
  readonly onLog: (line: string, stream: 'stdout' | 'stderr') => void;
  /** A stop while it starts: the container is stopped and removed, and the wait throws `RuntimeStartStopped`. */
  readonly signal?: AbortSignal;
}

export interface RunningRuntimeContainer {
  readonly name: string;
  readonly baseUrl: string;
  /** What the runtime printed until it served: its banner. */
  readonly banner: string;
  stop(): Promise<void>;
}

/** The `docker run` arguments for the runtime container. */
export function runtimeRunArgs(name: string, options: RuntimeContainerOptions): string[] {
  // No --rm: a container that stops while starting is read (its logs, how
  // it exited) before kindgi dev removes it; `stop` removes it too.
  const args = ['run', '--detach', '--name', name, '--env-file', options.envFile];
  args.push('--volume', `${options.packDir}:${RUNTIME_PACK_DIR}`);
  if (options.googleCredentials !== undefined) {
    args.push('--volume', `${options.googleCredentials}:${RUNTIME_GOOGLE_CREDENTIALS}:ro`);
  }
  if (options.publicTokenKey !== undefined) {
    args.push('--volume', `${options.publicTokenKey}:${RUNTIME_PUBLIC_TOKEN_KEY}:ro`);
  }
  if (options.network === 'host-network') {
    args.push('--network', 'host');
    // Files the runtime writes into the pack (secrets) stay the developer's.
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      args.push('--user', `${process.getuid()}:${process.getgid()}`);
    }
  } else {
    args.push('--publish', `127.0.0.1:${options.hostPort}:${IMAGE_API_PORT}`);
    // Docker Desktop provides the name; other engines get it this way.
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }
  // The image's own argument (its console), then the dev-echo provider.
  args.push(options.image, '--console-static-dir', '/app/console', '--dev-echo-provider');
  return args;
}

/** The banner ended (its `Env:` line) without the pack line: an image older than the dev settings. */
function predatesDevSettings(lines: readonly string[]): boolean {
  return (
    lines.some((l) => l.startsWith('  Env: ')) && !lines.some((l) => l.startsWith(PACK_DIR_BANNER))
  );
}

/** `kindgi dev` was stopped (Ctrl+C, SIGTERM) while it waited for the runtime. */
export class RuntimeStartStopped extends Error {
  constructor() {
    super('stopped while waiting for the Kindgi runtime');
    this.name = 'RuntimeStartStopped';
  }
}

/** Wait `ms`, or less when `signal` aborts first. */
export function pauseUnlessStopped(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The runtime lines kept in memory (`startRuntimeContainer`): the boot banner and a failure's tail. */
export const KEPT_LINES = 200;

/** How the docker CLI starts its own error lines. */
const DOCKER_DAEMON_ERROR = 'Error response from daemon: ';

/** The line every runtime that runs a `kindgi dev` pack prints. */
const PACK_DIR_BANNER = `  Pack: ${RUNTIME_PACK_DIR} `;

/**
 * Start the runtime container and wait until it serves. An earlier
 * container for the same pack (a crashed session) is replaced.
 */
export async function startRuntimeContainer(
  options: RuntimeContainerOptions,
  wait: { readonly timeoutMs?: number; readonly fetch?: typeof fetch } = {},
): Promise<RunningRuntimeContainer> {
  const name = runtimeContainerName(options.packDir);
  await docker(['rm', '--force', name]);
  const started = await docker(runtimeRunArgs(name, options));
  if (started.code !== 0) {
    throw new Error(`docker run failed: ${lastLines(started.stderr)}`);
  }

  // The runtime's latest lines as text (a record as its pretty line, the
  // JSON boot record as its banner lines), enough for the boot wait and a
  // failure's tail: a long session's lines aren't kept (they're shown as
  // they come).
  const lines: string[] = [];
  let logs: ChildProcess | undefined = spawn('docker', ['logs', '--follow', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reader = (stream: 'stdout' | 'stderr') =>
    lineReader((line) => {
      // `docker logs` prints its own errors on the same stream as the
      // container's stderr: a container that already exited gets "can not
      // get logs from container which is dead…". They aren't the runtime's.
      if (line.startsWith(DOCKER_DAEMON_ERROR)) return;
      lines.push(...textLines(line));
      if (lines.length > KEPT_LINES) lines.splice(0, lines.length - KEPT_LINES);
      options.onLog(line, stream);
    });
  const out = reader('stdout');
  const err = reader('stderr');
  logs.stdout?.setEncoding('utf8');
  logs.stderr?.setEncoding('utf8');
  logs.stdout?.on('data', (chunk: string) => out.push(chunk));
  logs.stderr?.on('data', (chunk: string) => err.push(chunk));

  // Stop following: listeners off first, so the follower's last output
  // (`docker logs --follow` can panic once its container is gone) is never
  // taken for the runtime's.
  const stopFollowing = () => {
    logs?.stdout?.removeAllListeners('data');
    logs?.stderr?.removeAllListeners('data');
    logs?.kill();
    logs = undefined;
  };

  const stop = async () => {
    stopFollowing();
    await docker(['stop', '--time', '10', name]);
    await docker(['rm', '--force', name]);
  };

  const baseUrl = `http://127.0.0.1:${options.hostPort}`;
  const doFetch = wait.fetch ?? fetch;
  const deadline = Date.now() + (wait.timeoutMs ?? 120_000);
  for (;;) {
    if (options.signal?.aborted === true) {
      // It hasn't served anything: removed at once, not stopped gracefully.
      stopFollowing();
      await docker(['rm', '--force', name]);
      throw new RuntimeStartStopped();
    }
    const healthy = await doFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.ok)
      .catch(() => false);
    // Serving, and its banner printed (the pack line comes after the URL).
    if (healthy && lines.some((l) => l.startsWith(PACK_DIR_BANNER))) break;
    const running = await docker(['inspect', '--format', '{{.State.Running}}', name]);
    if (running.code !== 0 || running.stdout.trim() !== 'true') {
      stopFollowing();
      throw await startupFailure(name, lines);
    }
    const hopeless = waitingWontHelp(options.image, lines, deadline);
    if (hopeless !== undefined) {
      await stop();
      throw hopeless;
    }
    await pauseUnlessStopped(250, options.signal);
  }
  return { name, baseUrl, banner: lines.join('\n'), stop };
}

/** Why waiting longer for a running container won't help, if it won't. */
function waitingWontHelp(
  image: string,
  lines: readonly string[],
  deadline: number,
): Error | undefined {
  // The banner ends with the `Env:` line, after the pack line. Without
  // the pack line, the image predates the runtime's development settings.
  if (predatesDevSettings(lines)) {
    return new Error(
      `${image} can't run a kindgi dev pack: it predates the runtime's development settings. Use a newer image (--runtime-image).`,
    );
  }
  if (Date.now() > deadline) {
    return new Error(
      `the Kindgi runtime didn't start serving in time:\n${lines.slice(-15).join('\n')}`,
    );
  }
  return undefined;
}

/**
 * The error for a container that stopped while starting, read whole now
 * (one that exits at once can stop before `docker logs --follow`
 * attaches), then removed.
 */
async function startupFailure(name: string, followed: readonly string[]): Promise<Error> {
  const stopped = await stoppedContainer(name);
  await docker(['rm', '--force', name]);
  return new Error(
    describeStartupStop(stopped.lines.length > 0 ? stopped.lines : followed, stopped.exit),
  );
}

/** How a stopped container ended (`docker inspect`'s State). */
export interface ContainerExit {
  readonly code?: number;
  readonly oomKilled?: boolean;
  /** Docker's own error, when it couldn't run the container's command. */
  readonly error?: string;
}

/**
 * Why the runtime container stopped before it served: how it exited, and
 * its last log lines. One that stopped before printing anything is said
 * to have done so, never an empty reason.
 */
export function describeStartupStop(lines: readonly string[], exit: ContainerExit): string {
  const how = describeExit(exit);
  if (lines.length === 0) {
    return `the Kindgi runtime container stopped while starting, before it printed anything${how}.`;
  }
  return `the Kindgi runtime container stopped while starting${how}:\n${lines.slice(-15).join('\n')}`;
}

function describeExit(exit: ContainerExit): string {
  if (exit.oomKilled === true) return ` (exit code ${exit.code ?? 137}: killed, out of memory)`;
  if (exit.code === undefined) return '';
  const meaning =
    exit.code === 137
      ? ': killed'
      : exit.code === 139
        ? ': it crashed (a segmentation fault)'
        : exit.code === 126 || exit.code === 127
          ? ": its command couldn't run"
          : '';
  const error = exit.error !== undefined && exit.error !== '' ? `; docker: ${exit.error}` : '';
  return ` (exit code ${exit.code}${meaning}${error})`;
}

/** A stopped container's whole log, in the order it was written, and how it exited. */
async function stoppedContainer(
  name: string,
): Promise<{ readonly lines: readonly string[]; readonly exit: ContainerExit }> {
  const logLines = await new Promise<string[]>((resolve) => {
    const out: string[] = [];
    const child = spawn('docker', ['logs', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    const onChunk = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line !== '' && !line.startsWith(DOCKER_DAEMON_ERROR)) out.push(line);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', () => resolve(out));
    child.on('close', () => resolve(out));
  });
  const state = await docker([
    'inspect',
    '--format',
    '{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}',
    name,
  ]);
  if (state.code !== 0) return { lines: logLines, exit: {} };
  const [code, oom, ...error] = state.stdout.trim().split('|');
  const parsed = Number.parseInt(code ?? '', 10);
  return {
    lines: logLines,
    exit: {
      ...(!Number.isNaN(parsed) && { code: parsed }),
      oomKilled: oom === 'true',
      ...(error.join('|') !== '' && { error: error.join('|') }),
    },
  };
}
