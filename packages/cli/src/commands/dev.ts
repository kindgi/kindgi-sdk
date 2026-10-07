// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev` — the local development loop.
 *
 * One command, everything on the laptop. Runs the Kindgi runtime as a
 * container (`dev/runtime-container.ts`; or attaches to one you run,
 * `--runtime-url`), discovers the pack's primitives via
 * `@kindgi/handler-runtime.runIndexer`, runs the pack's code in a local
 * pack service (the same process a deployment runs, as a child),
 * registers each primitive into the runtime via the SDK, watches the
 * four discovery folders (`tools/`, `guardrails/`, `agents/`, `flows/`)
 * and the env files, and re-indexes, restarts the pack service and
 * re-registers on change.
 *
 * v1 constraints:
 *   - Docker required for the runtime (unless `--runtime-url`), and
 *     Postgres: `kindgi dev` starts a bundled `docker-compose.dev.yml`
 *     (Postgres) with `docker compose`, or the same container with plain
 *     `docker` when compose isn't available, shared by every `kindgi dev`
 *     on the machine and left running; or set `--database-url` /
 *     `KINDGI_DATABASE_URL`.
 *   - `--watch` defaults ON. `--no-watch` runs a single boot + register
 *     cycle then exits — useful for smoke tests + CI.
 *   - A watch tick re-indexes and reloads the pack. The runtime serves
 *     the primitives from the pack's index on disk, so nothing is
 *     registered over HTTP.
 *
 * Every side effect (server boot, indexer run, filesystem watch)
 * flows through `ctx.devRunners` so tests can substitute fixtures
 * without booting Postgres or hitting the filesystem.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
  type DiscoveryConfig,
  type KindgiConfig,
  type PackLanguage,
  discoveryRoots,
  findKindgiConfig,
  packLanguage,
  resolveDiscovery,
} from '@kindgi/handler-runtime';
import {
  LOCAL_ENV_NAME,
  type PackEnv,
  displayEnvPath,
  packValues,
  readPackEnv,
  runtimeValues,
} from '@kindgi/secrets-dotenv';

import type { KindgiClient, Provider } from '@kindgi/client';
import { CORS_ORIGINS_VAR, PUBLIC_TOKEN_KEY_PATH_VAR, parseCorsOrigins } from '@kindgi/env-schema';

import type { CommandContext } from '../context.js';
import { createDevOnlyImportsCheck } from '../dev/dev-only-imports.js';
import { type PackCode, resolvePackCode } from '../dev/pack-code.js';
import { devPackEnv, devPackEnvFiles } from '../dev/pack-env.js';
import { createPackRefresher, describePackEvent } from '../dev/pack-service.js';
import { PORT_SEARCH_SPAN, firstFreePort } from '../dev/port.js';
import { type DevProject, resolveDevProject } from '../dev/project.js';
import {
  type DeclaredProvider,
  type DevProvidersTarget,
  adoptLegacyBundledEntries,
  declaredProviders,
  describeReconcile,
  devProvidersKey,
  devProvidersRecordPath,
  readOwnedProviders,
  reconcileProviders,
  writeOwnedProviders,
} from '../dev/providers.js';
import { type RegistrationReport, registerFromIndex } from '../dev/register.js';
import type {
  DevRunners,
  IndexResult,
  PackBuild,
  PackBuilder,
  RunningApiServer,
  WatchHandle,
} from '../dev/runners.js';
import { RuntimeStartStopped } from '../dev/runtime-container.js';
import { DEFAULT_RUNTIME_IMAGE } from '../dev/runtime-image.js';
import { describeEnvDiagnostics, loadLocalEnvSettings } from '../env/project-env.js';
import { PYPI_NO_BUNDLER } from '../esbuild-loader.js';
import { renderJson } from '../output.js';
import { binDisplay, cliInstall, detectBinRunner } from '../package-manager.js';
import { loadProviderPresets } from '../providers/preset-loader.js';
import { CLI_VERSION } from '../version-info.js';
import { defaultSdkSkillsRoot } from './init.js';
import { detectSkillDrift } from './skills.js';
import type { CommandResult, LeafCommand } from './types.js';

export const devCommand: LeafCommand = {
  kind: 'leaf',
  name: 'dev',
  description: 'Run the Kindgi runtime as a container + hot-reload the pack under cwd.',
  usage:
    'kindgi dev [--port <n>] [--database-url <url>] [--tenant <id>] [--dev-token <token>] [--no-watch] [--path <dir>] [--reset [--yes]] [--recreate-services] [--runtime-image <ref> | --runtime-url <url>]',
  optionSpec: {
    port: {
      type: 'string',
      description:
        "The port the runtime's API is reached on, on `127.0.0.1`. Default: `4000`, or the next free port when it's taken (another `kindgi dev`, say). A port given here that's taken is refused. Not used with `--runtime-url`.",
    },
    // The Kindgi runtime image to run (default: the one this CLI release pins).
    'runtime-image': {
      type: 'string',
      description: 'The runtime image to run. Default: the one this CLI release pins.',
    },
    // A runtime you run yourself (e.g. from source) instead of the image.
    'runtime-url': {
      type: 'string',
      description:
        "Use a runtime you run yourself, at this origin, instead of starting the container. Start it with the pack's `.kindgi/dev/runtime.env`.",
    },
    'database-url': {
      type: 'string',
      description:
        "The Postgres to use. Default: `KINDGI_DATABASE_URL` (the shell's, then the env files'), else the bundled Postgres.",
    },
    tenant: {
      type: 'string',
      description:
        "Pin the tenant. Default: the previous run's (from `.kindgirc.json`), else a new one.",
    },
    // Named `dev-token` to avoid clobbering the global `--token`
    // (which is the caller's bearer token to a remote API). In dev
    // mode, we CREATE a token for the freshly-booted api-server; this
    // flag lets the caller pin it.
    'dev-token': {
      type: 'string',
      description:
        "Pin the API token. Default: the previous run's (from `.kindgirc.json`), else a new one.",
    },
    watch: {
      type: 'boolean',
      description:
        'Re-index and reload the pack on every save. On by default; `--no-watch` turns it off.',
    },
    'no-watch': {
      type: 'boolean',
      description: 'Start, index and register once, then exit. For smoke tests and CI.',
    },
    path: {
      type: 'string',
      description:
        'The pack root, with a `kindgi.config.ts` (or `.mts`) or a `pyproject.toml` with `[tool.kindgi]`. Default: the current directory.',
    },
    // --reset: a fresh start for the project. With the bundled Postgres it
    // drops the project's database (asking first) and makes a new token;
    // a database --database-url names is never dropped.
    reset: {
      type: 'boolean',
      description:
        "Start the project fresh: drops its database in the bundled Postgres (every pack's dev data in it), after asking, and makes a new token. A database you pass with --database-url is never dropped: only the token is new.",
    },
    yes: {
      type: 'boolean',
      description: "With --reset: drop the project's database without asking (for scripts).",
    },
    // --recreate-services: let `docker compose` recreate the shared
    // Postgres if its definition changed. Default: an existing container
    // is reused as it is, so no other kindgi dev loses its database.
    // Without compose it's always reused, and the output says so.
    'recreate-services': {
      type: 'boolean',
      description:
        'Let `docker compose` recreate the bundled Postgres if its definition changed (needs compose). By default an existing container is reused.',
    },
  },
  run: async (ctx): Promise<CommandResult> => runDev(ctx),
};

/** The API's default port on `127.0.0.1`. */
export const DEFAULT_DEV_PORT = 4000;
/** Default debounce for the watcher's re-index tick. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 200;

/**
 * Render the "manual KINDGI_DATABASE_URL required" hint shown when
 * (a) the caller passed neither `--database-url` nor `KINDGI_DATABASE_URL`
 * AND (b) the auto-start path is not viable (docker isn't installed or
 * doesn't answer, or the runner isn't wired). Includes the auto-start reason
 * so the user knows what to fix.
 */
/**
 * Live progress writer. Bypasses the command's buffered stdout/stderr
 * return path so the developer sees phases as they happen — critical
 * during the first-run docker-compose bring-up (image pulls,
 * healthcheck waits) which can take 30–90s. Tests don't hit this
 * path (the `startServices` runner is unwired in DevRunners fixtures)
 * so nothing to intercept.
 */
function emitProgress(msg: string): void {
  process.stderr.write(`${stoppingLineOpen ? '\n' : ''}  ${msg}\n`);
  stoppingLineOpen = false;
}

/**
 * Shutdown is one line: "Stopping kindgi dev..." the moment the signal
 * arrives, finished with "stopped." once the runtime and the pack service
 * are down. A progress line in between (a save still being loaded) starts
 * on its own line.
 */
