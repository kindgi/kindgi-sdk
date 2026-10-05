// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service process: `node dist/pack-service/main.js
 * [--index <path>] [--module-root <dir>] [--bundle-map <path>]
 * [--host <address>]` (package export
 * `@kindgi/handler-runtime/pack-service-main`).
 *
 * Configuration (arguments win over environment):
 *   - index:        `--index`, else `KINDGI_PACK_INDEX`, else `/app/index.json`
 *   - module root:  `--module-root`, else the index's directory — where
 *                   the index's module paths resolve
 *   - bundle map:   `--bundle-map` (optional) — a build's map of each
 *                   source path the index names to its bundle, relative
 *                   to the module root (`kindgi build` writes
 *                   `dist/bundle-map.json`): modules load from the bundles
 *   - token:        `KINDGI_PACK_SERVICE_TOKEN` (required)
 *   - concurrency:  `KINDGI_PACK_SERVICE_MAX_CONCURRENCY` (default 32)
 *   - env check:    `KINDGI_PACK_ENV_CHECK`, `strict` (default) | `warn`:
 *                   whether a required env name the index declares and the
 *                   process lacks keeps the service from being ready
 *   - port:         `PORT` (platform convention; default 8080; `0` picks one)
 *   - host:         `--host`, else every interface (a container platform
 *                   such as Cloud Run needs that); a local supervisor
 *                   passes `127.0.0.1`
 *
 * Boot fails (exit 1, listing every problem) when the index can't be
 * read, a module it names is missing, or a module fails to import — so a
 * broken build never becomes ready. SIGTERM drains in-flight calls
 * (readyz answers 503 meanwhile) and exits 0.
 *
 * Logs are JSON lines on stderr. The `listening` line carries the bound
 * port, for callers that start it with `PORT=0`.
 */

import { access, readFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PACK_SERVICE_TOKEN_VAR, parsePackServiceToken } from '@kindgi/env-schema';

import { isProcessEntrypoint } from '../entrypoint.js';
import type { Index } from '../kindgi-index.js';
import { INDEX_ENVELOPE_VERSION, readBundleMap } from '../kindgi-index.js';
import { PACK_ENV_CHECK_VAR, type PackEnvCheck, parsePackEnvCheck } from '../pack-env.js';
import { type PackService, type PackServiceLogEvent, createPackService } from './service.js';

export interface PackServiceConfig {
  readonly indexPath: string;
  readonly moduleRoot: string;
  /** A build's bundle map (source path → bundle path under `moduleRoot`). */
  readonly bundleMapPath?: string;
  readonly token: string;
  readonly port: number;
  /** The listen address. Absent: every interface. */
  readonly host?: string;
  readonly maxConcurrency?: number;
  /** Default `strict`. */
  readonly envCheck?: PackEnvCheck;
}

type ConfigOutcome =
  | { readonly kind: 'ok'; readonly value: PackServiceConfig }
  | { readonly kind: 'err'; readonly problems: readonly string[] };

/** Read the process configuration from arguments and environment. */
export function readPackServiceConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ConfigOutcome {
  const arg = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const problems: string[] = [];
  const indexPath = resolve(arg('--index') ?? env.KINDGI_PACK_INDEX ?? '/app/index.json');
  const moduleRoot = resolve(arg('--module-root') ?? dirname(indexPath));
  const bundleMap = arg('--bundle-map');
  if (bundleMap === '') problems.push('--bundle-map needs a path');
  const host = arg('--host');
  if (host === '') problems.push('--host needs an address');
  // Read as the server reads it: without surrounding whitespace.
  let token: string | undefined;
  try {
    token = parsePackServiceToken(env[PACK_SERVICE_TOKEN_VAR]);
    if (token === undefined) problems.push(`${PACK_SERVICE_TOKEN_VAR} is required`);
  } catch (err) {
    problems.push((err as Error).message);
  }
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push(`PORT must be a port number, got ${JSON.stringify(env.PORT)}`);
  }
  const rawConcurrency = env.KINDGI_PACK_SERVICE_MAX_CONCURRENCY;
  const maxConcurrency = rawConcurrency === undefined ? undefined : Number(rawConcurrency);
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) {
    problems.push('KINDGI_PACK_SERVICE_MAX_CONCURRENCY must be a positive integer');
  }
  const envCheck = parsePackEnvCheck(env[PACK_ENV_CHECK_VAR]);
  if (envCheck.kind === 'err') problems.push(envCheck.message);
  if (problems.length > 0 || envCheck.kind === 'err' || token === undefined) {
    return { kind: 'err', problems };
  }
  return {
    kind: 'ok',
    value: {
      indexPath,
      moduleRoot,
      ...(bundleMap && { bundleMapPath: resolve(bundleMap) }),
      token,
      port,
      ...(host && { host }),
      ...(maxConcurrency !== undefined && { maxConcurrency }),
      envCheck: envCheck.value,
    },
  };
}

/** How long SIGTERM lets in-flight calls finish (sized for Cloud Run's 10 s SIGTERM→SIGKILL window). */
export const PACK_SERVICE_DRAIN_MS = 8_000;

export interface RunningPackService {
  readonly service: PackService;
  readonly server: Server;
  readonly port: number;
  /** Drain in-flight calls (up to `graceMs`), then stop listening. */
  stop(graceMs?: number): Promise<void>;
}

type StartOutcome =
  | { readonly kind: 'ok'; readonly value: RunningPackService }
  | { readonly kind: 'err'; readonly problems: readonly string[] };

/** Load the index, check and prewarm every module, then listen. */
export async function startPackService(
  config: PackServiceConfig,
  logger: (event: PackServiceLogEvent | Record<string, unknown>) => void = logJson,
): Promise<StartOutcome> {
  let index: Index;
  try {
    index = JSON.parse(await readFile(config.indexPath, 'utf8')) as Index;
  } catch (cause) {
    return { kind: 'err', problems: [`Cannot read the pack index: ${describe(cause)}`] };
  }
  if (index.v !== INDEX_ENVELOPE_VERSION) {
    return {
      kind: 'err',
      problems: [`Index envelope v${String(index.v)} is not v${INDEX_ENVELOPE_VERSION}`],
    };
  }
  let bundles: Readonly<Record<string, string>> = {};
  if (config.bundleMapPath !== undefined) {
    const read = await readBundleMap(config.bundleMapPath);
    if (read.kind === 'err') return { kind: 'err', problems: [read.message] };
    bundles = read.value;
  }
  // A module the index names loads from its bundle when the build mapped it.
  const resolveModule = (modulePath: string): string => {
    const target = bundles[modulePath] ?? modulePath;
    return isAbsolute(target) ? target : resolve(config.moduleRoot, target);
  };

  const missing: string[] = [];
  const paths = [
    ...index.tools.map((t) => t.modulePath),
    ...index.guardrails.map((g) => g.checkModulePath),
  ];
  for (const p of paths) {
    await access(resolveModule(p)).catch(() => missing.push(`Missing module: ${p}`));
  }
  if (missing.length > 0) return { kind: 'err', problems: missing };

  const service = createPackService({
    index,
    resolveModule,
    token: config.token,
    ...(config.maxConcurrency !== undefined && { maxConcurrency: config.maxConcurrency }),
    ...(config.envCheck !== undefined && { envCheck: config.envCheck }),
    logger,
  });
  const failures = await service.prewarm();
  if (failures.length > 0) return { kind: 'err', problems: failures.map((f) => f.message) };

  const server = createServer(service.handle);
  await new Promise<void>((ready) =>
    config.host === undefined
      ? server.listen(config.port, ready)
      : server.listen(config.port, config.host, ready),
  );
  const port = (server.address() as AddressInfo).port;
  logger({
    kind: 'listening',
    port,
    packId: index.packId,
    artifactVersion: index.artifactVersion,
  });
  return {
    kind: 'ok',
    value: {
      service,
      server,
      port,
      async stop(graceMs = PACK_SERVICE_DRAIN_MS) {
        await service.drain(graceMs);
        // Calls have finished (or the grace ran out). What is left is an idle
        // keep-alive or a caller that went away mid-call, whose half-open
        // connection would otherwise hold `close` for seconds.
        const closed = new Promise<void>((done) => server.close(() => done()));
        server.closeAllConnections();
        await closed;
      },
    },
  };
}

/** Process entry. Resolves with the exit code. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const config = readPackServiceConfig(argv, env);
  if (config.kind === 'err') {
    logJson({ kind: 'config-invalid', problems: config.problems });
    return 1;
  }
  // The token is for the service's callers. The pack's code, loaded
  // next, runs in this process and has no use for it — and a dependency
  // that read it could call the pack's tools around the runtime.
  Reflect.deleteProperty(process.env, 'KINDGI_PACK_SERVICE_TOKEN');
  const started = await startPackService(config.value);
  if (started.kind === 'err') {
    logJson({ kind: 'boot-failed', problems: started.problems });
    return 1;
  }
  await new Promise<void>((stopped) => {
    process.once('SIGTERM', () => {
      logJson({ kind: 'draining' });
      void started.value.stop().then(stopped);
    });
  });
  logJson({ kind: 'stopped' });
  return 0;
}

function logJson(event: PackServiceLogEvent | Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

if (isProcessEntrypoint(import.meta.url)) {
  void main().then((code) => process.exit(code));
}
