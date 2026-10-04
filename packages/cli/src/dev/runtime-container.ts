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

import {
  RUNTIME_GOOGLE_CREDENTIALS,
  RUNTIME_PACK_DIR,
  RUNTIME_PUBLIC_TOKEN_KEY,
} from './runtime-env.js';
import { isRegistryAuthFailure, registryLoginCommand } from './runtime-registry.js';

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
  const auth = isRegistryAuthFailure(pulled.stderr)
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
  /** Every line the runtime writes. */
  readonly onLog: (line: string) => void;
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
  const args = ['run', '--detach', '--rm', '--name', name, '--env-file', options.envFile];
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

  const lines: string[] = [];
  let logs: ChildProcess | undefined = spawn('docker', ['logs', '--follow', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onChunk = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line === '') continue;
      lines.push(line);
      options.onLog(line);
    }
  };
  logs.stdout?.on('data', onChunk);
  logs.stderr?.on('data', onChunk);

  const stop = async () => {
    logs?.kill();
    logs = undefined;
    await docker(['stop', '--time', '10', name]);
  };

  const baseUrl = `http://127.0.0.1:${options.hostPort}`;
  const doFetch = wait.fetch ?? fetch;
  const deadline = Date.now() + (wait.timeoutMs ?? 120_000);
  for (;;) {
    const healthy = await doFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.ok)
      .catch(() => false);
    // Serving, and its banner printed (the pack line comes after the URL).
    if (healthy && lines.some((l) => l.startsWith(PACK_DIR_BANNER))) break;
    const running = await docker(['inspect', '--format', '{{.State.Running}}', name]);
    if (running.code !== 0 || running.stdout.trim() !== 'true') {
      await stop();
      throw new Error(
        `the Kindgi runtime container stopped while starting:\n${lines.slice(-15).join('\n')}`,
      );
    }
    // The banner ends with the `Env:` line, after the pack line. Without
    // the pack line, the image predates the runtime's development settings.
    if (
      lines.some((l) => l.startsWith('  Env: ')) &&
      !lines.some((l) => l.startsWith(PACK_DIR_BANNER))
    ) {
      await stop();
      throw new Error(
        `${options.image} can't run a kindgi dev pack: it predates the runtime's development settings. Use a newer image (--runtime-image).`,
      );
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(
        `the Kindgi runtime didn't start serving in time:\n${lines.slice(-15).join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { name, baseUrl, banner: lines.join('\n'), stop };
}