let stoppingLineOpen = false;

function beginStoppingLine(): void {
  process.stderr.write('  Stopping kindgi dev...');
  stoppingLineOpen = true;
}

function endStoppingLine(stopped: boolean): void {
  if (stoppingLineOpen) process.stderr.write(stopped ? ' stopped.\n' : '\n');
  else if (stopped) process.stderr.write('  kindgi dev stopped.\n');
  stoppingLineOpen = false;
}

/**
 * Run an async work function while emitting a heartbeat every
 * `intervalMs` so the user sees the seconds ticking during long
 * operations (docker pulls, healthcheck waits). The heartbeat clears
 * as soon as the work resolves or rejects.
 */
async function withHeartbeat<T>(
  label: string,
  intervalMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    process.stderr.write(`  ⋯ ${label} (${elapsed}s elapsed)\n`);
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(tick);
  }
}

function renderMissingDbHint(reason: string): string {
  return `kindgi dev needs Postgres, and couldn't start the bundled one: ${reason}\n\nOptions:\n  1. Install Docker (Docker Desktop, or Docker Engine on Linux) and make sure it runs: kindgi dev then starts the bundled Postgres itself, with \`docker compose\` when it's there and plain \`docker\` otherwise.\n  2. Use your own Postgres (16, with pgvector): pass --database-url=<url>, or set KINDGI_DATABASE_URL.\n`;
}

interface ResolvedDevArgs {
  readonly port: number;
  /** `--port` was given: a taken port is refused, not moved from. */
  readonly portGiven: boolean;
  /**
   * `undefined` when the caller passed neither `--database-url` nor
   * `KINDGI_DATABASE_URL` — in that case `runDev` tries `startServices` to
   * auto-start the bundled Postgres. If that also fails, error out.
   */
  readonly databaseUrl: string | undefined;
  readonly tenantId: string | undefined;
  readonly token: string | undefined;
  readonly watch: boolean;
  readonly packDir: string;
  /** `--reset`: drop the project's bundled database (asking first) and make a new token. */
  readonly reset: boolean;
  /** `--yes`: `--reset` without asking. */
  readonly yes: boolean;
  /** `--recreate-services`: let compose recreate the shared Postgres. */
  readonly recreateServices: boolean;
  /** The Kindgi runtime image (`--runtime-image`). */
  readonly runtimeImage: string;
  /** A runtime the developer runs (`--runtime-url`); no container then. */
  readonly runtimeUrl: string | undefined;
}

export async function runDev(ctx: CommandContext): Promise<CommandResult> {
  const parsed = resolveDevArgs(ctx);
  if (parsed.kind === 'error') return parsed;
  const args = parsed.args;

  const runners = pickRunners(ctx);
  if (runners.kind === 'error') return runners;
  const dev = runners.runners;

  // Confirm the pack has a kindgi.config.ts (or one of its
  // accepted extensions). Failing loud here beats a cryptic
  // config-not-found from the indexer.
  const configFile = await findKindgiConfig(args.packDir);
  if (configFile === undefined) {
    return {
      kind: 'error',
      stderr: `kindgi dev could not find a kindgi.config.ts (or a pyproject.toml with a [tool.kindgi] table) at ${args.packDir}.\nRun \`kindgi init <pack-name>\` to scaffold a pack, or pass --path=<dir> to point at an existing one.\n`,
      exitCode: 1,
    };
  }

  // The project's env files — Kindgi runtime config (`KINDGI_*`) for
  // this process, everything else for the pack's agents via the dev
  // secret binding.
  const projectEnv = await loadDevProjectEnv(ctx, args.packDir);
  if (projectEnv.kind === 'error') return projectEnv;
  // The PyPI CLI (kindgi-cli) has no TypeScript bundler: say so before anything starts.
  if (projectEnv.language === 'node' && cliInstall(ctx.env) === 'pypi') {
    return { kind: 'error', stderr: `kindgi dev: ${PYPI_NO_BUNDLER}\n`, exitCode: 1 };
  }

  const publicRunTokens = await resolveDevPublicRunTokens(ctx.env, projectEnv.runtime);
  if (publicRunTokens.kind === 'error') return publicRunTokens;

  // The providers the config declares: refused now, before anything
  // starts, when one is malformed; registered once the runtime serves.
  const configName = basename(configFile.path);
  const declared =
    projectEnv.config?.providers === undefined
      ? ({ kind: 'ok', providers: [] } as const)
      : declaredProviders(projectEnv.config, configName, await loadProviderPresets());
  if (declared.kind === 'invalid') {
    return { kind: 'error', stderr: `kindgi dev: ${declared.message}\n`, exitCode: 1 };
  }

  // The runtime's port, before anything starts. Taken without `--port`
  // (another `kindgi dev`, say): the next free one, which `.kindgirc.json`
  // then records for every client. Taken with `--port`: refused.
  const port = await pickRuntimePort(dev, args);
  if (port.kind === 'error') return port;

  // Resolve the database URL. Precedence:
  //   1. --database-url, then KINDGI_DATABASE_URL from the shell
  //      (resolved into args.databaseUrl at resolveDevArgs time).
  //   2. KINDGI_DATABASE_URL from the project's env files.
  //   3. Auto-start the bundled Postgres via
  //      `dev.startServices` when it's wired AND docker is available
  //      (`docker compose`, else plain `docker`).
  //   4. Loud error with the manual quick-start hint.
  let databaseUrl = args.databaseUrl ?? projectEnv.runtime.KINDGI_DATABASE_URL;
  if (args.databaseUrl === undefined && databaseUrl !== undefined) {
    emitProgress('using KINDGI_DATABASE_URL from the env files');
  }
  let servicesHandle: import('../dev/runners.js').StartedServicesHandle | undefined;
  if (databaseUrl === undefined) {
    if (dev.startServices === undefined) {
      return {
        kind: 'error',
        stderr: renderMissingDbHint('start-services runner not wired'),
        exitCode: 1,
      };
    }
    if (args.recreateServices) {
      emitProgress(
        '⚠ --recreate-services: the shared Postgres may be recreated; every kindgi dev on this machine using it reconnects',
      );
    }
    emitProgress('Starting Postgres...');
    emitProgress('  first-run image pull can take 30-90s; cached boots are ~5-10s');
    const outcome = await withHeartbeat('still starting services', 5000, () =>
      dev.startServices!({ recreate: args.recreateServices }),
    );
    if (outcome.kind === 'unavailable') {
      return {
        kind: 'error',
        stderr: renderMissingDbHint(outcome.reason),
        exitCode: 1,
      };
    }
    if (outcome.kind === 'error') {
      return {
        kind: 'error',
        stderr: `kindgi dev auto-started bundled services but the boot failed:\n  ${outcome.message}\n\nFalling back to manual KINDGI_DATABASE_URL is your escape hatch — set KINDGI_DATABASE_URL then re-run.\n`,
        exitCode: 1,
      };
    }
    servicesHandle = outcome.handle;
    databaseUrl = outcome.handle.databaseUrl;
    emitProgress(
      outcome.handle.startedWith === 'docker'
        ? "✓ Postgres: started with docker (docker compose isn't available)"
        : '✓ Postgres: started with docker compose',
    );
    for (const note of outcome.handle.notes ?? []) emitProgress(`⚠ ${note}`);
  }

  const kindgircPath = join(args.packDir, '.kindgirc.json');
  const persisted = await readPersistedRc(kindgircPath);

  // The bundled Postgres: one database per project (and per linked git
  // worktree), with the project's own dev tenant. `--reset` drops it,
  // after asking. A database the developer names is theirs: never dropped.
  let project: DevProject | undefined;
  const projectDatabases = servicesHandle?.projectDatabases;
  if (projectDatabases !== undefined) {
    const resolved = await (dev.resolveProject ?? resolveDevProject)({
      packDir: args.packDir,
      configured: projectEnv.config?.project,
    });
    if (resolved.kind === 'invalid') {
      return { kind: 'error', stderr: `kindgi dev: ${resolved.message}\n`, exitCode: 1 };
    }
    project = resolved.project;
    if (args.reset) {
      const confirmed = await confirmReset(dev, project, args.yes);
      if (confirmed.kind === 'error') return confirmed;
      const dropped = await projectDatabases.drop(project.database);
      if (!dropped.ok) {
        return {
          kind: 'error',
          stderr: `kindgi dev --reset: could not drop ${project.database}: ${dropped.error}\n`,
          exitCode: 1,
        };
      }
      emitProgress(`🧹 --reset: dropped ${project.database}`);
    }
    const ensured = await projectDatabases.ensure(project, CLI_VERSION);
    if (ensured.kind === 'refused' || ensured.kind === 'error') {
      return { kind: 'error', stderr: `kindgi dev: ${ensured.message}\n`, exitCode: 1 };
    }
    databaseUrl = projectDatabases.urlFor(project.database);
    emitProgress(`✓ Project: ${project.name} (${describeProjectName(project)})`);
    emitProgress(
      `✓ Database: ${project.database}${ensured.kind === 'created' ? ' (created)' : ''} in the bundled Postgres; to use your own: --database-url`,
    );
    if (ensured.kind === 'adopted') {
      emitProgress(
        `  ${project.database} was ${ensured.previousRoot}'s, a folder that's gone: it's this folder's now`,
      );
    }
    // Once, on a project's first boot with its own database: it used the
    // shared `kindgi` database before (0.1.1), whose data stays there.
    if (ensured.kind === 'created' && !args.reset && persisted.tenantId !== undefined) {
      emitProgress(
        `  This project now has its own database, ${project.database}. The old shared \`kindgi\` database is left as it is: projects on an older Kindgi still use it. Providers and reviewers are set up once per project: set them up here again.`,
      );
    }
  }
  // A fresh token on --reset (and, without a project database, a fresh tenant).
  if (args.reset) {
    try {
      await unlink(kindgircPath);
      emitProgress('🧹 --reset: removed .kindgirc.json (a new token this boot)');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        emitProgress(`  --reset: could not remove .kindgirc.json: ${(err as Error).message}`);
      }
    }
    if (projectDatabases === undefined) {
      emitProgress('  --reset: the database you gave is left as it is (never dropped)');
    }
  }
  const previous = args.reset ? {} : persisted;

  // Resolve the tenant and the bearer token BEFORE booting, so the
  // server seeds the same ones across `kindgi dev` runs: the pack's
  // registered primitives and providers stay with the tenant, and the
  // console, curl bookmarks and anything else holding the printed token
  // keep working. Each one, highest first:
  //   1. Its flag (`--tenant`, `--dev-token`).
  //   2. The previous boot's, from `.kindgirc.json` in the pack dir.
  //   3. Server-generated on this boot (the very first one, or after
  //      `--reset`, which already deleted the file), then persisted.
  // Per field: `--dev-token` alone keeps the previous tenant.
  // Start the runtime. A failed start is the loudest error path, so
  // we tear down auto-started services (if any) before returning. The
  // first boot (or the first after `--reset`) makes the tenant, token and
  // user here; they're persisted after the runtime serves.
  // With a project database, the project's tenant and user: every pack of
  // the project, and every restart, get the same ones.
  const effectiveTenantId = args.tenantId ?? project?.tenantId ?? previous.tenantId ?? randomUUID();
  const effectiveToken = args.token ?? previous.token ?? generateDevToken();
  // The user the token resolves to comes back with the tenant it
  // belongs to: what is keyed to the user (a reviewer registration)
  // survives restarts.
  const effectiveUserId =
    (effectiveTenantId === project?.tenantId ? project.userId : undefined) ??
    (effectiveTenantId === previous.tenantId ? previous.userId : undefined) ??
    randomUUID();
  // The pack's code is bundled and runs in a local pack service. It
  // starts once the pack is bundled and indexed; the api-server gets
  // its transport now.
  const packEnv = () =>
    devPackEnv({
      packDir: args.packDir,
      ...(projectEnv.localEnvFiles !== undefined && { localEnvFiles: projectEnv.localEnvFiles }),
      hostEnv: ctx.env,
    });
  const code = await resolveDevPackCode(
    dev,
    projectEnv.language,
    args.packDir,
    projectEnv.config,
    packEnv,
  );
  if (code.kind === 'error') {
    return code;
  }
  // A Node pack's imports that `kindgi build` would refuse (in
  // devDependencies only): a warning here, on boot and when the set
  // changes on a save.
  const devOnly =
    code.value.language === 'node' ? createDevOnlyImportsCheck(args.packDir) : undefined;
  const packOptions = {
    packDir: args.packDir,
    code: code.value,
    env: packEnv,
    onLog: (line: string) => emitProgress(`  [pack] ${line}`),
    onEvent: (event: Parameters<typeof describePackEvent>[0]) => {
      const line = describePackEvent(event);
      if (line !== undefined) emitProgress(line);
    },
  };
  // The front listens for the whole session; children come and go behind
  // it. It keeps the previous session's port, so a runtime started with
  // its URL (`--runtime-url`) keeps reaching it.
  let pack = dev.createPackService({
    ...packOptions,
    ...(previous.packServicePort !== undefined && { port: previous.packServicePort }),
    ...(previous.packServiceToken !== undefined && { token: previous.packServiceToken }),
  });
  let packFront: { readonly url: string; readonly port: number };
  try {
    packFront = await pack.listen();
  } catch (err) {
    if (previous.packServicePort === undefined) throw err;
    emitProgress(
      `  the pack service's port ${previous.packServicePort} is taken: using another one${args.runtimeUrl !== undefined ? ' (restart your runtime with the new runtime.env)' : ''}`,
    );
    await pack.close().catch(() => undefined);
    pack = dev.createPackService(packOptions);
    packFront = await pack.listen();
  }
  closeOnStop(pack, ctx.stopSignal);

  const builder = dev.createPackBuilder({
    packDir: args.packDir,
    patterns: projectEnv.discoveryPatterns,
    ...(configFile.format === 'module' && { configPath: configFile.path }),
    code: code.value,
    env: packEnv,
  });
  const refresher = createPackRefresher({
    dev,
    pack,
    builder,
    packDir: args.packDir,
    env: packEnv,
    code: code.value,
    ...(devOnly !== undefined && {
      onBuild: async (build) => {
        if (build.externals === undefined) return;
        for (const line of await devOnly.check(build.externals)) emitProgress(`  ${line}`);
      },
    }),
  });

  // Bundle, index and start the pack's code before the runtime: it reads
  // that index, and calls that pack service, from its first request.
  emitProgress('Bundling + indexing the pack...');
  const bootIndex = await refresher.refresh();
  emitProgress(
    args.runtimeUrl !== undefined
      ? `Using the Kindgi runtime at ${args.runtimeUrl}...`
      : `Starting the Kindgi runtime (${args.runtimeImage})...`,
  );
  let server: RunningApiServer;
  try {
    server = await withHeartbeat('still starting the runtime', 3000, () =>
      dev.startApiServer({
        port: port.port,
        databaseUrl,
        tenantId: effectiveTenantId,
        token: effectiveToken,
        userId: effectiveUserId,
        packDir: args.packDir,
        ...(projectEnv.localEnvFiles !== undefined && {
          localEnvFiles: projectEnv.localEnvFiles,
        }),
        hostEnv: ctx.env,
        packService: { url: packFront.url, token: pack.token },
        ...(publicRunTokens.keyPath !== undefined && {
          publicRunTokenKeyPath: publicRunTokens.keyPath,
        }),
        ...(publicRunTokens.corsOrigins.length > 0 && {
          corsOrigins: publicRunTokens.corsOrigins,
        }),
        runtimeImage: args.runtimeImage,
        ...(args.runtimeUrl !== undefined && { runtimeUrl: args.runtimeUrl }),
        onLog: (line) => emitProgress(`  [runtime] ${line}`),
        onProgress: emitProgress,
        ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
      }),
    );
  } catch (err) {
    await pack.close().catch(() => undefined);
    // Ctrl+C (or SIGTERM) while it waited: a stop, not a failure.
    if (err instanceof RuntimeStartStopped || ctx.stopSignal?.aborted === true) {
      return {
        kind: 'error',
        stderr: 'kindgi dev stopped before the Kindgi runtime served.\n',
        exitCode: 130,
      };
    }
    return {
      kind: 'error',
      stderr: `kindgi dev couldn't start the Kindgi runtime: ${(err as Error).message}\n`,
      exitCode: 1,
    };
  }
  emitProgress(`✓ the Kindgi runtime is serving at ${server.baseUrl}`);

  const client = ctx.clientFor(server.baseUrl, server.token);

  // Boot-time register, from the index built above.
  emitProgress('Registering primitives...');
  const bootReport =
    bootIndex.kind === 'ok'
      ? await registerFromIndex({
          index: bootIndex.index,
          apiUrl: server.baseUrl,
          token: server.token,
          client,
          fetchImpl: ctx.fetch,
          projectId: server.defaultProjectId,
          packDir: args.packDir,
        })
      : emptyReport();
  emitBootIndex(bootIndex, bootReport, discoveryRoots(projectEnv.discoveryPatterns));

  // Hints run the project's own kindgi through its package manager — or,
  // for a Python pack (no npm project), the kindgi on PATH.
  const runner = await detectBinRunner(args.packDir, code.value.language, undefined, ctx.env);
  const kindgi = (...a: string[]): string => binDisplay(runner, 'kindgi', a);
  // The runtime the providers live in: one the developer runs, else the
  // bundled Postgres's project database, else the database they named.
  const providersTarget: DevProvidersTarget =
    args.runtimeUrl !== undefined
      ? { kind: 'runtime', url: args.runtimeUrl }
      : project !== undefined
        ? { kind: 'bundled', database: project.database }
        : { kind: 'database', url: databaseUrl };
  if (providersTarget.kind === 'bundled') {
    await adoptLegacyBundledEntries(
      devProvidersRecordPath(args.packDir),
      providersTarget.database,
      server.tenantId,
    ).catch((err: unknown) => {
      emitProgress(
        `  ⚠ could not update ${join('.kindgi', 'dev', 'providers.json')}: ${(err as Error).message}. Providers this pack registered before 0.1.4 may read as not its own.`,
      );
    });
  }
  await applyDeclaredProviders({
    client,
    packDir: args.packDir,
    key: devProvidersKey(providersTarget, server.tenantId),
    declared: declared.providers,
    file: configName,
    kindgi,
    secretNames: projectEnv.secretNames,
    envFiles: projectEnv.envFilesLabel,
  });
  const providers = await registeredProviders(client);
  const registerProviderCommand = kindgi('providers', 'register', '--preset=anthropic');

  const bannerLines = renderDevBanner({
    baseUrl: server.baseUrl,
    tenantId: server.tenantId,
    token: server.token,
    providers,
    registerProviderCommand,
    packDir: args.packDir,
    bootIndex,
    bootReport,
    discoveryRoots: discoveryRoots(projectEnv.discoveryPatterns),
    ...(servicesHandle !== undefined && { autoStartedServices: servicesHandle.services }),
    corsOrigins: publicRunTokens.corsOrigins,
  });

  // Write `.kindgirc.json` to the pack root so a SECOND terminal in
  // the same directory (`cd <pack>; kindgi runs start ...`) picks up
  // the api URL + bearer token automatically. Same file the config
  // precedence in `config.ts` already reads. PERSISTS across boots by
  // default — token + tenantId from the previous boot were read +
  // reused above, so subsequent writes here are idempotent. The
  // apiUrl gets refreshed each boot in case the port changed (--port
  // flag, or the future auto-select on collision). Scaffolded
  // .gitignore excludes it so it never ends up in git. Delete via
  // `kindgi dev --reset` to force a fresh token + tenantId on the
  // next boot.
  //
  // `tenantId` persistence is load-bearing after the r1
  // named-volumes Postgres fix: without it, every boot creates a new
  // tenant row and orphans the pack's registered primitives under old
  // tenant UUIDs. Persisting keeps the "run this pack" identity
  // stable across restarts.
  let kindgircWritten = false;
  try {
    await writeFile(
      kindgircPath,
      `${JSON.stringify(
        {
          apiUrl: server.baseUrl,
          token: server.token,
          tenantId: server.tenantId as unknown as string,
          userId: server.userId,
          packServicePort: packFront.port,
          packServiceToken: pack.token,
        },
        null,
        2,
      )}\n`,
      // It holds the dev token and the pack service's token.
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(kindgircPath, 0o600);
    kindgircWritten = true;
  } catch {
    // Best effort — if the pack dir is read-only or something goes wrong,
    // don't fail boot. The user can still pass --url/--token flags.
  }

  // Emit the "you're up, here's what to do next" block live to stderr
  // so watch-mode users see it immediately. (With --no-watch, the returned
  // command result also carries bannerLines, flushed on exit; watch mode
  // ends with its one shutdown line, never the boot banner again.)
  emitProgress('');
  emitProgress('════════════════════════════════════════');
  emitProgress('  ✓ Kindgi is up');
  emitProgress('════════════════════════════════════════');
  emitProgress(`  API        ${server.baseUrl}`);
  if (project !== undefined) {
    emitProgress(`  Project    ${project.name} · database ${project.database}`);
  }
  if (server.consoleMounted === true) {
    emitProgress(`  Console    ${server.baseUrl}/console/`);
  }
  emitProgress(`  Tenant     ${server.tenantId}`);
  emitProgress(`  Token      ${server.token}`);
  if (providers !== undefined) {
    emitProgress(`  Providers  ${describeProviders(providers, registerProviderCommand)}`);
  }
  emitProgress(`  Origins    ${describeBrowserOrigins(publicRunTokens.corsOrigins)}`);
  emitProgress('');
  if (bootIndex.kind === 'ok' && bootIndex.counts.agents > 0) {
    if (kindgircWritten) {
      emitProgress('  Try it (from another terminal, cd to the pack dir first):');
    } else {
      emitProgress('  Try it (auto-config write failed — pass --url + --token flags):');
    }
    // Suggest the first agent id from the index for a concrete
    // starting-point command.
    const firstAgent = (bootIndex.index as { readonly agents?: readonly { readonly id: string }[] })
      ?.agents?.[0]?.id;
    if (firstAgent !== undefined) {
      emitProgress(
        `    ${kindgi('runs', 'start', `--agent=${firstAgent}`, `--input='{"userMessage":"hi"}'`)}`,
      );
      emitProgress(`    ${kindgi('runs', 'stream', '<run-id>')}`);
    } else {
      emitProgress(
        `    ${kindgi('runs', 'start', '--agent=<agent-id>', `--input='{"userMessage":"hi"}'`)}`,
      );
    }
    emitProgress('');
  }
  emitProgress('  Hit a framework rough edge?');
  emitProgress(
    `    echo "…" | ${kindgi('feedback', 'write', '--kind=bug', '--title="…"', '--body-stdin')}  (appends to FEEDBACK.md)`,
  );
  emitProgress('');
  await emitSkillDriftHint(args.packDir, code.value.language, kindgi('skills', 'sync'));
  if (args.watch) {
    emitProgress(`  Watching ${args.packDir}`);
    emitProgress('  Ctrl+C to stop.');
    emitProgress('');
  }

  const watchHandles: Awaited<ReturnType<DevRunners['watchPack']>>[] = [];
  let watchTicks = 0;
  let lastWatchOutcome: IndexResult | undefined;
  let lastWatchReport: RegistrationReport | undefined;
  // Refresh ticks still running. Shutdown drains these so a tick never
  // registers against a server that is already shutting down.
  const inFlightTicks = new Set<Promise<void>>();
  // Refreshes asked for while one runs collapse into one; report it once.
  const reported = new WeakSet<Promise<IndexResult>>();

  if (args.watch) {
    const onRefresh = (build?: PackBuild): void => {
      // The refresh runs asynchronously so no watcher ever blocks. Any
      // failure lands in `lastWatchOutcome` / stderr; the server stays up.
      const refreshed = refresher.refresh(build);
      if (reported.has(refreshed)) return;
      reported.add(refreshed);
      const tick = (async () => {
        watchTicks += 1;
        const startedAt = Date.now();
        const outcome = await refreshed;
        lastWatchOutcome = outcome;
        if (outcome.kind === 'ok') {
          const report = await registerFromIndex({
            index: outcome.index,
            apiUrl: server.baseUrl,
            token: server.token,
            client,
            fetchImpl: ctx.fetch,
            projectId: server.defaultProjectId,
            packDir: args.packDir,
          });
          lastWatchReport = report;
          emitWatchTick({
            elapsedMs: Date.now() - startedAt,
            counts: outcome.counts,
            fileErrors: outcome.fileErrors,
            registered: report.registered.length,
            failed: report.failed,
          });
        } else if (outcome.code === 'discovery-empty') {
          lastWatchReport = undefined;
          emitProgress('  (no primitives yet)');
        } else {
          lastWatchReport = undefined;
          emitProgress(`  ✗ refresh failed [${outcome.code}] ${outcome.message}`);
        }
      })();
      inFlightTicks.add(tick);
      void tick.finally(() => inFlightTicks.delete(tick));
    };
    // Code: esbuild rebuilds when any file a bundle read changes —
    // shared libraries outside the discovery folders included.
    // Each watcher's changes start nothing once the stop begins: the
    // watchers close while the runtime stops (see `stopDev`).
    await builder.watch(untilStopped(ctx.stopSignal, (build: PackBuild) => onRefresh(build)));
    const onWatchFailed = reportWatchFailureOnce();
    // A primitive file added or removed changes the entry points.
    watchHandles.push(
      await dev.watchPack(
        args.packDir,
        untilStopped(ctx.stopSignal, () => {
          void builder.syncEntries();
        }),
        {
          debounceMs: DEFAULT_WATCH_DEBOUNCE_MS,
          patterns: projectEnv.discoveryPatterns,
          onWatchFailed,
        },
      ),
    );
    // The env files: the same code, restarted with the new environment.
    watchHandles.push(
      await dev.watchPack(
        args.packDir,
        untilStopped(ctx.stopSignal, () => onRefresh()),
        {
          debounceMs: DEFAULT_WATCH_DEBOUNCE_MS,
          patterns: [],
          files: devPackEnvFiles(args.packDir, projectEnv.localEnvFiles),
          onWatchFailed,
        },
      ),
    );
  }

  // Watch mode: wait for the caller's abort signal (SIGINT/SIGTERM in
  // production; injected AbortController.signal in tests). Non-watch
  // mode: return immediately after boot registration.
  if (args.watch) await waitForAbort(ctx.stopSignal);
  await stopDev({
    watch: args.watch,
    watchHandles,
    builder,
    inFlightTicks,
    refresher,
    server,
    pack,
  });
  // `.kindgirc.json` is intentionally NOT deleted on exit — the
  // persisted token survives so re-boots and second-terminal
  // sessions keep working with the same bearer. `kindgi dev --reset`
  // deletes it if you want a fresh token.
  void kindgircWritten;
  // The bundled services keep running: other `kindgi dev` sessions on
  // this machine share them (see `StartedServicesHandle`).

  // The JSON summary is for scripts that ask for it (`--json`, `--raw`):
  // the boot, and in watch mode the last save's outcome — where the pack
  // stood when kindgi dev stopped.
  const summary = {
    apiUrl: server.baseUrl,
    tenantId: server.tenantId,
    token: server.token,
    port: server.port,
    watch: args.watch,
    packDir: args.packDir,
    boot: summariseOutcome(bootIndex, bootReport),
    // A Node pack's dev-only imports when kindgi dev stopped.
    ...(devOnly !== undefined && { devOnlyImports: devOnly.current() }),
    ...(args.watch && {
      watchTicks,
      ...(lastWatchOutcome !== undefined && {
        lastWatch: summariseOutcome(lastWatchOutcome, lastWatchReport ?? emptyReport()),
      }),
    }),
  };

  const stdout = ctx.globals.formatRequested ? renderJson(summary, ctx.globals.format).stdout : '';
  return {
    kind: 'ok',
    rendered: { stdout, stderr: args.watch ? '' : `${bannerLines.join('\n')}\n` },
  };
}

/**
 * Public run tokens for the browser app under development: signed with
 * the key file when `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` is set,
 * otherwise with a key made now (tokens stop working when `kindgi dev`
 * stops). `KINDGI_CORS_ORIGINS` lists the app's origins
 * (`http://localhost:3000`). Both come from the shell, then the env files,
 * like `KINDGI_DATABASE_URL`.
 */
async function resolveDevPublicRunTokens(
  shell: Readonly<Record<string, string | undefined>>,
  files: Readonly<Record<string, string>>,
): Promise<
  | {
      readonly kind: 'ok';
      /** The developer's key file, mounted into the runtime; absent: the runtime makes a key. */
      readonly keyPath: string | undefined;
      readonly corsOrigins: readonly string[];
    }
  | { readonly kind: 'error'; readonly stderr: string; readonly exitCode: number }
> {
  const pick = (name: string): string | undefined => {
    const value = shell[name] ?? files[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };
  try {
    const keyPath = pick(PUBLIC_TOKEN_KEY_PATH_VAR);
    if (keyPath !== undefined && (!isAbsolute(keyPath) || !existsSync(keyPath))) {
      throw new Error(
        `${PUBLIC_TOKEN_KEY_PATH_VAR} must be the absolute path of an existing key file. Got "${keyPath}".`,
      );
    }
    return { kind: 'ok', keyPath, corsOrigins: parseCorsOrigins(pick(CORS_ORIGINS_VAR)) };
  } catch (err) {
    return { kind: 'error', stderr: `kindgi dev: ${(err as Error).message}\n`, exitCode: 1 };
  }
}

type ProjectEnvOutcome =
  | {
      readonly kind: 'ok';
      readonly localEnvFiles: readonly string[] | undefined;
      /** `KINDGI_*` names from the env files. */
      readonly runtime: Readonly<Record<string, string>>;
      /** The pack's discovery patterns (defaults filled in) — what the watcher follows. */
      readonly discoveryPatterns: readonly string[];
      /** The language of the pack's code. */
      readonly language: PackLanguage;
      /** The loaded config (`undefined` in tests that inject none). */
      readonly config: Readonly<Record<string, unknown>> | undefined;
      /** The names the env files give the pack: the secrets `local` resolves. */
      readonly secretNames: ReadonlySet<string>;
      /** The env files `local` reads, as the boot log names them. */
      readonly envFilesLabel: string;
    }
  | (CommandResult & { readonly kind: 'error' });

/**
 * Read the project's env files for `local` and report them in the boot
 * log (names and counts only — never values).
 */
async function loadDevProjectEnv(ctx: CommandContext, packDir: string): Promise<ProjectEnvOutcome> {
  const fail = (message: string): ProjectEnvOutcome => ({
    kind: 'error',
    stderr: `kindgi dev: ${message}\n`,
    exitCode: 1,
  });
  const settings = await loadLocalEnvSettings(ctx, packDir);
  if (settings.kind === 'error') return fail(settings.message);
  if (settings.configProblem !== undefined) {
    return fail(`could not load kindgi.config.ts at ${packDir}: ${settings.configProblem}`);
  }
  let env: PackEnv;
  try {
    env = await readPackEnv({
      packDir,
      envName: LOCAL_ENV_NAME,
      ...(settings.localEnvFiles !== undefined && { localEnvFiles: settings.localEnvFiles }),
      env: ctx.env,
    });
  } catch (err) {
    return fail(`could not read the env files: ${(err as Error).message}`);
  }
  const label = (paths: readonly string[]): string =>
    paths.map((p) => displayEnvPath(packDir, p)).join(', ');
  emitProgress(
    env.present.length === 0
      ? `env files: none yet (reads ${label(env.files.read)})`
      : `✓ env files: ${label(env.present)} — ${Object.keys(packValues(env.values)).length} name(s) for the pack`,
  );
  for (const line of describeEnvDiagnostics(packDir, env.diagnostics)) emitProgress(`  ! ${line}`);
  const discovery = settings.config?.discovery;
  const language =
    settings.config !== undefined ? packLanguage(settings.config as KindgiConfig) : 'node';
  return {
    kind: 'ok',
    localEnvFiles: settings.localEnvFiles,
    runtime: runtimeValues(env.values),
    discoveryPatterns: Object.values(
      resolveDiscovery(
        typeof discovery === 'object' && discovery !== null
          ? (discovery as DiscoveryConfig)
          : undefined,
        language,
      ),
    ),
    language,
    config: settings.config,
    secretNames: new Set(Object.keys(packValues(env.values))),
    envFilesLabel: label(env.files.read),
  };
}

type RuntimePortOutcome =
  | { readonly kind: 'ok'; readonly port: number }
  | (CommandResult & { readonly kind: 'error' });

async function pickRuntimePort(
  dev: DevRunners,
  args: ResolvedDevArgs,
): Promise<RuntimePortOutcome> {
  // `--runtime-url`: the developer's runtime has its own port. Port 0: any.
  if (args.runtimeUrl !== undefined || args.port === 0 || dev.runtimePortInUse === undefined) {
    return { kind: 'ok', port: args.port };
  }
  const inUse = (port: number) => dev.runtimePortInUse!({ packDir: args.packDir, port });
  if (!(await inUse(args.port))) return { kind: 'ok', port: args.port };
  if (args.portGiven) {
    return {
      kind: 'error',
      stderr: `kindgi dev: port ${args.port} is in use. Pick another with --port, or stop what's using it.\n`,
      exitCode: 1,
    };
  }
  const free = await firstFreePort(args.port + 1, inUse);
  if (free === undefined) {
    return {
      kind: 'error',
      stderr: `kindgi dev: ports ${args.port} to ${args.port + PORT_SEARCH_SPAN} are all in use. Pick a free one with --port.\n`,
      exitCode: 1,
    };
  }
  emitProgress(`⚠ port ${args.port} is in use (another kindgi dev?): using ${free}`);
  return { kind: 'ok', port: free };
}

type DevArgsOutcome =
  | { readonly kind: 'ok'; readonly args: ResolvedDevArgs }
  | (CommandResult & { readonly kind: 'error' });

function resolveDevArgs(ctx: CommandContext): DevArgsOutcome {
  // --port
  const portRaw = ctx.options.port;
  let port = DEFAULT_DEV_PORT;
  const portGiven = typeof portRaw === 'string' && portRaw !== '';
  if (portGiven) {
    const parsedPort = Number.parseInt(portRaw, 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      return {
        kind: 'error',
        stderr: `Invalid --port: ${portRaw}. Expected an integer 0..65535.\n`,
        exitCode: 1,
      };
    }
    port = parsedPort;
  }

  // --database-url > KINDGI_DATABASE_URL
  const dbFlag = ctx.options['database-url'];
  const dbEnv = getEnv(ctx, 'KINDGI_DATABASE_URL');
  const databaseUrl =
    typeof dbFlag === 'string' && dbFlag !== ''
      ? dbFlag
      : typeof dbEnv === 'string' && dbEnv !== ''
        ? dbEnv
        : undefined;
  // databaseUrl is allowed to be undefined at resolve time. `runDev`
  // handles it: if `startServices` is wired AND docker is available,
  // auto-start the bundled Postgres and use the container URL. If not,
  // error with the manual quick-start hint.

  // --tenant / --dev-token
  const tenantFlag = ctx.options.tenant;
  const tokenFlag = ctx.options['dev-token'];
  const tenantId = typeof tenantFlag === 'string' && tenantFlag !== '' ? tenantFlag : undefined;
  const token = typeof tokenFlag === 'string' && tokenFlag !== '' ? tokenFlag : undefined;

  // --watch / --no-watch. Defaults ON for `kindgi dev`.
  const watchOn = ctx.options.watch === true;
  const watchOff = ctx.options['no-watch'] === true;
  if (watchOn && watchOff) {
    return {
      kind: 'error',
      stderr: 'Contradictory flags: --watch and --no-watch cannot both be set.\n',
      exitCode: 1,
    };
  }
  const watch = !watchOff;

  // --path — pack root. Default is cwd.
  const pathFlag = ctx.options.path;
  const rawPath = typeof pathFlag === 'string' && pathFlag !== '' ? pathFlag : ctx.cwd;
  const packDir = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  // --reset — a fresh start for the project; --yes skips its question.
  const reset = ctx.options.reset === true;
  const yes = ctx.options.yes === true;
  const recreateServices = ctx.options['recreate-services'] === true;

  // --runtime-image / --runtime-url — which runtime: an image, or one you run.
  const imageFlag = ctx.options['runtime-image'];
  const urlFlag = ctx.options['runtime-url'];
  const runtimeUrl = typeof urlFlag === 'string' && urlFlag !== '' ? urlFlag : undefined;
  if (runtimeUrl !== undefined && typeof imageFlag === 'string' && imageFlag !== '') {
    return {
      kind: 'error',
      stderr:
        '--runtime-image and --runtime-url exclude each other: an image, or a runtime you run.\n',
      exitCode: 1,
    };
  }
  if (runtimeUrl !== undefined && !/^https?:\/\/[^/]+\/?$/.test(runtimeUrl)) {
    return {
      kind: 'error',
      stderr: `Invalid --runtime-url: ${runtimeUrl}. Expected the runtime's origin, e.g. http://127.0.0.1:4000.\n`,
      exitCode: 1,
    };
  }
  const runtimeImage =
    typeof imageFlag === 'string' && imageFlag !== '' ? imageFlag : DEFAULT_RUNTIME_IMAGE;

  return {
    kind: 'ok',
    args: {
      port,
      portGiven,
      databaseUrl,
      tenantId,
      token,
      watch,
      packDir,
      reset,
      yes,
      recreateServices,
      runtimeImage,
      runtimeUrl,
    },
  };
}

type RunnersOutcome =
  | { readonly kind: 'ok'; readonly runners: DevRunners }
  | (CommandResult & { readonly kind: 'error' });

/** Where the project's name came from, for the boot line. */
function describeProjectName(project: DevProject): string {
  const from = {
    config: 'from `project` in the Kindgi config',
    repository: "the git repository's name",
    workspace: "the workspace's folder name",
    'pack folder': "the pack's folder name",
  }[project.nameFrom];
  const named =
    project.nameFrom === 'config'
      ? from
      : `${from}; set \`project\` in the Kindgi config to name it`;
  return project.worktree === undefined ? named : `${named}; git worktree ${project.worktree}`;
}

/**
 * `--reset` drops every pack's dev data in the project's database: ask
 * first. `--yes` answers for scripts; with no terminal to ask on, and no
 * `--yes`, nothing is dropped.
 */
async function confirmReset(
  dev: DevRunners,
  project: DevProject,
  yes: boolean,
): Promise<{ readonly kind: 'ok' } | (CommandResult & { readonly kind: 'error' })> {
  if (yes) return { kind: 'ok' };
  const question = `Reset project ${project.name}? This drops the database ${project.database}: every pack's dev data in it (runs, approvals, providers, secrets stored there). [y/N] `;
  if (!(dev.interactive ?? isInteractive)()) {
    return {
      kind: 'error',
      stderr: `kindgi dev --reset would drop ${project.database}, and there's no terminal to ask on. Run it with --yes to drop it.\n`,
      exitCode: 1,
    };
  }
  const answer = await (dev.confirm ?? confirmOnTerminal)(question);
  if (!answer) {
    return { kind: 'error', stderr: 'kindgi dev --reset: nothing dropped.\n', exitCode: 1 };
  }
  return { kind: 'ok' };
}

/** A person at a terminal: stdin and stderr are both TTYs. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

/** Ask a yes/no question on the terminal; only `y` or `yes` is a yes. */
async function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.question(question, resolveAnswer);
      rl.once('close', () => resolveAnswer(''));
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

function pickRunners(ctx: CommandContext): RunnersOutcome {
  if (ctx.devRunners !== undefined) return { kind: 'ok', runners: ctx.devRunners };
  return {
    kind: 'error',
    stderr:
      'Internal error: kindgi dev requires dev runners to be wired. ' +
      'Rebuild the CLI (`pnpm --filter @kindgi/cli build`).\n',
    exitCode: 1,
  };
}

/**
 * Read the persisted `.kindgirc.json` if present. Returns `undefined`
 * for any missing field — all missing cases fall back to
 * server-generated on this boot. Called at boot so the previous run's
 * token AND tenantId are reused across restarts.
 *
 * Persisting `tenantId` alongside `token` matters after the r1
 * named-volume Postgres change: without it, `seedTenant` generates a
 * fresh UUID + slug on every boot, orphaning the pack's registered
 * primitives from previous boots under old tenant rows in the
 * persisted DB.
 */
async function readPersistedRc(kindgircPath: string): Promise<{
  readonly token?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly packServicePort?: number;
  readonly packServiceToken?: string;
}> {
  try {
    const raw = await readFile(kindgircPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      readonly token?: unknown;
      readonly tenantId?: unknown;
      readonly userId?: unknown;
      readonly packServicePort?: unknown;
      readonly packServiceToken?: unknown;
    };
    return {
      ...(typeof parsed.packServiceToken === 'string' &&
        /^[A-Za-z0-9_-]{32,}$/.test(parsed.packServiceToken) && {
          packServiceToken: parsed.packServiceToken,
        }),
      ...(typeof parsed.packServicePort === 'number' &&
        Number.isInteger(parsed.packServicePort) &&
        parsed.packServicePort > 0 &&
        parsed.packServicePort < 65536 && { packServicePort: parsed.packServicePort }),
      ...(typeof parsed.token === 'string' && parsed.token.length > 0 && { token: parsed.token }),
      ...(typeof parsed.tenantId === 'string' &&
        parsed.tenantId.length > 0 && { tenantId: parsed.tenantId }),
      ...(typeof parsed.userId === 'string' &&
        parsed.userId.length > 0 && { userId: parsed.userId }),
    };
  } catch {
    return {};
  }
}

/** What the boot loaded, live: the counts and failures, no primitives yet, or the indexer's error. */
function emitBootIndex(
  bootIndex: IndexResult,
  bootReport: RegistrationReport,
  roots: readonly string[],
): void {
  if (bootIndex.kind !== 'ok') {
    // Dev stays up either way; the section says so.
    for (const line of renderIndexSection({ bootIndex, bootReport, discoveryRoots: roots })) {
      emitProgress(line.replace(/^ {2}/, ''));
    }
    return;
  }
  const c = bootIndex.counts;
  emitProgress(
    `✓ loaded: ${c.tools} tools, ${c.guardrails} guardrails, ${c.agents} agents, ${c.flows} flows`,
  );
  for (const e of bootIndex.fileErrors) {
    emitProgress(`  ⚠ indexer: ${e.filePath ?? '?'} [${e.code}] ${e.message}`);
  }
  for (const f of bootReport.failed) {
    emitProgress(`  ⚠ ${f.kind}: ${f.id} — ${f.message ?? 'unknown reason'}`);
  }
}

/**
 * The moment a stop is asked for, the pack service is closing: a child
 * that exits then (a terminal's Ctrl+C signals the whole process group,
 * the pack service included) is expected, not restarted mid-shutdown.
 */
function closeOnStop(pack: { beginClose(): void }, stopSignal: AbortSignal | undefined): void {
  if (stopSignal?.aborted === true) pack.beginClose();
  else stopSignal?.addEventListener('abort', () => pack.beginClose(), { once: true });
}

/**
 * A failed file watch (its folder removed, too many open files), said once
 * for the session: the once-a-second scan behind the watchers goes on and
 * picks up the pack's changes from then on.
 */
function reportWatchFailureOnce(): (error: unknown) => void {
  let said = false;
  return (error) => {
    if (said) return;
    said = true;
    const why = error instanceof Error ? error.message : String(error);
    emitProgress(`  ⚠ file watch failed (${why}): changes are picked up by the once-a-second scan`);
  };
}

/** `fn` until the stop begins: a change seen while stopping starts nothing. */
function untilStopped<A extends unknown[]>(
  stopSignal: AbortSignal | undefined,
  fn: (...args: A) => void,
): (...args: A) => void {
  return (...args) => {
    if (stopSignal?.aborted !== true) fn(...args);
  };
}

/**
 * Stop everything `kindgi dev` started: the refreshes in flight (drained,
 * so none registers against a server shutting down), the runtime with the
 * watchers closing meanwhile, then the pack service. In watch mode, on
 * the one shutdown line.
 */
async function stopDev(parts: {
  readonly watch: boolean;
  readonly watchHandles: readonly WatchHandle[];
  readonly builder: PackBuilder;
  readonly inFlightTicks: ReadonlySet<Promise<void>>;
  readonly refresher: { idle(): Promise<void> };
  readonly server: RunningApiServer;
  readonly pack: { close(): Promise<void> };
}): Promise<void> {
  if (parts.watch) beginStoppingLine();
  // Every step runs, whichever failed before it: the runtime container is
  // removed (`server.shutdown`) even when, say, the pack service died first.
  const failure = await runEach([
    // Nothing starts a refresh any more (the watchers' changes are ignored
    // from the stop on); drain the ones in flight.
    () => parts.builder.dispose(),
    () => Promise.allSettled(parts.inFlightTicks),
    () => parts.refresher.idle(),
    // The watchers close while the runtime's container stops: closing a
    // recursive one holds this event loop for a second or more on macOS,
    // and `docker stop` doesn't wait on it.
    () =>
      whileRunning(
        () => parts.server.shutdown(),
        parts.watchHandles.map((handle) => () => handle.close()),
      ),
    () => parts.pack.close(),
  ]);
  if (parts.watch) endStoppingLine(failure === undefined);
  if (failure !== undefined) throw failure.cause;
}

/** Start `first`, run `meanwhile` while it's under way, then wait for it; throws the first failure. */
async function whileRunning(
  first: () => Promise<unknown>,
  meanwhile: readonly (() => Promise<unknown>)[],
): Promise<void> {
  // Called now, before `meanwhile` holds the loop; settled at once, so a
  // failure while `meanwhile` runs isn't unhandled.
  const started = (async () => first())().then(
    () => undefined,
    (cause: unknown) => ({ cause }),
  );
  const meanwhileFailure = await runEach(meanwhile);
  const failure = (await started) ?? meanwhileFailure;
  if (failure !== undefined) throw failure.cause;
}

/** Run each step in turn, every one even after one fails; the first failure, if any. */
async function runEach(
  steps: readonly (() => Promise<unknown>)[],
): Promise<{ readonly cause: unknown } | undefined> {
  let first: { readonly cause: unknown } | undefined;
  for (const step of steps) {
    try {
      await step();
    } catch (cause) {
      first ??= { cause };
    }
  }
  return first;
}

/**
 * Emit a short human-readable line per watch tick so the user sees
 * that a save re-indexed + reloaded the pack. Primitives come from
 * disk, so they aren't "re-registered" per se — the neutral
 * "loaded" verb covers both paths.
 */
function emitWatchTick(input: {
  readonly elapsedMs: number;
  readonly counts: {
    readonly tools: number;
    readonly guardrails: number;
    readonly agents: number;
    readonly flows: number;
  };
  readonly fileErrors: readonly {
    readonly code: string;
    readonly message: string;
    readonly filePath?: string;
  }[];
  readonly registered: number;
  readonly failed: readonly {
    readonly kind: string;
    readonly id: string;
    readonly message?: string;
  }[];
}): void {
  const { counts, fileErrors, failed, elapsedMs, registered } = input;
  const totals = `${counts.tools} tools, ${counts.guardrails} guardrails, ${counts.agents} agents, ${counts.flows} flows`;
  if (fileErrors.length === 0 && failed.length === 0) {
    emitProgress(`  ✓ loaded ${registered} primitives (${totals}) in ${elapsedMs}ms`);
    return;
  }
  emitProgress(
    `  ⚠ loaded ${registered} of ${registered + failed.length} in ${elapsedMs}ms — ${totals}`,
  );
  for (const e of fileErrors) {
    emitProgress(`    ✗ indexer: ${e.filePath ?? '?'} [${e.code}] ${e.message}`);
  }
  for (const f of failed) {
    emitProgress(`    ✗ ${f.kind}: ${f.id} — ${f.message ?? 'unknown reason'}`);
  }
}

/**
 * Compare the pack's installed framework skills against the bundled
 * SDK versions; print a one-liner if drift is detected. Silent when
 * everything is up to date. Never fails boot — a drift-check crash
 * (missing skills root, unreadable manifest) is swallowed because
 * the drift check is advisory, not load-bearing.
 */
async function emitSkillDriftHint(
  packDir: string,
  language: PackLanguage,
  syncCommand: string,
): Promise<void> {
  const skillsRoot = defaultSdkSkillsRoot();
  if (skillsRoot === undefined) return;
  try {
    const drift = await detectSkillDrift({ skillsRoot, targetDir: packDir, language });
    const total = drift.missing.length + drift.outdated.length;
    if (total === 0) return;
    const parts: string[] = [];
    if (drift.outdated.length > 0) parts.push(`${drift.outdated.length} out of date`);
    if (drift.missing.length > 0) parts.push(`${drift.missing.length} not yet installed`);
    emitProgress(`  ⚠ Framework skills: ${parts.join(', ')}.`);
    emitProgress(`    Run \`${syncCommand}\` to pull the latest.`);
    emitProgress('');
  } catch {
    // Advisory; never block boot on a drift-check failure.
  }
}

/**
 * How this pack's code runs (`dev/pack-code.ts`). For a Python pack, the
 * interpreter is resolved and checked — with the pack's own environment —
 * before anything boots.
 */
async function resolveDevPackCode(
  dev: DevRunners,
  language: PackLanguage,
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
  packEnv: () => Promise<Readonly<Record<string, string>>>,
): Promise<
  { readonly kind: 'ok'; readonly value: PackCode } | (CommandResult & { readonly kind: 'error' })
> {
  const resolved = await resolvePackCode(language, packDir, config);
  if (resolved.kind === 'err') {
    return { kind: 'error', stderr: `kindgi dev: ${resolved.message}\n`, exitCode: 1 };
  }
  if (resolved.value.language === 'python') {
    const checked = await dev.checkPackPython(resolved.value.python, await packEnv(), packDir);
    if (checked.kind === 'err') {
      return { kind: 'error', stderr: `kindgi dev: ${checked.message}\n`, exitCode: 1 };
    }
    emitProgress(`✓ pack code: ${checked.value}`);
  }
  return { kind: 'ok', value: resolved.value };
}

function getEnv(ctx: CommandContext, key: string): string | undefined {
  // `ctx.env` is the only source: the `kindgi` binary passes
  // `process.env` (src/cli.ts), tests pass an explicit record. No
  // per-key fallback to `process.env` — that made "variable unset"
  // untestable whenever the host shell (or CI) exported it.
  return ctx.env[key];
}

/** A registered provider, as the banner names it. */
export interface BannerProvider {
  readonly id: string;
  readonly models: readonly { readonly name: string }[];
  readonly fallback?: boolean;
}

/** Every provider of the tenant, all pages. */
async function listProviders(client: KindgiClient): Promise<readonly Provider[]> {
  const providers: Provider[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.providers.list({
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    providers.push(...page.data);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return providers;
}

/**
 * The tenant's providers for the banner; `undefined` when they can't be
 * listed (the banner then leaves the line out).
 */
async function registeredProviders(
  client: KindgiClient,
): Promise<readonly BannerProvider[] | undefined> {
  try {
    return (await listProviders(client)) as readonly BannerProvider[];
  } catch {
    return undefined;
  }
}

/**
 * Bring the runtime's providers in step with the ones the config
 * declares (`dev/providers.ts`). Never fails the boot: what couldn't be
 * done is one line each.
 */
async function applyDeclaredProviders(inputs: {
  readonly client: KindgiClient;
  readonly packDir: string;
  /** The runtime and tenant (`devProvidersKey`). */
  readonly key: string;
  readonly declared: readonly DeclaredProvider[];
  readonly file: string;
  readonly kindgi: (...args: string[]) => string;
  readonly secretNames: ReadonlySet<string>;
  readonly envFiles: string;
}): Promise<void> {
  const recordPath = devProvidersRecordPath(inputs.packDir);
  const owned = await readOwnedProviders(recordPath, inputs.key);
  if (inputs.declared.length === 0 && Object.keys(owned).length === 0) return;
  const { client } = inputs;
  let result: Awaited<ReturnType<typeof reconcileProviders>>;
  try {
    result = await reconcileProviders({
      declared: inputs.declared,
      owned,
      client: {
        list: () => listProviders(client),
        register: (input) => client.providers.register(input),
        unregister: (id) => client.providers.unregister(id),
      },
      hasSecret: (name) => inputs.secretNames.has(name),
    });
  } catch (err) {
    emitProgress(
      `⚠ Providers from ${inputs.file}: not applied; the runtime's providers could not be listed: ${(err as Error).message}`,
    );
    return;
  }
  for (const line of describeReconcile(result.outcomes, inputs)) emitProgress(line);
  try {
    await writeOwnedProviders(recordPath, inputs.key, result.owned);
  } catch (err) {
    emitProgress(
      `  ⚠ could not write ${join('.kindgi', 'dev', 'providers.json')}: ${(err as Error).message}. The next boot leaves the providers registered now as they are.`,
    );
  }
}

interface DevBannerInputs {
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly token: string;
  /** The tenant's model providers; `undefined` leaves the line out. */
  readonly providers?: readonly BannerProvider[] | undefined;
  /** How to register a real model, in this pack's `kindgi`. */
  readonly registerProviderCommand: string;
  readonly packDir: string;
  readonly bootIndex: IndexResult;
  readonly bootReport: RegistrationReport;
  /**
   * Names of services auto-started by `kindgi dev` (postgres, openfga,
   * minio). Absent when the caller supplied their own KINDGI_DATABASE_URL.
   */
  readonly autoStartedServices?: readonly string[];
  /** Where primitives go (discovery roots) — named when the pack is still empty. */
  readonly discoveryRoots?: readonly string[];
  /** `KINDGI_CORS_ORIGINS`: browser origins allowed to follow runs. Absent: the line is left out. */
  readonly corsOrigins?: readonly string[];
}

/** The browser origins line: who may follow runs with public run tokens (`KINDGI_CORS_ORIGINS`). */
function describeBrowserOrigins(origins: readonly string[]): string {
  return origins.length > 0
    ? `${origins.join(', ')} (browsers may follow runs with public run tokens)`
    : 'none (set KINDGI_CORS_ORIGINS so a browser app can follow runs)';
}

/**
 * The banner's providers line: each provider with its models, fallbacks
 * marked; when only fallbacks (or nothing) can answer, how to register a
 * real model.
 */
function describeProviders(
  providers: readonly BannerProvider[],
  registerProviderCommand: string,
): string {
  if (providers.length === 0) {
    return `none — agent turns fail until one is registered: ${registerProviderCommand}`;
  }
  const named = providers
    .map((p) =>
      p.fallback === true
        ? `${p.id} (fallback)`
        : `${p.id} (${p.models.map((m) => m.name).join(', ')})`,
    )
    .join(' · ');
  if (providers.some((p) => p.fallback !== true)) return named;
  return `${named} — canned replies; for a real model: ${registerProviderCommand}`;
}

/** The banner `kindgi dev --no-watch` prints to stderr when it exits. */
export function renderDevBanner(inputs: DevBannerInputs): readonly string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    '  Starting Kindgi locally (dev: the runtime in a container, your code on this machine)',
  );
  lines.push(`    API server         ${inputs.baseUrl}`);
  lines.push(`    Tenant             ${inputs.tenantId}`);
  lines.push(`    Bearer token       ${inputs.token}`);
  lines.push(`    Pack dir           ${inputs.packDir}`);
  if (inputs.providers !== undefined) {
    lines.push(
      `    Providers          ${describeProviders(inputs.providers, inputs.registerProviderCommand)}`,
    );
  }
  if (inputs.autoStartedServices !== undefined && inputs.autoStartedServices.length > 0) {
    lines.push(
      `    Auto-started       ${inputs.autoStartedServices.join(', ')} (docker, shared by every kindgi dev; left running)`,
    );
  }
  if (inputs.corsOrigins !== undefined) {
    lines.push(`    Browser origins    ${describeBrowserOrigins(inputs.corsOrigins)}`);
  }
  lines.push('');
  lines.push(...renderIndexSection(inputs));
  lines.push('');
  lines.push('  --no-watch: single boot + register cycle complete.');
  return lines;
}

/** The "what got indexed" part of the banner: counts + failures, an empty pack, or the indexer error. */
function renderIndexSection(
  inputs: Pick<DevBannerInputs, 'bootIndex' | 'bootReport' | 'discoveryRoots'>,
): string[] {
  const index = inputs.bootIndex;
  if (index.kind === 'ok') {
    const c = index.counts;
    const lines = [
      `  Discovering pack (${index.packId}@${index.packVersion})`,
      `    ✓ ${c.tools} tools    ✓ ${c.guardrails} guardrails    ✓ ${c.agents} agents    ✓ ${c.flows} flows`,
    ];
    if (inputs.bootReport.failed.length > 0) {
      lines.push('', '  Registration failures:');
      for (const f of inputs.bootReport.failed) {
        lines.push(`    ✗ ${f.kind} ${f.id} — ${f.message ?? 'unknown error'}`);
      }
    }
    return lines;
  }
  if (index.code === 'discovery-empty') {
    const where = (inputs.discoveryRoots ?? []).map((r) => `${r === '' ? '.' : r}/`).join(', ');
    return [
      `  No primitives yet — add a tool or agent${where === '' ? '' : ` under ${where}`}; it registers on save.`,
    ];
  }
  return [
    `  Indexer failed: [${index.code}] ${index.message}`,
    ...(index.filePath !== undefined ? [`    at ${index.filePath}`] : []),
    '  Fix the pack source; kindgi dev keeps the server up regardless.',
  ];
}

/** The refresh found no primitive files: an empty pack, which is not an error. */
function isEmptyPack(outcome: IndexResult): boolean {
  return outcome.kind === 'err' && outcome.code === 'discovery-empty';
}

function summariseOutcome(
  outcome: IndexResult,
  report: RegistrationReport,
): Record<string, unknown> {
  if (isEmptyPack(outcome)) {
    return {
      ok: true,
      empty: true,
      counts: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
      registered: 0,
      failed: [],
    };
  }
  if (outcome.kind === 'err') {
    return {
      ok: false,
      indexerError: {
        code: outcome.code,
        message: outcome.message,
        ...(outcome.filePath !== undefined && { filePath: outcome.filePath }),
      },
    };
  }
  return {
    ok: true,
    packId: outcome.packId,
    packVersion: outcome.packVersion,
    counts: outcome.counts,
    registered: report.registered.length,
    failed: report.failed.map((f) => ({ kind: f.kind, id: f.id, message: f.message ?? null })),
  };
}

function emptyReport(): RegistrationReport {
  return { registered: [], failed: [] };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: wait forever when no signal
  if (signal === undefined) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    signal.addEventListener('abort', () => resolvePromise(), { once: true });
  });
}

/** A dev token in the runtime's own format: `kgi_bt_` and 32 random bytes, URL-safe base64. */
function generateDevToken(): string {
  return `kgi_bt_${randomBytes(32).toString('base64url')}`;
}
